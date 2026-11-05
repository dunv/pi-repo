import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { MouseRegion, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { WIDGET, widgetLines } from "./widget.ts";
import { noticeText } from "./notice.ts";
import { logPresentation } from "./log-presentation.ts";
import { commandPreview, displayLiteral, displayState, statusLabel, submission, submissionDetails, submissionFor } from "./presentation.ts";
import { watch, type FSWatcher } from "node:fs";
import { Backend, configuration, command, privateDirectory, sliceLog } from "./backend.ts";
import { ENTRY, NOTICE, RECEIPT, completionNoticed, filterViews, intent, jobs, matching, noticed, reservation, sessionGroup, terminal, trackedViews, view, type Job, type JobView, type Owner } from "./state.ts";

// Static policy belongs in tool declarations, not repeated beside every row/result.
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
type Active = { ctx: ExtensionContext; backend: Backend; owner: Owner; watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout>; safetyTimer?: ReturnType<typeof setTimeout>; busy: boolean; dirty: boolean; closed: boolean; expanded: boolean; rows: JobView[]; unavailable: boolean };

/** Backend and safety interval injection support local deterministic tests. */
export function extension(pi: ExtensionAPI, makeBackend = (c: ConstructorParameters<typeof Backend>[0]) => new Backend(c), safetyIntervalMs = 60_000) {
  let active: Active | undefined;
  pi.registerMessageRenderer(NOTICE, (message, options, theme) => {
    let expanded = options.expanded;
    const state = displayState(message.content);
    const component = {
      render(width: number) {
        const input = active && current(active) ? submissionFor(active.ctx.sessionManager.getBranch(), state.nonce) : undefined;
        const [heading, ...details] = noticeText(message.content, expanded, input).split("\n");
        const label = statusLabel(state);
        // Custom messages have no host-provided tool shell. Match its themed
        // background and vertical padding here rather than rendering bare text.
        const background = state.phase === "EXITED" ? (state.exitCode === 0 ? "toolSuccessBg" : "toolErrorBg")
          : state.phase === "KILLED" ? "toolErrorBg" : "toolPendingBg";
        const text = theme.fg(label.ink, expanded ? "▾ " : "▸ ") + theme.bold(theme.fg("toolTitle", heading))
          + (details.length ? `\n${theme.fg("muted", details.join("\n"))}` : "");
        return new Text(text, options.outputPad, 1, line => theme.bg(background, line)).render(width);
      },
      invalidate() {},
    };
    return new MouseRegion(component, event => {
      if (event.type !== "click" || event.button !== "left" || event.y !== 1) return;
      expanded = !expanded;
      return { handled: true, render: true };
    });
  });
  function stop() {
    if (!active) return;
    if (active.ctx.mode === "tui") active.ctx.ui.setWidget(WIDGET, undefined);
    active.closed = true;
    active.watcher?.close();
    if (active.timer) clearTimeout(active.timer);
    if (active.safetyTimer) clearTimeout(active.safetyTimer);
    active = undefined; // No task signal, process kill, cleanup or daemon maintenance.
  }
  function current(a: Active) {
    return active === a && !a.closed && a.ctx.sessionManager.getSessionId() === a.owner.session
      && a.ctx.sessionManager.getSessionFile() === a.owner.file;
  }
  function owned(a: Active) { return jobs(a.ctx.sessionManager.getBranch(), a.owner, a.backend.config.namespace); }
  function bound(a: Active, j: Job) { return current(a) && owned(a).some(v => v.nonce === j.nonce); }
  function requireActive(ctx: ExtensionContext) {
    const a = active;
    if (!a || !current(a) || ctx.sessionManager.getSessionId() !== a.owner.session
      || ctx.sessionManager.getSessionFile() !== a.owner.file) throw new Error("Pueue is unconfigured or this session is no longer active");
    return a;
  }
  function updateWidget(a: Active, rows: JobView[], unavailable = false) {
    if (!current(a)) return;
    a.rows = rows;
    a.unavailable = unavailable;
    armSafety(a);
    if (a.ctx.mode !== "tui") return;
    const lines = widgetLines(rows, a.expanded, unavailable);
    a.ctx.ui.setWidget(WIDGET, lines ? (_tui, theme) => ({
      render: (width: number) => lines.map(line => truncateToWidth(theme.fg("muted", line), width)),
      invalidate() {},
    }) : undefined, { placement: "aboveEditor" });
  }
  function unavailable(a: Active) {
    // Retain only the current list: a query failure must not resurrect cleaned history.
    updateWidget(a, a.rows.map(row => terminal(row.phase) ? row : {
      ...row, phase: row.phase === "ADMISSION_UNKNOWN" ? row.phase : "UNKNOWN",
    }), true);
  }
  function armSafety(a: Active) {
    if (!current(a)) return;
    if (!a.rows.some(row => !terminal(row.phase))) {
      if (a.safetyTimer) clearTimeout(a.safetyTimer);
      a.safetyTimer = undefined;
      return;
    }
    if (a.safetyTimer) return;
    a.safetyTimer = setTimeout(() => {
      a.safetyTimer = undefined;
      void reconcile(a, true);
    }, safetyIntervalMs);
    a.safetyTimer.unref();
  }
  async function reconcile(a: Active, quiet = false) {
    if (!current(a)) return;
    if (a.busy) { a.dirty = true; return; }
    a.busy = true;
    try {
      const ownedJobs = owned(a);
      if (!ownedJobs.length) { updateWidget(a, []); return; }
      const tasks = await a.backend.tasks();
      if (!current(a)) return;
      updateWidget(a, trackedViews(owned(a), tasks));
      for (const j of ownedJobs) {
        if (!bound(a, j)) return;
        if (!matching(j, tasks)) continue; // Backend cleanup is not an UNKNOWN/completion notice.
        const state = view(j, tasks);
        if (!["EXITED", "KILLED", "UNKNOWN", "ADMISSION_UNKNOWN"].includes(state.phase)) continue;
        // Preserve v1 keys across compact-payload upgrades; omission still means false.
        const key = `${j.nonce}:${state.phase}:${state.exitCode ?? "none"}:${!!state.cancellationRequested}`;
        if (noticed(a.ctx.sessionManager.getBranch(), key)) continue;
        const triggerTurn = state.phase === "EXITED" && !completionNoticed(a.ctx.sessionManager.getBranch(), j.nonce);
        // sendMessage is void and may queue delivery behind startup/streaming.
        // Persist BEFORE asking Pi to run: a message is not a synchronous receipt.
        pi.appendEntry(RECEIPT, { key });
        if (!bound(a, j)) return;
        pi.sendMessage({ customType: NOTICE, content: JSON.stringify(state),
          display: true, details: { key } }, { deliverAs: "followUp", triggerTurn });
      }
    } catch {
      // Safety queries never spam UI warnings. Uncertainty remains visible;
      // querying again is not workload retry or admission/takeover authority.
      if (current(a)) unavailable(a);
      if (!quiet && current(a) && a.ctx.hasUI) a.ctx.ui.notify("Pueue reconciliation unavailable; state remains UNKNOWN. Use pueue_status or resume later.", "warning");
    } finally {
      a.busy = false;
      armSafety(a);
      if (a.dirty && current(a)) { a.dirty = false; schedule(a); }
    }
  }
  function schedule(a: Active) {
    if (!current(a) || a.timer) return;
    a.timer = setTimeout(() => { a.timer = undefined; void reconcile(a); }, 100);
    a.timer.unref();
  }
  async function start(ctx: ExtensionContext) {
    const expanded = active?.owner.session === ctx.sessionManager.getSessionId()
      && active?.owner.file === ctx.sessionManager.getSessionFile() ? active.expanded : true;
    stop();
    const c = configuration(process.env);
    if (!c) return;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Pueue requires a persistent Pi session");
    const a: Active = { ctx, backend: makeBackend(c), owner: { session: ctx.sessionManager.getSessionId(), file,
      anchor: ctx.sessionManager.getLeafId() }, busy: false, dirty: false, closed: false, expanded, rows: [], unavailable: false };
    active = a;
    updateWidget(a, owned(a).map(j => view(j, [])));
    try {
      await a.backend.check();
      if (!current(a)) return;
      if (c.hints) {
        try {
          await privateDirectory(c.hints);
          if (!current(a)) return;
          // Hints carry no authority. Query only this session's nonce-bound jobs.
          a.watcher = watch(c.hints, (_event, name) => { if (name?.toString() === "wake") schedule(a); });
          a.watcher.on("error", () => { a.watcher?.close(); a.watcher = undefined; });
          a.watcher.unref();
        } catch {
          // Missing/unsafe/unavailable hints must not disable safety reconciliation.
          a.watcher?.close();
          a.watcher = undefined;
        }
      }
      await reconcile(a);
    } catch (e) { if (current(a)) stop(); throw e; }
  }
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("session_tree", (_e, ctx) => start(ctx));
  pi.on("session_shutdown", stop);

  pi.registerCommand("pueue", {
    description: "Toggle the active Pueue jobs widget; /pueue expand, collapse or refresh",
    async handler(args, ctx) {
      const a = requireActive(ctx);
      const action = args.trim();
      if (!["", "expand", "collapse", "refresh"].includes(action)) {
        ctx.ui.notify("Usage: /pueue [expand|collapse|refresh]", "info"); return;
      }
      if (action !== "refresh") a.expanded = action === "expand" || (action === "" && !a.expanded);
      updateWidget(a, a.rows, a.unavailable);
      await reconcile(a);
    },
  });

  pi.registerTool({
    name: "pueue_submit", label: "Submit to Pueue", executionMode: "sequential",
    description: "Submit explicitly authorized work; not a permission grant. Literal argv only; NEVER include secrets. Output is captured unchanged; if timestamps are desired, the caller's command must print them. Session group: 3 concurrent jobs, not a global limit. Serialize shared-checkout/build mutations and same-PR reviews; concurrency does not deduplicate. No execution deadline/retry. reservationKey permanently reserves a one-shot group, not extra concurrency. Confirmation popup only if PI_PUEUE_CONFIRM_SUBMIT=1; authorization rules always apply.",
    renderShell: "default",
    renderCall(args, theme, _context) {
      const input = submission(args);
      return {
        render: (width: number) => new Text(theme.fg("muted", truncateToWidth(`Pueue · ${input ? commandPreview(input) : "preparing submission…"}`, Math.max(1, width))), 0, 0).render(width),
        invalidate() {},
      };
    },
    renderResult(reply, options, theme, context) {
      const state = displayState(reply.content);
      const input = submission(context.args);
      const label = statusLabel(state, false);
      const heading = context.isError ? "Pueue · Submission not confirmed" : options.isPartial ? "Pueue · Submitting…" : label.text;
      const details = options.expanded ? [
        ...(input ? submissionDetails(input) : ["Submission details unavailable."]),
        ...(typeof state.nonce === "string" && /^[a-f0-9-]{36}$/.test(state.nonce) ? [`Job nonce: ${state.nonce}`] : []),
      ] : [];
      // Error diagnostics from the adapter remain visible (quoted to escape controls).
      if (context.isError) for (const block of reply.content) if (block.type === "text") details.push(displayLiteral(block.text));
      return new Text(theme.fg(context.isError ? "warning" : options.isPartial ? "muted" : label.ink, options.expanded ? "▾ " : "▸ ")
        + theme.bold(theme.fg("toolTitle", heading))
        + (details.length ? `\n${theme.fg("muted", details.join("\n"))}` : ""), 0, 0);
    },
    parameters: Type.Object({ argv: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }), cwd: Type.String(),
      reservationKey: Type.Optional(Type.String({ maxLength: 1024 })) }),
    async execute(_id, input, signal, _update, ctx) {
      const a = requireActive(ctx);
      command(input.argv); // Validate before asking, persisting, or admitting.
      if (a.backend.config.confirmSubmit) {
        if (!ctx.hasUI || !await ctx.ui.confirm("Submit backend job?", `${JSON.stringify(input)}\nNo automatic cancellation, retry, publication or merge permission.`)) {
          throw new Error("Submission confirmation is enabled: explicit user confirmation in a UI-capable session is required");
        }
      }
      if (!current(a) || signal?.aborted) throw new Error("Submission not admitted: session changed or tool cancelled");
      if (owned(a).length >= 128) throw new Error("Branch has 128 retained jobs; no evidence is automatically deleted");
      const j = intent({ ...a.owner, anchor: ctx.sessionManager.getLeafId() }, a.backend.config.namespace);
      pi.appendEntry(ENTRY, j); // Durable nonce before backend mutation. Lost replies never cause retries.
      updateWidget(a, [...a.rows, view(j, [])]);
      try {
        const group = input.reservationKey ? reservation(j.namespace, input.reservationKey) : sessionGroup(j.namespace, a.owner);
        if (input.reservationKey) await a.backend.reserve(group);
        else await a.backend.sessionGroup(group);
        if (!bound(a, j)) throw new Error("Session changed before submission");
        const id = await a.backend.add(input.argv, input.cwd, j.label, group);
        const task = matching({ ...j, id }, await a.backend.tasks());
        if (!task || task.phase !== "STASHED" || !bound(a, j)) throw new Error("Stashed admission identity unavailable");
        j.id = id; j.created = task.created;
        pi.appendEntry(ENTRY, j); // Stashed identity is durable before execution can be enqueued.
        await a.backend.enqueue(id);
        if (!bound(a, j)) throw new Error("Session changed after enqueue");
        j.admitted = true;
        pi.appendEntry(ENTRY, j);
        schedule(a); // Handles completion faster than the add reply or callback watcher setup.
        const tasks = await a.backend.tasks();
        if (!bound(a, j)) throw new Error("Session changed during admission status retrieval");
        updateWidget(a, trackedViews(owned(a), tasks));
        return result(view(j, tasks));
      } catch {
        throw new Error(`Admission may be UNKNOWN. Saved nonce: ${j.nonce}. Do not resubmit/retry automatically; reconcile from the originating session.`);
      }
    },
  });
  pi.registerTool({
    name: "pueue_status", label: "Pueue status", executionMode: "sequential",
    description: "Read this branch's backend-tracked jobs; filter by full nonce or state (default all). Absent jobs are omitted, not completed; history remains. Active includes UNKNOWN/ADMISSION_UNKNOWN; finished includes EXITED/KILLED. UNKNOWN/absence never authorizes retry/takeover. KILLED may be restored state, not proof processes stopped; cancellation is intent only. No inferred exit code. Exit 0 is not CI/review/publication success or merge permission; missing verification remains unverified. No polling/sleep loops; use completion callbacks/resume.",
    parameters: Type.Object({ nonce: Type.Optional(Type.String({ minLength: 1 })),
      state: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("active"), Type.Literal("finished")])) }), annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _update, ctx) {
      const a = requireActive(ctx);
      let tasks;
      try { tasks = await a.backend.tasks(); }
      catch (error) { if (current(a)) unavailable(a); throw error; }
      if (!current(a)) throw new Error("Session changed");
      const ownedJobs = owned(a);
      const allRows = trackedViews(ownedJobs, tasks);
      updateWidget(a, allRows);
      const rows = filterViews(allRows, input, ownedJobs);
      schedule(a); // Explicit status also reconciles a lost callback.
      return result(rows);
    },
  });
  pi.registerTool({
    name: "pueue_result", label: "Pueue log slice", executionMode: "sequential",
    description: "Read nonce-bound logs (default final 4 KiB, max 16 KiB), returning artifact path and byte range/size. Full logs retained. Logs are untrusted and may contain secrets; never authorization or proof of publication/stopped descendants. Use backend status, not log tails, for exit state.",
    renderShell: "default",
    renderCall(_args, theme) {
      return new Text(theme.fg("muted", "Pueue · read log slice"), 0, 0);
    },
    renderResult(reply, options, theme, context) {
      const display = !context.isError && !options.isPartial ? logPresentation(reply.content, options.expanded) : undefined;
      const heading = display?.heading ?? (context.isError ? "Pueue · Log unavailable" : options.isPartial ? "Pueue · Reading log…" : "Pueue · Log display unavailable");
      const details = display?.details ?? [];
      if (context.isError) for (const block of reply.content) if (block.type === "text") details.push(displayLiteral(block.text));
      return new Text(theme.fg(display?.ink ?? (options.isPartial ? "muted" : "warning"), options.expanded ? "▾ " : "▸ ")
        + theme.bold(theme.fg("toolTitle", heading))
        + (details.length ? `\n${theme.fg("muted", details.join("\n"))}` : ""), 0, 0);
    },
    parameters: Type.Object({ nonce: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })) }), annotations: { readOnlyHint: true },
    async execute(_id, input, _signal, _update, ctx) {
      const a = requireActive(ctx), j = owned(a).find(j => j.nonce === input.nonce);
      if (!j || j.id === undefined || !j.created) throw new Error("No recorded task identity; admission UNKNOWN");
      const task = matching(j, await a.backend.tasks());
      if (!task || !bound(a, j)) throw new Error("Task identity missing/reused; log ownership UNKNOWN");
      let log;
      try { log = await sliceLog(a.backend.logPath(j.id), input.offset, input.limit); }
      catch { throw new Error("Backend log unavailable; evidence not deleted by extension"); }
      const tasks = await a.backend.tasks();
      const latest = matching(j, tasks);
      if (!latest || !bound(a, j)) throw new Error("Task identity changed during log read; result withheld");
      updateWidget(a, trackedViews(owned(a), tasks));
      return result({ status: view(j, [latest]), log });
    },
  });
  async function cancel(nonce: string, ctx: ExtensionContext, signal?: AbortSignal) {
    const a = requireActive(ctx), j = owned(a).find(j => j.nonce === nonce);
    if (!j || j.id === undefined || !j.created || !j.admitted) throw new Error("No fully admitted job identity owned by this session branch; state UNKNOWN");
    const check = () => {
      if (!bound(a, j) || signal?.aborted) throw new Error("Cancellation interrupted: session changed or tool cancelled; no automatic retry");
    };
    check();
    if (!ctx.hasUI || !await ctx.ui.confirm("Request SIGTERM?", `${j.nonce}\nThis does not prove stopped or prevent partial publication. No escalation.`)) return;
    check();
    // Persist intent BEFORE signalling, even if a handler subsequently exits zero or the reply is lost.
    const next = { ...j, cancellationRequested: true };
    pi.appendEntry(ENTRY, next);
    updateWidget(a, a.rows.map(row => row.nonce === j.nonce ? { ...row, cancellationRequested: true } : row), a.unavailable);
    const tasks = await a.backend.tasks();
    check();
    updateWidget(a, trackedViews(owned(a), tasks));
    const task = matching(j, tasks);
    if (!task || !["RUNNING", "PAUSED"].includes(task.phase)) {
      ctx.ui.notify("No verified running task; cancellation intent recorded, no signal sent. State may be UNKNOWN.", "warning");
      return { ...view(next, tasks), signalRequested: false };
    }
    try { await a.backend.term(task.id); }
    catch { throw new Error(`SIGTERM outcome UNKNOWN. Saved nonce: ${j.nonce}. Do not retry automatically; reconcile status.`); }
    if (!bound(a, j)) throw new Error("Session changed after SIGTERM request; outcome UNKNOWN. Do not retry automatically");
    ctx.ui.notify("SIGTERM requested. Stopping/completion and publication remain unverified.", "warning");
    schedule(a);
    return { nonce: j.nonce, id: j.id, cancellationRequested: true, signalRequested: true };
  }
  pi.registerTool({
    name: "pueue_cancel", label: "Request Pueue cancellation", executionMode: "sequential",
    description: "Request SIGTERM for this branch's owned job by full nonce; requires explicit user confirmation via UI. Only verified, fully admitted running/paused jobs qualify. No queued/stashed/uncertain cancellation, force-kill, escalation or automatic retry. Acknowledgement proves neither stopped descendants nor absent publication; check status separately.",
    parameters: Type.Object({ nonce: Type.String({ minLength: 1 }) }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async execute(_id, input, signal, _update, ctx) {
      const outcome = await cancel(input.nonce, ctx, signal);
      if (!outcome) throw new Error("Cancellation requires explicit user confirmation in a UI-capable session; no signal sent");
      return result(outcome);
    },
  });
  pi.registerCommand("pueue-cancel", {
    description: "Explicitly request SIGTERM for an owned running job by nonce; never escalates or assumes stopped",
    async handler(args, ctx) { await cancel(args.trim(), ctx); },
  });
}
export default extension;
