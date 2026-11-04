import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { catalogue, resolveSelection } from "./catalogue.mjs";
import { assertStopped } from "./containment.mjs";
import { recoveryAuthorization, recoveryGate, prepareRecovery } from "./recovery.mjs";
import { feedbackChoices, feedbackRequest, feedbackTask, validateFeedback, writeFeedback } from "./feedback.mjs";
import { ENTRY, initiatorLabel, prepare, prepareRevision, attemptDirectory, runtimeFrom, tasksFrom, json, snapshot, sourceSnapshot, git, tail } from "./core.mjs";

const response = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
function renderSubmission(result: { content: Array<{ type: string; text?: string }> }, expanded: boolean, partial: boolean, theme: Theme) {
  const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (partial) return new Text("Preparing / submitting subagent…", 0, 0);
  try {
    const data = JSON.parse(raw);
    if (!data.nonce) return new Text(raw, 0, 0);
    const phase = data.phase === "QUEUED" ? "Queued" : data.phase ?? "State unknown";
    return new Text(theme.fg("accent", `${phase} · Pueue #${data.id ?? "?"}`) +
      (expanded ? `\nBackend: ${data.backend ?? "pi"}\nInitiator: ${data.initiator?.label ?? "unknown"}\nTask: ${data.task}${data.attempt ? `\nAttempt: ${data.attempt}` : ""}\nPueue nonce: ${data.nonce}\nWorktree: ${data.worktree}\nArtifacts: ${data.artifacts}` : ""), 0, 0);
  } catch { return new Text(raw, 0, 0); }
}
const backendSchema = Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude")], { description: "Normally omit; exact catalogue IDs select the harness. Native IDs may specify pi or claude. Anthropic requires Claude; local/OpenAI require Pi. Conflicts fail; no fallback." }));
const thinkingSchema = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
function nested(reply: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>) {
  if (reply.isError) throw new Error("Pueue/panel operation failed; inspect its retained evidence, never automatically resubmit");
  return JSON.parse(reply.result.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
}
function owner(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Delegation requires a persistent session");
  const name = ctx.sessionManager.getSessionName?.()?.trim().slice(0, 200);
  return { session: ctx.sessionManager.getSessionId(), file, ...(name ? { name } : {}) };
}
function initiator(task: any) {
  return { session: task.owner.session, name: task.owner.name ?? null, label: task.initiatorLabel ?? initiatorLabel(task.owner) };
}
function owned(ctx: ExtensionContext, id: string): any {
  const task: any = tasksFrom(ctx.sessionManager.getBranch()).get(id), who = owner(ctx);
  if (!task || task.owner.session !== who.session || task.owner.file !== who.file) throw new Error("Task is not owned by this active session branch");
  return task;
}
export default function (pi: ExtensionAPI) {
  let epoch = 0;
  pi.on("session_start", () => { epoch++; });
  pi.on("session_tree", () => { epoch++; });
  pi.on("session_shutdown", () => { epoch++; });
  const guard = (start: number) => { if (start !== epoch) throw new Error("Session changed; retain artifacts and reconcile, never automatically retry"); };
  async function submit(task: any, runtime: any, runtimePath: string, start: number, signal: AbortSignal | undefined, ctx: ExtensionToolContext) {
    guard(start);
    pi.appendEntry(ENTRY, task); // Pending intent blocks further revisions, even after uncertain admission.
    if (signal?.aborted) throw new Error(`Prepared task ${task.id} retained; not submitted`);
    const directory = attemptDirectory(task, task.attempt);
    try {
      const state = nested(await ctx.executeTool("pueue_submit", {
        argv: [runtime.launcher, runtimePath, task.id, ...(task.attempt === undefined ? [] : [task.attempt])], cwd: task.worktree,
      }, { signal }));
      guard(start);
      if (typeof state.nonce !== "string") throw new Error("Missing admission identity");
      pi.appendEntry(ENTRY, { ...task, nonce: state.nonce });
      await writeFile(join(directory, "submission.json"), JSON.stringify({ nonce: state.nonce }) + "\n", { mode: 0o600, flag: "wx" });
      return response({ task: task.id, attempt: task.attempt, ...state, initiator: initiator(task), route: task.route, backend: task.backend ?? "pi", model: task.model, thinking: task.thinking,
        worktree: task.worktree, artifacts: directory, baseline: { base: task.base, sourceHead: task.sourceHead ?? task.base, sourceFingerprint: task.sourceFingerprint ?? null } });
    } catch {
      throw new Error(`Task ${task.id} retained at ${directory}. Submission may be UNKNOWN: inspect originating Pueue history. Do not resubmit automatically.`);
    }
  }
  pi.registerTool({
    name: "delegate_models", label: "List delegate model routes", exposure: "model-only", executionMode: "sequential",
    description: "List delegate model routes, filter by backend/provider/query, and paginate. Use an exact entry ID as model for task/revise; omit backend. Anthropic routes use Claude Code; local/OpenAI use Pi. Discovery only: no model calls or auth/readiness checks; listed routes may not work in the worker environment.",
    parameters: Type.Object({ backend: backendSchema, provider: Type.Optional(Type.String({ maxLength: 128 })),
      query: Type.Optional(Type.String({ maxLength: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Delegate model catalogue")) + (args.query ? `\n${args.query}` : ""), 0, 0);
    },
    async execute(_id, input, _signal, _update, ctx) {
      const runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const entries = catalogue(runtime, ctx.modelRegistry, input), offset = input.offset ?? 0, limit = input.limit ?? 50;
      return response({ entries: entries.slice(offset, offset + limit), total: entries.length, offset,
        nextOffset: offset + limit < entries.length ? offset + limit : null, fallback: false, workerReadinessVerified: false });
    },
  });
  pi.registerTool({
    name: "delegate_task", label: "Delegate isolated task", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_submit"],
    description: "Start an explicitly authorized implementation task via Pueue in a retained sibling worktree, snapshotting staged/unstaged changes and nonignored new files without changing the source branch/index. Supply exact delegate_models ID, thinking, self-contained brief (scope, files, acceptance criteria, review complexity), configured profile and necessary checks. Anthropic requires Claude Code; local/OpenAI require Pi; no route guessing/fallback. Claude requires runtime.claude and effort low/medium/high/xhigh/max. No conflicts, submodules or sparse/assume-unchanged entries. Worker tools cannot shell, publish, commit or delegate; NOT an OS sandbox. Keep inputs secret-free. No automatic retry, integration, publication, cleanup or SDK setup; deployment choices and integration/publication require authorization. After completion use delegate_review, personally inspect all changes/context/checks and report a verdict; after review or terminal-failure investigation call delegate_feedback. Exit zero/report is not acceptance. Reconcile source drift before integration. UI already shows model/thinking/status; avoid redundant narration.",
    parameters: Type.Object({ repo: Type.String(), brief: Type.String({ minLength: 1, maxLength: 32000 }),
      backend: backendSchema, model: Type.String(), thinking: thinkingSchema,
      profile: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$", description: "Name of an operator-configured verification profile in PI_DELEGATE_RUNTIME" }),
      checks: Type.Array(Type.Object({ kind: Type.Union([Type.Literal("test"), Type.Literal("build")]),
        targets: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }) }), { maxItems: 8 }) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Subagent · task")) +
        `\n${args.model ?? "…"} · requested thinking: ${args.thinking ?? "…"}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderSubmission(result, expanded, isPartial, theme);
    },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch;
      const runtimePath = process.env.PI_DELEGATE_RUNTIME, runtime = await runtimeFrom(runtimePath);
      const selection = resolveSelection(input, runtime, ctx.modelRegistry);
      if (signal?.aborted) throw new Error("Delegation cancelled before preparation");
      guard(start);
      const task = await prepare(selection, runtime, owner(ctx));
      return submit(task, runtime, runtimePath!, start, signal, ctx);
    },
  });
  pi.registerTool({
    name: "delegate_revise", label: "Revise retained task", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status", "pueue_submit"],
    description: "Start one authorized revision in the owned task's same worktree/build directory, preserving changes/artifacts and frozen checks/profile, with fresh context. Requires confirmed EXITED/0, no cancellation/integrity error, latest nonce and current fingerprint from delegate_review. Supply self-contained brief, exact model ID and thinking; Anthropic requires Claude, local/OpenAI require Pi, no fallback. Claude effort: low/medium/high/xhigh/max. One continuation per prior attempt; uncertain/failed evidence blocks revision. No automatic retry, cleanup, publication or integration; not an OS sandbox. Review each attempt with delegate_review, then record delegate_feedback (also after terminal-failure investigation).",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1 }),
      expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), brief: Type.String({ minLength: 1, maxLength: 32000 }),
      backend: backendSchema, model: Type.String(), thinking: thinkingSchema }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Subagent · revision")) +
        `\n${args.model ?? "…"} · requested thinking: ${args.thinking ?? "…"}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderSubmission(result, expanded, isPartial, theme);
    },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, task = owned(ctx, input.task), runtimePath = process.env.PI_DELEGATE_RUNTIME;
      const runtime = await runtimeFrom(runtimePath);
      if (!task.nonce || task.nonce !== input.expectedNonce) throw new Error("Previous job nonce changed or binding unavailable; review the latest task");
      const selection = resolveSelection(input, runtime, ctx.modelRegistry, task);
      const rows = nested(await ctx.executeTool("pueue_status", { nonce: task.nonce }, { signal }));
      if (rows.length !== 1 || rows[0].phase !== "EXITED" || rows[0].exitCode !== 0 || rows[0].cancellationRequested) {
        throw new Error("Previous worker is not confirmed EXITED/0 without cancellation; investigate, do not automatically retry");
      }
      const previous = await json(join(attemptDirectory(task, task.attempt), "result.json"));
      if (previous.code !== 0 || previous.signal || previous.integrityError || !previous.fingerprint) throw new Error("Previous worker evidence incomplete; investigate before revision");
      guard(start);
      if (signal?.aborted) throw new Error("Revision cancelled before preparation");
      const revision = await prepareRevision(task, selection, runtime);
      return submit(revision, runtime, runtimePath!, start, signal, ctx);
    },
  });
  pi.registerTool({
    name: "delegate_resume", label: "Recover stopped delegate", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status", "pueue_submit"],
    description: "Recover one failed/canceled owned attempt with fresh context in the same worktree/build directory. Every call requires fresh interactive user confirmation, terminal backend state and trusted attempt-specific cgroup-v2 proof that worker and descendants stopped. KILLED/missing PIDs alone are insufficient; UNKNOWN/absent/active/unrecorded or uncertain attempts fail closed. Supply latest nonce, self-contained brief and reviewed current fingerprint from delegate_review; foreground fixes allowed. Preserves route/model/thinking/checks/profile and prior failure/cancellation artifacts. Shares revise's one-continuation claim; no automatic retry/takeover. Not Claude --resume. Use delegate_revise for successful uncanceled attempts. Fully review with delegate_review, report verdict, then delegate_feedback. No automatic acceptance, integration, publication or cleanup.",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1, maxLength: 200 }),
      expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), brief: Type.String({ minLength: 1, maxLength: 32000 }) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Subagent · explicit recovery")) + `\nTask: ${args.task}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) { return renderSubmission(result, expanded, isPartial, theme); },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, task = owned(ctx, input.task), runtimePath = process.env.PI_DELEGATE_RUNTIME;
      const runtime = await runtimeFrom(runtimePath);
      const check = () => {
        guard(start);
        if (signal?.aborted || owned(ctx, input.task).nonce !== task.nonce) throw new Error("Recovery canceled or latest attempt changed");
      };
      check();
      if (!ctx.hasUI) throw new Error("Recovery requires fresh interactive user authorization; non-UI recovery is disabled");
      let rows = nested(await ctx.executeTool("pueue_status", { nonce: input.expectedNonce }, { signal }));
      const gate = await recoveryGate(task, input, runtime, rows);
      check();
      const approved = await ctx.ui.confirm("Authorize one delegate recovery?", [
        `Task: ${task.id}`, `Previous job: ${task.nonce} · ${gate.execution.phase} · cancellation: ${gate.execution.cancellationRequested}`,
        `Backend/model: ${gate.selection.backend} / ${gate.selection.model} · thinking: ${gate.selection.thinking}`,
        `Reviewed fingerprint: ${input.expectedFingerprint}`, `Brief (JSON-escaped): ${JSON.stringify(input.brief)}`,
        "Starts a fresh attempt with the same profile/check plan. Previous failure/cancellation remains recorded. Full review is still required.",
      ].join("\n"));
      if (!approved) throw new Error("Recovery not authorized; no attempt prepared");
      check();
      const authorization = recoveryAuthorization(task, input);
      // Re-query and recheck after the dialog; confirmation grants no stale-state bypass.
      rows = nested(await ctx.executeTool("pueue_status", { nonce: input.expectedNonce }, { signal }));
      const resumed = await prepareRecovery(task, input, runtime, rows, authorization, check);
      return submit(resumed, runtime, runtimePath!, start, signal, ctx);
    },
  });
  pi.registerTool({
    name: "delegate_feedback", label: "Record caller delegation feedback", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status"],
    description: "Record your own assessment after reviewing a terminal attempt's changes/context/checks or investigating failure. Bind task and exact nonce (historical attempts on this branch supported). Use partial/not_reviewed and not_assessed for incomplete evidence; exit zero is not review, KILLED is not proof descendants stopped. No prompts, file bodies or secrets. Append-only private record; supersedes corrects earlier feedback for the same attempt. Not acceptance, source verification, integration/publication or retry permission; no worker/worktree mutation.",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1, maxLength: 200 }),
      ...Object.fromEntries(Object.entries(feedbackChoices).map(([key, choices]) => [key, Type.Union(choices.map(value => Type.Literal(value)))])),
      rationale: Type.String({ minLength: 1, maxLength: 4000 }),
      problems: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
      improvements: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
      evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
      reviewedFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      supersedes: Type.Optional(Type.String({ description: "Prior feedback UUID for the same attempt; append a correction, never overwrite" })) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Subagent · caller feedback")) + `\nTask: ${args.task}`, 0, 0);
    },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch;
      validateFeedback(input);
      const who = owner(ctx), task = feedbackTask(ctx.sessionManager.getBranch(), who, input);
      const runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const rows = nested(await ctx.executeTool("pueue_status", { nonce: task.nonce }, { signal }));
      const check = () => { guard(start); if (signal?.aborted) throw new Error("Feedback cancelled before recording"); };
      check();
      return response(await writeFeedback(runtime, task, input, rows,
        { session: who.session, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null }, check));
    },
  });
  pi.registerTool({
    name: "delegate_review", label: "Collect delegate changes", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status", "worktree_panel_target"],
    description: "Omit task to list this branch's owned tasks/nonces. With task UUID, collect untrusted report, worker-only trackedPatch, new files and current-fingerprint check evidence after Pueue EXITED (or KILLED with independently verified empty containment). openDiff optionally opens the panel. The main agent must review the entire trackedPatch, every untracked file, relevant context and current checks against the brief; report findings/verdict, then call delegate_feedback. Do not offload review to the user or rate incomplete evidence as reviewed/correct. If sourceState drifted/unavailable, recheck destination and reconcile before integration; never overwrite inherited work. Collection is not acceptance or an integration lease; exit zero proves neither. Ignored files are not certified. No polling, retry, integration or cleanup.",
    parameters: Type.Object({ task: Type.Optional(Type.String()), openDiff: Type.Optional(Type.Boolean()) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(args.task ? "Subagent · collect changes and report" : "Subagents · list tasks")) +
        (args.task ? `\nTask: ${args.task}` : ""), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      if (isPartial) return new Text("Collecting subagent changes and report…", 0, 0);
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          const lines = data.length ? data.flatMap(t => [
            `Task: ${t.task}${t.attempt ? " (revision)" : ""}`,
            `  ${t.model ?? "model unavailable"} · requested thinking: ${t.thinking ?? "unknown"}`,
            ...(expanded ? [`  Pueue: ${t.nonce ?? "binding unavailable"}`, `  Worktree: ${t.worktree}`, `  Artifacts: ${t.artifacts}`] : []),
          ]) : ["No delegated tasks on this session branch."];
          return new Text(lines.join("\n"), 0, 0);
        }
        if (!data.task || !data.status) return new Text(raw, 0, 0);
        const missing = data.missingChecks ?? [], checks = data.checks ?? [], files = data.untracked ?? [];
        const lines = [
          theme.fg("accent", `Pueue #${data.status.id ?? "?"} · ${data.status.phase} · exit ${data.status.exitCode ?? "unknown"}`),
          "Changes collected · review verdict is separate",
          `Checks: ${missing.length ? `missing/current passing evidence needed for indices: ${missing.join(", ")}` : checks.length ? "all planned checks have current passing evidence" : "none planned"}`,
          `New files: ${files.length}${files.length ? ` · ${files.slice(0, 3).join(", ")}${files.length > 3 ? " …" : ""}` : ""}`,
        ];
        if (data.sourceState?.unchanged === false) lines.push(theme.fg("warning", "Main checkout changed since handoff; check conflicts before integration."));
        if (data.sourceState?.error) lines.push(theme.fg("warning", "Main checkout state unavailable; check conflicts before integration."));
        if (data.status.cancellationRequested) lines.push(theme.fg("warning", "Cancellation requested; exit alone does not establish safe completion."));
        if (!data.worker) lines.push(theme.fg("warning", "Worker result evidence unavailable."));
        else {
          if (data.worker.code !== 0 || data.worker.signal) lines.push(theme.fg("warning", `Worker result: exit ${data.worker.code ?? "unknown"}${data.worker.signal ? ` · signal ${data.worker.signal}` : ""}`));
          if (data.worker.integrityError) lines.push(theme.fg("error", `Integrity error: ${data.worker.integrityError}`));
          if (data.worker.fingerprint !== data.fingerprint) lines.push(theme.fg("warning", "Source differs from worker result; inspect current evidence."));
        }
        if (expanded) {
          lines.push(`Task: ${data.task}`, ...(data.attempt ? [`Revision: ${data.attempt}`] : []),
            `Pueue nonce: ${data.status.nonce}`, `Worktree: ${data.worktree}`,
            `Tracked diff: ${data.trackedPatch}`, `Fingerprint: ${data.fingerprint}`);
          if (files.length) lines.push("New files (read separately):", ...files.map((file: string) => `  ${file}`));
          for (const check of checks) lines.push(`Check #${check.index}: ${check.passed ? "passed" : "not passed"} · ${check.current ? "current" : "stale"}${check.log ? ` · ${check.log}` : ""}`);
          if (data.worker?.elapsedMs !== undefined) lines.push(`Worker duration: ${(data.worker.elapsedMs / 1000).toFixed(1)}s`);
          if (data.report) lines.push(`Worker report (untrusted): ${data.report.path}${data.report.truncated ? " (excerpt)" : ""}`, data.report.text ?? "");
          else lines.push("Worker report unavailable.");
        }
        return new Text(lines.join("\n"), 0, 0);
      } catch { return new Text(raw, 0, 0); }
    },
    async execute(_id, input, signal, _update, ctx) {
      if (!input.task) {
        const who = owner(ctx);
        return response([...tasksFrom(ctx.sessionManager.getBranch()).values()].filter((t: any) => t.owner.session === who.session && t.owner.file === who.file)
          .map((t: any) => ({ task: t.id, attempt: t.attempt, nonce: t.nonce, initiator: initiator(t), route: t.route, backend: t.backend ?? "pi", model: t.model, thinking: t.thinking, worktree: t.worktree, artifacts: attemptDirectory(t, t.attempt) })));
      }
      const start = epoch;
      const task = owned(ctx, input.task), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      if (!task.nonce) throw new Error("Admission binding unavailable; reconcile originating Pueue history manually");
      const rows = nested(await ctx.executeTool("pueue_status", { nonce: task.nonce }, { signal }));
      if (rows.length !== 1 || !["EXITED", "KILLED"].includes(rows[0].phase)) throw new Error("Worker is not authoritatively terminal; retain evidence and do not retry");
      if (rows[0].phase === "KILLED" || rows[0].cancellationRequested
        || (runtime.containmentProtocol === 1 && rows[0].exitCode !== 0)) await assertStopped(task);
      const fingerprint = await snapshot(task, runtime);
      const directory = attemptDirectory(task, task.attempt), trackedPatch = join(directory, "tracked.diff");
      await writeFile(trackedPatch, await git(runtime, task.worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]), { mode: 0o600 });
      const untracked = (await git(runtime, task.worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      const checks: Array<{ index: number; passed: boolean; current: boolean; [key: string]: unknown }> = [];
      for (const name of await readdir(directory)) if (/^check-\d+-[a-f0-9-]+\.json$/.test(name)) {
        const record = await json(join(directory, name));
        checks.push({ ...record, current: record.after === fingerprint });
      }
      let worker;
      try { worker = await json(join(directory, "result.json")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      guard(start);
      if (input.openDiff === true) await ctx.executeTool("worktree_panel_target", { path: task.worktree, base: task.base }, { signal });
      let report;
      try { report = await tail(join(directory, "report.md")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      let sourceState;
      if (task.sourceFingerprint) {
        try { sourceState = { unchanged: await sourceSnapshot(task.repo, runtime) === task.sourceFingerprint }; }
        catch { sourceState = { unchanged: null, error: "Source state unavailable" }; }
      }
      return response({ task: task.id, attempt: task.attempt, initiator: initiator(task), route: task.route, backend: task.backend ?? "pi", status: rows[0], worker, fingerprint, trackedPatch, untracked, checks, report,
        baseline: { base: task.base, sourceHead: task.sourceHead ?? task.base, sourceFingerprint: task.sourceFingerprint ?? null }, sourceState,
        worktree: task.worktree, reviewRequired: true, reviewer: "main-agent", accepted: false,
        feedback: feedbackRequest(task),
        missingChecks: task.checks.map((_: unknown, i: number) => i).filter((i: number) => !checks.some(c => c.index === i && c.passed && c.current)) });
    },
  });
}
