import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type OverlayHandle } from "@earendil-works/pi-tui";
import { Type } from "@earendil-works/pi-ai";
import { basename, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { checkoutRoot, linkedRoot, readSnapshot, readDiff, branchTarget, readBranchSnapshot, display, shellQuote, editorArgs, fileTarget, type Snapshot, type DiffSource } from "./core.ts";

import { WorktreePanel } from "./panel.ts";
import { DiffViewer } from "./diff.ts";
import { restorePanelTarget, TARGET_ENTRY } from "./target.ts";

const KEY = "worktree-panel-preview";
type PanelSession = {
  closed: boolean;
  focusRequested?: boolean;
  actionBusy?: boolean;
  closeDiff?: () => void;
  done?: () => void;
  handle?: OverlayHandle;
  component?: WorktreePanel;
  requestRender?: () => void;
};

export default function worktreePanel(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let preview: string | undefined;
  let previewBranch: string | undefined;
  let previewBase: string | undefined;

  async function snapshot(cwd: string): Promise<Snapshot | undefined> {
    if (previewBranch) return readBranchSnapshot(preview ?? cwd, previewBranch, previewBase);
    const root = preview ? await checkoutRoot(preview) : await linkedRoot(cwd);
    return root ? readSnapshot(root, previewBase) : undefined;
  }
  let signature = "";
  let epoch = 0;
  let busy = false;
  let pending = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastError = "";
  let overlay: PanelSession | undefined;
  let panelHidden = false;
  let panelWidth = 64;
  const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

  function clear() {
    signature = "";
    context?.ui.setWidget(KEY, undefined); // Remove the old prototype's widget, if present.
    const previous = overlay;
    overlay = undefined;
    if (previous) {
      previous.closed = true;
      previous.closeDiff?.();
      previous.done?.(); // Finish ctx.ui.custom; never remove its overlay via handle.hide().
    }
    if (poll) clearInterval(poll);
    poll = undefined;
  }

  function paint(next: Snapshot) {
    const nextSignature = JSON.stringify([preview, next]);
    if (nextSignature === signature && overlay) return;
    signature = nextSignature;
    if (overlay) {
      overlay.component?.update(next, Boolean(preview));
      overlay.requestRender?.();
    } else {
      const session: PanelSession = { closed: false };
      overlay = session;
      let availableRows = 8;
      const ctx = context!;
      void ctx.ui.custom<void>((tui, theme, _keys, done) => {
        session.done = () => done();
        session.requestRender = () => tui.requestRender();
        const component = new WorktreePanel(next, Boolean(preview), theme,
          { truncate: truncateToWidth, measure: visibleWidth }, () => availableRows, {
            diff: (root, file, source) => { void panelAction(session, () => showDiff(session, ctx, root, file, source)); },
            edit: (root, file) => { void panelAction(session, () => openFile(root, file.path)); },
            close: () => releaseFocus(session),
            render: () => tui.requestRender(),
          });
        session.component = component;
        return component;
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          get width() { return panelWidth; },
          get maxHeight() { return Math.max(1, availableRows); },
          margin: { top: 1, right: 1, bottom: 8 },
          nonCapturing: true,
          visible: (width, height) => {
            availableRows = Math.floor(height / 3);
            const minimum = session.focusRequested ? panelWidth + 2 : Math.max(110, panelWidth + 64);
            return width >= minimum && availableRows >= 8;
          },
        },
        onHandle: handle => {
          session.handle = handle;
          if (session.closed) session.done?.();
          else {
            handle.setHidden(panelHidden);
            if (session.focusRequested) {
              session.component?.setActive(true);
              handle.focus();
            }
          }
        },
      }).then(() => {
        if (overlay === session) overlay = undefined;
      }).catch(error => {
        if (overlay !== session) return;
        overlay = undefined;
        signature = "";
        ctx.ui.notify(`Worktree overlay: ${String(error)}`, "warning");
      });
    }
    if (!poll) {
      // External edits are detected without filesystem watchers or render-time Git.
      // Poll only while displaying a target; repaint only on changes.
      poll = setInterval(() => schedule(0), 3000);
      poll.unref();
    }
  }

  function releaseFocus(session: PanelSession) {
    session.focusRequested = false;
    session.component?.setActive(false);
    session.handle?.unfocus();
    session.requestRender?.();
  }

  async function panelAction(session: PanelSession, action: () => Promise<void>) {
    if (session.actionBusy || session.closed) return;
    session.actionBusy = true;
    try { await action(); }
    catch (error) { context?.ui.notify(`Worktree panel: ${String(error)}`, "error"); }
    finally {
      session.actionBusy = false;
      if (overlay === session && session.focusRequested && !panelHidden) session.handle?.focus();
      session.requestRender?.();
    }
  }

  async function showDiff(session: PanelSession, ctx: ExtensionContext, root: string, file: Snapshot["files"][number], source: DiffSource) {
    const text = await readDiff(root, file, source);
    if (session.closed) return;
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        session.closeDiff = () => done();
        if (session.closed) done();
        const title = `${source.kind === "committed" ? `Committed vs ${source.ref}` : "Uncommitted"} · ${file.path}`;
        return new DiffViewer(title, text, theme,
          () => Math.max(6, tui.terminal.rows - 2),
          () => tui.requestRender(), () => done(), file.path);
      }, {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
      });
    } finally { session.closeDiff = undefined; }
  }

  async function focusPanel(ctx: ExtensionContext) {
    if (!interactive(ctx)) return;
    try {
      const token = epoch;
      const data = await snapshot(ctx.cwd);
      if (!data) {
        ctx.ui.notify(preview
          ? `Worktree target is unavailable: ${display(preview)}. Set or clear it with worktree_panel_target.`
          : "No worktree target selected, and Pi's cwd is not a linked worktree. Set the target with worktree_panel_target.", "info");
        return;
      }
      if (token !== epoch) return;
      context = ctx;
      panelHidden = false;
      paint(data);
      const session = overlay;
      if (!session) return;
      session.focusRequested = true;
      session.component?.setActive(true);
      session.handle?.setHidden(false);
      session.handle?.focus();
      session.requestRender?.();
    } catch (error) { ctx.ui.notify(`Cannot open worktree panel: ${String(error)}`, "error"); }
  }

  async function refresh() {
    if (!context || !interactive(context)) return;
    if (busy) { pending = true; return; }
    busy = true;
    const token = epoch;
    const ctx = context;
    try {
      const next = await snapshot(ctx.cwd);
      if (token !== epoch) return;
      if (!next) { clear(); return; }
      lastError = "";
      paint(next);
    } catch (error) {
      if (token !== epoch) return;
      clear();
      const message = String(error);
      if (lastError !== message) ctx.ui.notify(`Worktree panel: ${message}`, "warning");
      lastError = message;
    } finally {
      busy = false;
      if (pending) { pending = false; schedule(0); }
    }
  }

  function schedule(delay = 200) {
    if (!context) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = undefined; void refresh(); }, delay);
    debounce.unref();
  }

  function stop() {
    epoch++;
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    pending = false;
    clear();
    context = undefined;
  }

  async function openFile(root: string, path: string) {
    const editor = editorArgs(process.env.EDITOR || process.env.VISUAL || "");
    const file = fileTarget(root, path);
    await stat(file); // Deleted files cannot be opened; don't accidentally recreate them.
    if (process.env.HERDR_ENV === "1") {
      const workspace = process.env.HERDR_WORKSPACE_ID;
      if (!workspace || !process.env.HERDR_SOCKET_PATH) throw new Error("Herdr context is incomplete");
      const created = await pi.exec("herdr", ["tab", "create", "--workspace", workspace, "--cwd", root,
        "--label", `edit: ${display(basename(path))}`, "--no-focus"], { timeout: 10000 });
      if (created.code !== 0) throw new Error(created.stderr || created.stdout);
      const reply = JSON.parse(created.stdout);
      const pane = reply.result?.root_pane?.pane_id;
      const tab = reply.result?.tab?.tab_id;
      if (!pane || !tab) throw new Error("Herdr returned no new pane/tab ID");
      // Quote each token, including filenames. Never paste untrusted shell text.
      const command = [...editor, file].map(shellQuote).join(" ");
      const run = await pi.exec("herdr", ["pane", "run", pane, command], { timeout: 10000 });
      if (run.code !== 0) throw new Error(`Editor tab ${tab} created, but launch failed: ${run.stderr || run.stdout}`);
      const focus = await pi.exec("herdr", ["tab", "focus", tab], { timeout: 10000 });
      if (focus.code !== 0) throw new Error(`Editor started in ${tab}, but focus failed: ${focus.stderr || focus.stdout}`);
    } else {
      await new Promise<void>((accept, reject) => {
        const child = spawn("alacritty", ["--working-directory", root, "-e", ...editor, file],
          { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); accept(); });
      });
    }
  }

  function restoreSession(ctx: ExtensionContext) {
    stop();
    const saved = restorePanelTarget(ctx.sessionManager.getBranch());
    preview = saved?.path;
    previewBranch = saved?.branch;
    previewBase = saved?.base;
    if (!interactive(ctx)) return;
    context = ctx;
    schedule(0);
  }

  pi.on("session_start", (_event, ctx) => restoreSession(ctx));
  pi.on("session_tree", (_event, ctx) => restoreSession(ctx));
  pi.on("session_shutdown", stop);
  pi.on("tool_execution_end", () => schedule());
  pi.on("agent_end", () => schedule());

  pi.registerTool({
    name: "worktree_panel_target",
    label: "Worktree panel target",
    description: "Point the panel at any Git checkout (main or linked) for committed and uncommitted changes, or set branch plus an absolute repository path for read-only committed diffs of a branch, tag, custom ref, or commit revision without a worktree. Set base to choose the committed comparison base independently; omit it for automatic develop/master selection. Without branch, uncommitted changes stay visible. Clear with path: null. Does NOT change Pi's cwd or tool paths. Saved per session branch across reload/restart.",
    parameters: Type.Object({
      path: Type.Union([Type.String({ description: "Absolute Git checkout path (main or linked), or repository path when branch is supplied" }), Type.Null()]),
      branch: Type.Optional(Type.String({ minLength: 1, description: "Branch, tag, custom ref, or commit revision (e.g. feature/foo, v3, refs/releases/v3, HEAD~1); read-only, no worktree needed" })),
      base: Type.Optional(Type.String({ minLength: 1, description: "Comparison base ref or commit (e.g. v3). Only affects committed changes (merge base to target HEAD); omit for automatic develop/master. Does not select a different checkout or hide uncommitted changes." })),
    }),
    async execute(_id, { path, branch, base }, _signal, _onUpdate, ctx) {
      if (path !== null && !isAbsolute(path)) throw new Error("Worktree path must be absolute");
      if (branch !== undefined && (path === null || !branch)) throw new Error("Ref requires a repository path and a nonempty name");
      const target = branch !== undefined && path !== null ? await branchTarget(path, branch) : undefined;
      const root = target?.root ?? (path === null ? undefined : await checkoutRoot(path));
      if (path !== null && !root) throw new Error("That path is not inside a Git checkout");
      if (base !== undefined && (!root || !base)) throw new Error("Base requires a repository path and a nonempty ref");
      const comparisonBase = base !== undefined ? (await branchTarget(root!, base)).branch : undefined;
      pi.appendEntry(TARGET_ENTRY, { path: root ?? null, ...(target ? { branch: target.branch } : {}), ...(comparisonBase ? { base: comparisonBase } : {}) });
      epoch++;
      preview = root;
      previewBranch = target?.branch;
      previewBase = comparisonBase;
      clear();
      context = interactive(ctx) ? ctx : undefined;
      schedule(0);
      return {
        content: [{ type: "text", text: root
          ? `Panel target: ${root}${target ? ` · ${target.branch} (read-only)` : ""}${comparisonBase ? ` · base ${comparisonBase}` : ""}. Cwd unchanged.`
          : "Panel target reset to session cwd. Cwd unchanged." }],
        details: { path: root ?? null, ...(target ? { branch: target.branch } : {}), ...(comparisonBase ? { base: comparisonBase } : {}), cwdChanged: false, panelAvailable: interactive(ctx) },
      };
    },
  });

  pi.registerShortcut("alt+w", {
    description: "Focus/unfocus the worktree panel",
    handler: async ctx => {
      if (!interactive(ctx)) return;
      if (overlay?.focusRequested) releaseFocus(overlay);
      else await focusPanel(ctx);
    },
  });

  pi.registerCommand("worktree-open", {
    description: "Focus committed branch changes and uncommitted files: Enter for diff, e for editor",
    handler: async (_args, ctx) => { await focusPanel(ctx); },
  });
  pi.registerCommand("worktree-panel", {
    description: "Focus worktree files, or show, hide, next, prev, width 30–80",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      const action = args.trim();
      if (!action) { await focusPanel(ctx); return; }
      if (action === "show" || action === "hide") {
        panelHidden = action === "hide";
        if (panelHidden && overlay) releaseFocus(overlay);
        overlay?.handle?.setHidden(panelHidden);
        schedule(0);
      } else if (action === "next" || action === "prev") {
        overlay?.component?.movePage(action === "next" ? 1 : -1);
        overlay?.requestRender?.();
      } else if (/^width\s+\d+$/.test(action)) {
        const width = Number(action.split(/\s+/)[1]);
        if (width < 30 || width > 80) { ctx.ui.notify("Width must be 30–80 columns", "warning"); return; }
        panelWidth = width;
        overlay?.component?.invalidate();
        overlay?.requestRender?.();
      } else {
        ctx.ui.notify("/worktree-panel show|hide|next|prev|width 64 · requires width + 64 terminal columns", "info");
      }
    },
  });
  pi.registerCommand("worktree-refresh", {
    description: "Refresh the worktree changed-files panel",
    handler: async (_args, ctx) => { if (interactive(ctx)) schedule(0); },
  });
  pi.registerCommand("worktree-branch", {
    description: "Show read-only committed diffs for a branch, tag, custom ref, or commit revision; off clears target",
    handler: async (args, ctx) => {
      const branch = args.trim();
      if (!branch) { ctx.ui.notify("Usage: /worktree-branch <branch, tag, ref, or commit revision>, or off", "info"); return; }
      try {
        const target = branch === "off" ? undefined : await branchTarget(ctx.cwd, branch);
        pi.appendEntry(TARGET_ENTRY, { path: target?.root ?? null, ...(target ? { branch: target.branch } : {}) });
        epoch++;
        preview = target?.root;
        previewBranch = target?.branch;
        previewBase = undefined;
        clear();
        context = interactive(ctx) ? ctx : undefined;
        schedule(0);
      } catch (error) { ctx.ui.notify(`Cannot select ref: ${String(error)}`, "warning"); }
    },
  });
  pi.registerCommand("worktree-base", {
    description: "Set the committed comparison base without changing the target; auto restores develop/master selection",
    handler: async (args, ctx) => {
      const base = args.trim();
      if (!base) { ctx.ui.notify("Usage: /worktree-base <ref or commit revision>, or auto", "info"); return; }
      try {
        const root = await checkoutRoot(preview ?? ctx.cwd);
        if (!root) throw new Error("Selected path is not inside a Git checkout");
        const comparisonBase = base === "auto" ? undefined : (await branchTarget(root, base)).branch;
        pi.appendEntry(TARGET_ENTRY, { path: root, ...(previewBranch ? { branch: previewBranch } : {}), ...(comparisonBase ? { base: comparisonBase } : {}) });
        epoch++;
        preview = root;
        previewBase = comparisonBase;
        clear();
        context = interactive(ctx) ? ctx : undefined;
        schedule(0);
      } catch (error) { ctx.ui.notify(`Cannot select comparison base: ${String(error)}`, "warning"); }
    },
  });
  pi.registerCommand("worktree-preview", {
    description: "Set the saved panel checkout (main or linked) by path; 'off' restores session cwd",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      const path = args.trim();
      if (!path) { ctx.ui.notify("Usage: /worktree-preview /absolute/path or /worktree-preview off", "info"); return; }
      const root = path === "off" ? undefined : await checkoutRoot(resolve(ctx.cwd, path));
      if (path !== "off" && !root) {
        ctx.ui.notify("That path is not inside a Git checkout", "warning"); return;
      }
      pi.appendEntry(TARGET_ENTRY, { path: root ?? null });
      epoch++;
      preview = root;
      previewBranch = undefined;
      previewBase = undefined;
      context = ctx;
      clear();
      schedule(0);
    },
  });
}
