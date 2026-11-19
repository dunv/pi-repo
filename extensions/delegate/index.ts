import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { catalogue, resolveSelection } from "./catalogue.mjs";
import { environments } from "./environments.mjs";
import { configuration } from "../pueue/backend.ts";
import { literal, toolPresentation } from "../pueue/tool-presentation.ts";
import { ENTRY, prepare, prepareRevision, attemptDirectory, runtimeFrom, json, privateJSON, save, writeTask, snapshot, sourceSnapshot, git, tail } from "./core.mjs";
import { withTaskLock } from "./lock.mjs";
import { loadWorkspace, assertWorkspaceIdle, inspectWorkspace, cleanupWorkspace, configuredObserver } from "./workspace.mjs";

const response = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
const backendSchema = Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude")], { description: "Normally omit; exact catalogue IDs select the harness. Anthropic uses Claude Code; local/OpenAI use Pi. No fallback." }));
const thinkingSchema = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
function owner(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Delegation requires a persistent main session");
  return { session: ctx.sessionManager.getSessionId(), file, name: ctx.sessionManager.getSessionName?.()?.trim().slice(0, 200) };
}
function nested(reply: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>) {
  if (reply.isError) throw new Error("Submission outcome may be unknown; inspect current jobs, never resubmit automatically");
  return JSON.parse(reply.result.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
}
function renderSubmission(result: { content: Array<{ type: string; text?: string }> }, expanded: boolean, partial: boolean, theme: Theme) {
  const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (partial) return new Text("Preparing / submitting subagent…", 0, 0);
  try {
    const data = JSON.parse(raw);
    if (!data.nonce) return new Text(raw, 0, 0);
    return new Text(theme.fg("accent", `${data.phase === "QUEUED" ? "Queued" : data.phase ?? "State unknown"} · Pueue #${data.id ?? "?"}`) +
      (expanded ? `\nTask: ${data.task}\nPueue nonce: ${data.nonce}\nWorktree: ${data.worktree}\nArtifacts: ${data.artifacts}` : ""), 0, 0);
  } catch { return new Text(raw, 0, 0); }
}
export default function (pi: ExtensionAPI) {
  const orchestratorPolicy = readFileSync(new URL("./orchestrator-policy.md", import.meta.url), "utf8").trim();
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    if (options.selectedTools.includes("delegate_task") && !options.hiddenTools.includes("delegate_task")) {
      options.sections.delegate_orchestration = orchestratorPolicy;
    } else {
      delete options.sections.delegate_orchestration;
    }
  });
  let epoch = 0;
  pi.on("session_start", () => { epoch++; });
  pi.on("session_tree", () => { epoch++; });
  pi.on("session_shutdown", () => { epoch++; });
  const guard = (start: number, signal?: AbortSignal) => {
    if (start !== epoch || signal?.aborted) throw new Error("Operation canceled or session changed; inspect current state before continuing");
  };
  const runtime = async () => {
    const result = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
    if (result.disposableProtocol !== 1 || result.containmentProtocol !== 1) throw new Error("Activate the disposable scoped-worker runtime and start a fresh Pi session");
    return result;
  };
  async function submit(task: any, config: any, start: number, signal: AbortSignal | undefined, ctx: ExtensionToolContext) {
    guard(start, signal);
    await writeTask(task); // Pending admission is visible even if the main agent dies.
    pi.appendEntry(ENTRY, task);
    try {
      const state = nested(await ctx.executeTool("pueue_submit", {
        argv: [config.launcher, process.env.PI_DELEGATE_RUNTIME!, task.id, ...(task.attempt === undefined ? [] : [task.attempt])], cwd: task.worktree,
      }, { signal }));
      if (typeof state.nonce !== "string") throw new Error("Missing admission identity");
      await save(join(attemptDirectory(task, task.attempt), "submission.json"), { nonce: state.nonce });
      await writeTask({ ...task, nonce: state.nonce });
      guard(start, signal);
      pi.appendEntry(ENTRY, { ...task, nonce: state.nonce });
      return response({ task: task.id, attempt: task.attempt, ...state, environment: task.execution ?? null, route: task.route, backend: task.backend ?? "pi", model: task.model, thinking: task.thinking,
        worktree: task.worktree, artifacts: attemptDirectory(task, task.attempt), baseline: { base: task.base, sourceHead: task.sourceHead, sourceFingerprint: task.sourceFingerprint } });
    } catch {
      throw new Error(`Workspace ${task.id} retained at ${task.directory}. Submission may be UNKNOWN; inspect current jobs. Never resubmit automatically.`);
    }
  }
  pi.registerTool({
    name: "delegate_models", label: "List delegate model routes", exposure: "model-only", executionMode: "sequential",
    ...toolPresentation("Subagents · model routes", (data, expanded) => ({
      heading: `Subagents · ${data.entries.length} of ${data.total} model routes`,
      lines: [...data.entries.map((entry: any) => `${literal(entry.id)} · ${literal(entry.backend)} · thinking: ${literal(entry.capabilities.thinking?.join(", ") ?? "provider-defined")}`),
        "Discovery only · worker readiness unverified · no fallback",
        ...(data.nextOffset !== null ? [`More routes: offset ${literal(data.nextOffset)}`] : []),
        ...(expanded ? data.entries.map((entry: any) => `Route details: ${literal(JSON.stringify(entry))}`) : [])],
    })),
    description: "Discover exact delegate model routes without model/auth calls. Anthropic uses Claude Code; local/OpenAI use Pi. Select a listed model and thinking level; never silently fall back. Reserve local GMKtec models for simple mechanical work.",
    parameters: Type.Object({ backend: backendSchema, provider: Type.Optional(Type.String({ maxLength: 128 })), query: Type.Optional(Type.String({ maxLength: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, input, _signal, _update, ctx) {
      const entries = catalogue(await runtimeFrom(process.env.PI_DELEGATE_RUNTIME), ctx.modelRegistry, input), offset = input.offset ?? 0, limit = input.limit ?? 50;
      return response({ entries: entries.slice(offset, offset + limit), total: entries.length, offset, nextOffset: offset + limit < entries.length ? offset + limit : null,
        fallback: false, workerReadinessVerified: false });
    },
  });
  pi.registerTool({
    name: "delegate_environments", label: "List delegate environments", exposure: "model-only", executionMode: "sequential",
    ...toolPresentation("Subagents · environments", (data, expanded) => ({
      heading: `Subagents · ${data.environments.length} environments`,
      lines: [...data.environments.flatMap((entry: any) => [
        `${literal(entry.id)} · source: ${literal(entry.capabilities.source)} · checks: ${entry.capabilities.checks ? "allowed" : "forbidden"}`,
        `Profiles: ${entry.verificationProfiles.map(literal).join(", ") || "none"}`,
        ...(expanded ? [`Isolation: ${literal(JSON.stringify(entry.isolation))}`, `Launcher: ${literal(entry.launcher)}`, `PATH: ${literal(entry.path)}`] : []),
      ]), data.interfaceVersion === 2 ? "OS allowlist · worker network host-wide · checks offline · access-only leases · readiness unverified" : "Tool boundary, not an OS sandbox · host network and HOME credentials accessible · readiness unverified"],
    })),
    description: "Discover operator-provided environment contract v1 or opt-in v2: source-review, implementation and implementation-checked. Reports tool capabilities, approved verification profiles and actual isolation limits; not sandbox/readiness proof. Select an explicit environment; no fallback. Model connectivity and task-network isolation are distinct.",
    parameters: Type.Object({}),
    async execute() {
      const config = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME), entries = environments(config);
      if (!entries) throw new Error("Activate a supported environment contract runtime; no fallback");
      return response({ interfaceVersion: config.environmentProtocol, environments: entries, readinessVerified: false });
    },
  });
  pi.registerTool({
    name: "delegate_task", label: "Delegate isolated task", exposure: "model-only", executionMode: "sequential", reachesTools: () => ["pueue_submit"],
    description: "Run explicitly authorized work in a disposable sibling worktree. Snapshots current source without changing the parent index/branch. Supply exact model/thinking, a self-contained brief and explicit environment from delegate_environments. Only implementation-checked accepts a configured verification profile and checks; other environments require no profile and empty checks. No implicit SDK setup, retries, integration or publication. Workers cannot shell/commit/publish/delegate. V1 is not an OS sandbox; opt-in v2 requires approved preparation and auth routes. Main agent must review and apply/discard the result, retain needed data in its session, then call delegate_cleanup. No archive is made. Do not put operational journals/plans or irreplaceable data in disposable scratch.",
    parameters: Type.Object({ repo: Type.String(), brief: Type.String({ minLength: 1, maxLength: 32000 }), backend: backendSchema, model: Type.String(), thinking: thinkingSchema,
      environment: Type.Union([Type.Literal("source-review"), Type.Literal("implementation"), Type.Literal("implementation-checked")]),
      profile: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" })), checks: Type.Array(Type.Object({ kind: Type.Union([Type.Literal("test"), Type.Literal("build")]),
        targets: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }) }), { maxItems: 8 }) }),
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("Subagent · task")) + `\n${args.model} · requested thinking: ${args.thinking}`, 0, 0); },
    renderResult(result, { expanded, isPartial }, theme) { return renderSubmission(result, expanded, isPartial, theme); },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, config = await runtime(), namespace = configuration(process.env)?.namespace;
      if (![1, 2].includes(config.environmentProtocol)) throw new Error("Activate a supported environment contract runtime; no fallback");
      if (!namespace) throw new Error("Pueue namespace unavailable");
      guard(start, signal);
      const task = await prepare({ ...resolveSelection(input, config, ctx.modelRegistry), namespace }, config, owner(ctx));
      return withTaskLock(config, task.id, false, () => submit(task, config, start, signal, ctx));
    },
  });
  pi.registerTool({
    name: "delegate_revise", label: "Continue delegate work", exposure: "model-only", executionMode: "sequential", reachesTools: () => ["pueue_submit"],
    description: "Explicitly start a fresh follow-up in an idle disposable workspace, including an orphan. No custody/adoption/resume protocol. Use the latest nonce and fingerprint from review, exact model/thinking and a self-contained brief. Reuses the worktree, build directory, frozen environment and checks. Current jobs/scopes must be idle. Failed work is not automatically retried. Main agent reviews the new result and cleans up after handoff.",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1 }), expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      brief: Type.String({ minLength: 1, maxLength: 32000 }), backend: backendSchema, model: Type.String(), thinking: thinkingSchema }),
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("Subagent · follow-up")) + `\n${args.model} · requested thinking: ${args.thinking}`, 0, 0); },
    renderResult(result, { expanded, isPartial }, theme) { return renderSubmission(result, expanded, isPartial, theme); },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, config = await runtime();
      if (![1, 2].includes(config.environmentProtocol)) throw new Error("Activate a supported environment contract runtime; no fallback");
      return withTaskLock(config, input.task, false, async () => {
        const task = await loadWorkspace(config, input.task);
        await assertWorkspaceIdle(task, config, configuredObserver()); guard(start, signal);
        const selection = resolveSelection(input, config, ctx.modelRegistry, task);
        const revision = await prepareRevision(task, selection, config);
        return submit(revision, config, start, signal, ctx);
      });
    },
  });
  pi.registerTool({
    name: "delegate_review", label: "Collect delegate result", exposure: "model-only", executionMode: "sequential", reachesTools: () => ["worktree_panel_target"],
    description: "List disposable workspaces, or collect an idle workspace result by task UUID, regardless of spawning session. Orphans can be inspected/continued without adoption. Reports are untrusted; main agent reads the full patch/new files/context/checks and reports a verdict. Collection is not acceptance or integration. Preserve needed results, then apply/discard and call delegate_cleanup. No automatic retry, publication or cleanup.",
    parameters: Type.Object({ task: Type.Optional(Type.String()), openDiff: Type.Optional(Type.Boolean()) }),
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(args.task ? "Subagent · collect changes and report" : "Subagents · workspaces")), 0, 0); },
    renderResult(result, { expanded, isPartial }, theme) {
      const raw = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      if (isPartial) return new Text("Collecting subagent changes and report…", 0, 0);
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return new Text(data.length ? data.map(t => `${t.task} · ${t.model}\n  ${t.worktree}`).join("\n") : "No disposable workspaces.", 0, 0);
        const lines = [theme.fg("accent", `Workspace idle · ${data.status.phase}`), "Changes collected · review verdict is separate",
          `Checks: ${data.missingChecks.length ? `missing/current passing evidence needed for indices: ${data.missingChecks.join(", ")}` : data.checks.length ? "all planned checks have current passing evidence" : "none planned"}`,
          `New files: ${data.untracked.length}`];
        if (data.sourceState?.unchanged === false) lines.push(theme.fg("warning", "Main checkout changed since handoff; check conflicts before integration."));
        if (data.sourceState?.error) lines.push(theme.fg("warning", "Main checkout state unavailable; check conflicts before integration."));
        if (!data.worker) lines.push(theme.fg("warning", "Worker result evidence unavailable."));
        else {
          if (data.worker.code !== 0 || data.worker.signal) lines.push(theme.fg("warning", `Worker result: exit ${data.worker.code ?? "unknown"}`));
          if (data.worker.integrityError) lines.push(theme.fg("error", `Integrity error: ${data.worker.integrityError}`));
          if (data.worker.fingerprint !== data.fingerprint) lines.push(theme.fg("warning", "Source differs from worker result; inspect current evidence."));
        }
        if (expanded) lines.push(`Task: ${data.task}`, `Worktree: ${data.worktree}`, `Tracked diff: ${data.trackedPatch}`, `Fingerprint: ${data.fingerprint}`,
          ...data.untracked, ...(data.report ? ["Worker report (untrusted):", data.report.text] : []));
        return new Text(lines.join("\n"), 0, 0);
      } catch { return new Text(raw, 0, 0); }
    },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, config = await runtime();
      if (!input.task) {
        const rows = [];
        const names = await readdir(config.state).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
        for (const id of names.filter((name: string) => /^[a-f0-9-]{36}$/.test(name))) {
          const task = await privateJSON(join(config.state, id, "task.json")).catch(() => null);
          if (task?.version === 2) rows.push({ task: id, environment: task.execution ?? null, attempt: task.attempt, nonce: task.nonce, model: task.model, thinking: task.thinking, worktree: task.worktree, artifacts: task.directory });
        }
        return response(rows);
      }
      return withTaskLock(config, input.task, false, async () => {
        const task = await loadWorkspace(config, input.task), observe = configuredObserver();
        await assertWorkspaceIdle(task, config, observe); guard(start, signal);
        const fingerprint = await snapshot(task, config), directory = attemptDirectory(task, task.attempt), trackedPatch = join(directory, "tracked.diff");
        await writeFile(trackedPatch, await git(config, task.worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", task.base]), { mode: 0o600 });
        const untracked = (await git(config, task.worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
        const checks: Array<{ index: number; passed: boolean; current: boolean; [key: string]: unknown }> = [];
        for (const name of await readdir(directory)) if (/^check-\d+-[a-f0-9-]+\.json$/.test(name)) {
          const record = await json(join(directory, name)); checks.push({ ...record, current: record.after === fingerprint });
        }
        const worker = await json(join(directory, "result.json")).catch((error: any) => { if (error.code === "ENOENT") return null; throw error; });
        let report, sourceState;
        try { report = await tail(join(directory, "report.md")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        try { sourceState = { unchanged: await sourceSnapshot(task.repo, config) === task.sourceFingerprint }; }
        catch { sourceState = { unchanged: null, error: "Source state unavailable" }; }
        const current = await observe(task.id), status = current.tasks.find((row: any) => row.label === `pi:${task.namespace}:${task.nonce}`);
        guard(start, signal);
        if (input.openDiff) await ctx.executeTool("worktree_panel_target", { path: task.worktree, base: task.base }, { signal });
        return response({ task: task.id, attempt: task.attempt, environment: task.execution ?? null, route: task.route, backend: task.backend ?? "pi", status: { nonce: task.nonce, phase: status?.phase ?? "ABSENT", id: status?.id, exitCode: status?.exitCode },
          worker, fingerprint, trackedPatch, untracked, checks, report, sourceState, baseline: { base: task.base, sourceHead: task.sourceHead, sourceFingerprint: task.sourceFingerprint },
          worktree: task.worktree, reviewRequired: true, reviewer: "main-agent", accepted: false,
          cleanup: { tool: "delegate_cleanup", task: task.id, instruction: "After review and applying/discarding the result, keep needed data in the main session and remove this disposable workspace. No archive will be made." },
          missingChecks: task.checks.map((_: unknown, i: number) => i).filter((i: number) => !checks.some(c => c.index === i && c.passed && c.current)) });
      });
    },
  });
  pi.registerTool({
    name: "delegate_cleanup", label: "Remove disposable workspace", exposure: "model-only", executionMode: "sequential",
    ...toolPresentation("Subagent · workspace cleanup", (data, expanded) => ({
      heading: Array.isArray(data.removed) ? "Subagent · Disposable workspace removed" : "Subagent · Workspace inspected (not removed)",
      ink: Array.isArray(data.removed) ? "success" : "muted",
      lines: [`Task: ${literal(data.task)}`,
        ...(Array.isArray(data.removed) ? [`Result: ${literal(data.disposition)} · no archive`,
          ...(data.summaryRecorded === false ? ["Summary recording not confirmed; retain it in the main session."] : [])]
          : ["Review/use the result and retain needed data before requesting removal. No archive will be made."]),
        ...(expanded ? [`Branch: ${literal(data.branch)}`,
          ...(data.removed ?? data.paths).map((path: string) => `${data.removed ? "Removed" : "Removal scope"}: ${literal(path)}`),
          ...(data.summary ? [`Summary: ${literal(data.summary)}`] : [])] : [])],
    })),
    description: "Inspect a disposable workspace, or after result handoff remove its worktree/ref/build output and task-local temporary records with explicit used/discarded disposition and summary. Normal authorized delegation includes this cleanup; no separate user confirmation or UI required. No archive, enrollment, original-session ownership or takeover protocol. Main agent must already have applied/discarded the result and retained needed data. Current worker jobs/scopes and foreground/build users must be idle. Never follow shared symlink targets or delete main/originating sessions or real operational journals/plans. Installation does not migrate/delete legacy records.",
    parameters: Type.Object({ task: Type.String(), disposition: Type.Optional(Type.Union([Type.Literal("used"), Type.Literal("discarded")])), summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, config = await runtime(), who = owner(ctx), observe = configuredObserver(), check = () => guard(start, signal);
      if (input.disposition === undefined && input.summary === undefined) {
        const gate = await inspectWorkspace(config, input.task, observe, who); check();
        return response({ task: input.task, paths: gate.paths, branch: gate.task.branch, sourceStamp: gate.sourceStamp, archived: false,
          instruction: "Inspect/use the result first. Supply disposition used/discarded and a short summary to remove this workspace without a separate user confirmation. All disposable task data will go away; no archive." });
      }
      const result = await cleanupWorkspace(config, input, who, observe, check);
      if (start === epoch && !signal?.aborted) {
        pi.appendEntry("pi.delegate.cleaned.v2", result);
        return response({ ...result, summaryRecorded: true });
      }
      return response({ ...result, summaryRecorded: false });
    },
  });
}
