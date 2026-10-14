import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type OverlayHandle } from "@earendil-works/pi-tui";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { linkedRoot, readSnapshot, display, shellQuote, editorArgs, fileTarget, type Snapshot } from "./core.ts";

import { WorktreePanel } from "./panel.ts";

const KEY = "worktree-panel-preview";
type PanelSession = {
  closed: boolean;
  done?: () => void;
  handle?: OverlayHandle;
  component?: WorktreePanel;
  requestRender?: () => void;
};

export default function worktreePanel(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let preview: string | undefined;
  let signature = "";
  let epoch = 0;
  let busy = false;
  let pending = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastError = "";
  let overlay: PanelSession | undefined;
  let panelHidden = false;
  let panelWidth = 44;
  const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

  function clear() {
    signature = "";
    context?.ui.setWidget(KEY, undefined); // Remove the old prototype's widget, if present.
    const previous = overlay;
    overlay = undefined;
    if (previous) {
      previous.closed = true;
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
      let availableRows = 20;
      const ctx = context!;
      void ctx.ui.custom<void>((tui, theme, _keys, done) => {
        session.done = () => done();
        session.requestRender = () => tui.requestRender();
        const component = new WorktreePanel(next, Boolean(preview), theme,
          { truncate: truncateToWidth, measure: visibleWidth }, () => availableRows);
        session.component = component;
        return component;
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          get width() { return panelWidth; },
          maxHeight: "70%",
          margin: { top: 1, right: 1, bottom: 8 },
          nonCapturing: true,
          visible: (width, height) => {
            availableRows = Math.max(9, Math.floor(height * 0.7));
            return width >= Math.max(110, panelWidth + 64) && height >= 16;
          },
        },
        onHandle: handle => {
          session.handle = handle;
          if (session.closed) session.done?.();
          else handle.setHidden(panelHidden);
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
      // Poll ONLY while displaying a linked worktree; repaint ONLY on changes.
      poll = setInterval(() => schedule(0), 3000);
      poll.unref();
    }
  }

  async function refresh() {
    if (!context || !interactive(context)) return;
    if (busy) { pending = true; return; }
    busy = true;
    const token = epoch;
    const ctx = context;
    try {
      const root = await linkedRoot(preview ?? ctx.cwd);
      if (token !== epoch) return;
      if (!root) { clear(); return; }
      const next = await readSnapshot(root);
      if (token !== epoch) return;
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

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (!interactive(ctx)) return;
    context = ctx;
    schedule(0);
  });
  pi.on("session_shutdown", stop);
  pi.on("tool_execution_end", () => schedule());
  pi.on("agent_end", () => schedule());

  pi.registerCommand("worktree-open", {
    description: "Choose a changed worktree file and open $EDITOR in a Herdr tab or Alacritty window",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return;
      // Fetch fresh data even if a debounced/background refresh is in flight.
      const root = await linkedRoot(preview ?? ctx.cwd);
      if (!root) { ctx.ui.notify("Not in a linked Git worktree", "info"); return; }
      try {
        const current = await readSnapshot(root);
        const files = current.files.filter(f => f.status !== " D" && f.status !== "D " && f.status !== "DD");
        if (!files.length) { ctx.ui.notify("No changed files available to open", "info"); return; }
        const labels = files.map((f, i) => `${i + 1}. ${f.status} ${display(f.path)}`);
        const picked = await ctx.ui.select("Open changed file in $EDITOR", labels);
        if (!picked) return;
        await openFile(root, files[labels.indexOf(picked)].path);
      } catch (error) { ctx.ui.notify(`Cannot open file: ${String(error)}`, "error"); }
    },
  });
  pi.registerCommand("worktree-panel", {
    description: "Worktree overlay: show, hide, next, prev, or width 30–80",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      const action = args.trim();
      if (action === "show" || action === "hide") {
        panelHidden = action === "hide";
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
        ctx.ui.notify("/worktree-panel show|hide|next|prev|width 44 · hides below 110 columns", "info");
      }
    },
  });
  pi.registerCommand("worktree-refresh", {
    description: "Refresh the worktree changed-files panel",
    handler: async (_args, ctx) => { if (interactive(ctx)) schedule(0); },
  });
  pi.registerCommand("worktree-preview", {
    description: "Temporary testing: show a linked worktree by absolute path; 'off' restores session cwd",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      const path = args.trim();
      if (!path) { ctx.ui.notify("Usage: /worktree-preview /absolute/path or /worktree-preview off", "info"); return; }
      if (path !== "off" && !await linkedRoot(resolve(ctx.cwd, path))) {
        ctx.ui.notify("That path is not inside a linked Git worktree", "warning"); return;
      }
      epoch++;
      preview = path === "off" ? undefined : resolve(ctx.cwd, path);
      context = ctx;
      clear();
      schedule(0);
    },
  });
}
