import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { catalogue, resolveSelection } from "./catalogue.mjs";
import { ENTRY, initiatorLabel, prepare, prepareRevision, attemptDirectory, runtimeFrom, tasksFrom, json, snapshot, git, tail } from "./core.mjs";

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
const backendSchema = Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude")], { description: "Optional explicit harness override for native model IDs. Normally omit: the exact delegate_models catalogue entry selects the harness. Overrides cannot bypass the Anthropic-to-Claude / local-and-OpenAI-to-Pi policy; conflicts fail, never fall back." }));
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
        worktree: task.worktree, artifacts: directory });
    } catch {
      throw new Error(`Task ${task.id} retained at ${directory}. Submission may be UNKNOWN: inspect originating Pueue history. Do not resubmit automatically.`);
    }
  }
  pi.registerTool({
    name: "delegate_models", label: "List delegate model routes", exposure: "model-only", executionMode: "sequential",
    description: "List the shared delegate catalogue: Pi local/OpenAI models and Claude Code routes for Anthropic models. Anthropic registry entries are discovery aliases for Claude Code, never Pi API routes; Pi Anthropic auth is not used. Operator-declared Claude Code routes are included. Select an exact entry id as delegate_task/delegate_revise model and omit backend for deterministic routing. No model calls, authentication probes, health checks or fallback. Metadata is not worker readiness: host authentication may differ from the scrubbed child environment, and CLI model/auth support remains unverified. Endpoint origins only, no credentials. Filter by backend/provider/query and page with offset/limit.",
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
    description: "Delegate an explicitly authorized bounded implementation task to Pi (backend:pi) or Claude Code (backend:claude) through existing Pueue. Select an exact delegate_models entry ID as model and omit backend for deterministic routing: local/OpenAI provider/model IDs invoke Pi; Anthropic provider/model aliases and configured claude-code/claude-* entries invoke Claude Code. Anthropic through Pi is forbidden, even with an explicit override; local/OpenAI through Claude is forbidden. No inferred model matching or fallback. Explicit backend plus native model ID remains supported. Claude thinking is CLI effort (low/medium/high/xhigh/max), with runtime.claude required. Orchestrator supplies model, thinking level, self-contained brief (scope, relevant files, acceptance criteria, mechanical/logic-heavy review assessment), and only necessary checks through an operator-configured verification profile. Requires a clean Git source checkout; uses its current committed HEAD, never chooses a release target or deployment route for you. Creates a retained sibling worktree with uncommitted changes. Worker cannot call shell, publish, commit or delegate through its tools; this is NOT an OS sandbox. Two worker slots per machine and one heavy-check lock across delegated tasks; unrelated Pueue work is not globally limited. No automatic retries/integration/cleanup. Exit zero is not acceptance. Keep brief/argv free of secrets. The UI already displays model/thinking and submission status; avoid repeating these in user-facing narration unless needed to explain a problem. After Pueue completion, use delegate_review and perform the review yourself: read the entire trackedPatch and every untracked file, inspect relevant source/context and current check evidence against the brief, and report findings or a concise review verdict. Do not ask the user to manually review diffs by default. Worker reports and exit zero are not review. Publication/integration still require their existing authorization. SDK setup is never automatic.",
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
    description: "Start one explicitly authorized revision of an owned task in its SAME worktree/build output directory. Supply the latest job nonce and current fingerprint from delegate_review, a self-contained revision brief, exact model and thinking. Anthropic always uses Claude Code; local/OpenAI always use Pi. Overrides cannot bypass this policy. An exact delegate_models entry ID automatically selects its harness, independently of the previous attempt; there is no fallback. Explicit backend plus native model ID remains supported within policy; native claude-* IDs always select Claude Code. Claude uses CLI effort low/medium/high/xhigh/max, not Pi thinking semantics. Requires previous worker confirmed EXITED/0 without cancellation or integrity error; missing/uncertain/failed evidence blocks automatic continuation. Preserves existing uncommitted changes and all earlier artifacts. New attempt has a fresh context/session and inherits the original planned checks/profile. One durable claim per previous job prevents duplicate revisions, including after branch navigation or lost admission. No automatic retries, cleanup, publication or integration. Review is still required; this is not an OS sandbox. The UI already displays model/thinking and submission status; avoid repeating these in user-facing narration unless needed to explain a problem.",
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
    name: "delegate_review", label: "Review delegated diff", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status", "worktree_panel_target"],
    description: "Omit task to list this active branch's owned task IDs/nonces (no backend query). With a full task UUID, after authoritative Pueue EXITED, collect its untrusted report, tracked diff artifact, new-file list and current-fingerprint check evidence; optionally point the existing diff panel at its worktree with openDiff:true (default false). Does not accept, integrate, retry, delete, or infer success from exit zero. New files are shown by the panel; ignored files are not certified. The main agent must review the entire trackedPatch, every untracked file, relevant source/context and current check evidence against the brief, then report findings or a concise verdict; do not require manual user diff review by default. No polling.",
    parameters: Type.Object({ task: Type.Optional(Type.String()), openDiff: Type.Optional(Type.Boolean()) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(args.task ? "Subagent · collect review evidence" : "Subagents · list tasks")) +
        (args.task ? `\nTask: ${args.task}` : ""), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      if (isPartial) return new Text("Collecting subagent evidence…", 0, 0);
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
          theme.fg("warning", "Evidence collected · main-agent review pending (not accepted)"),
          `Checks: ${missing.length ? `missing/current passing evidence needed for indices: ${missing.join(", ")}` : checks.length ? "all planned checks have current passing evidence" : "none planned"}`,
          `New files: ${files.length}${files.length ? ` · ${files.slice(0, 3).join(", ")}${files.length > 3 ? " …" : ""}` : ""}`,
        ];
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
      if (rows.length !== 1 || rows[0].phase !== "EXITED") throw new Error("Worker is not authoritatively EXITED; retain evidence and do not retry");
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
      if (input.openDiff === true) await ctx.executeTool("worktree_panel_target", { path: task.worktree }, { signal });
      let report;
      try { report = await tail(join(directory, "report.md")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      return response({ task: task.id, attempt: task.attempt, initiator: initiator(task), route: task.route, backend: task.backend ?? "pi", status: rows[0], worker, fingerprint, trackedPatch, untracked, checks, report,
        worktree: task.worktree, reviewRequired: true, reviewer: "main-agent", accepted: false,
        missingChecks: task.checks.map((_: unknown, i: number) => i).filter((i: number) => !checks.some(c => c.index === i && c.passed && c.current)) });
    },
  });
}
