import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { catalogue, resolveSelection } from "./catalogue.mjs";
import { Backend, configuration } from "../pueue/backend.ts";
import { matching, view } from "../pueue/state.ts";
import { assessReconciliation, transferReconciliation, reconciliationSummary, reconciliationAuthorization, assertCustody, reconciledStatus } from "./reconcile.mjs";
import { assertStopped } from "./containment.mjs";
import { recoveryAuthorization, recoveryGate, prepareRecovery } from "./recovery.mjs";
import { disposalGate, disposalAuthorization, disposeTask } from "./dispose.mjs";
import { assessCleanup, cleanupEvidence } from "./cleanup.mjs";
import { assessRetirement, retirementAuthorization, retireTask, retirementBackendObservation } from "./retire.mjs";
import { assessAutomaticEnrollment, automaticEnrollmentAuthorization, enrollAutomaticRetention, configuredAutomaticObserver } from "./automatic-retention.mjs";
import { assessPrune, pruneExpectedEvidence, pruneAuthorization, pruneTask, compactDisposalClaim } from "./prune.mjs";
import { finalizationAttempts, finalizationGate, finalizationAuthorization, finalizeTask, finalizationRequest } from "./finalize.mjs";
import { feedbackChoices, feedbackRequest, feedbackTask, validateFeedback, writeFeedback } from "./feedback.mjs";
import { ENTRY, initiatorLabel, prepare, prepareRevision, attemptDirectory, runtimeFrom, tasksFrom, json, lifecycleJSON, digest, snapshot, sourceSnapshot, git, tail } from "./core.mjs";

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
  const custodian = task?.custodian ?? task?.owner;
  if (!task || custodian.session !== who.session || custodian.file !== who.file) throw new Error("Task is not owned by this active session branch");
  return task;
}
export default function (pi: ExtensionAPI) {
  let epoch = 0;
  pi.on("session_start", () => { epoch++; });
  pi.on("session_tree", () => { epoch++; });
  pi.on("session_shutdown", () => { epoch++; });
  const guard = (start: number) => { if (start !== epoch) throw new Error("Session changed; retain artifacts and reconcile, never automatically retry"); };
  const observeReconciliation = async (job: any) => {
    const config = configuration(process.env);
    if (!config || config.namespace !== job.namespace) throw new Error("Original Pueue namespace unavailable; reconciliation blocked");
    const backend = new Backend(config);
    await backend.check();
    const tasks = await backend.tasks();
    if (tasks.some(t => (t.id === job.id || t.label === job.label)
      && (t.id !== job.id || t.label !== job.label || t.created !== job.created))) {
      throw new Error("Original backend identity reused/replaced; reconciliation blocked");
    }
    return matching(job, tasks) ? view(job, tasks) : null;
  };
  const observeRetirement = async (job: any) => retirementBackendObservation(job, await configuredAutomaticObserver()());
  const authority = async (task: any, ctx: ExtensionContext, foreground = false) => {
    await assertCustody(task, owner(ctx));
    if (task.reconciliationId && !foreground) throw new Error("Reconciled custody permits foreground review/editing only; worker revision/recovery remain disabled; cleanup requires its own confirmed lifecycle operation");
  };
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
    name: "delegate_retention_enroll", label: "Enroll closed delegate payloads for automatic expiry", exposure: "model-only", executionMode: "sequential",
    description: "One-time opt-in enrollment of explicitly selected completed delegate recovery/build payloads under a configured automatic retention policy. Read-only without expectedEvidence. Fresh exact-task UI confirmation seals content/metadata and reserves the disposal slot. Weekly expiry then needs no further dialog: 7-day builds, 30-day recovery, measured from closure. No active worktrees, legacy identity, interrupted claims, changed/shared/protected payloads or task-root purge. Audit records and original sessions stay. Skips are re-assessed at the next schedule; interrupted claims are never resumed automatically.",
    parameters: Type.Object({ task: Type.String({ pattern: "^[a-f0-9-]{36}$" }), repository: Type.String(),
      selections: Type.Array(Type.Union([Type.Literal("build-output"), Type.Literal("recovery")]), { minItems: 1, maxItems: 2 }),
      inventoryOffset: Type.Optional(Type.Integer({ minimum: 0 })), inventoryLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      expectedEvidence: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, who = owner(ctx), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const check = () => { guard(start); if (signal?.aborted || owner(ctx).session !== who.session || owner(ctx).file !== who.file) throw new Error("Automatic enrollment canceled or session changed"); };
      check();
      const observe = configuredAutomaticObserver();
      const gate = await assessAutomaticEnrollment(runtime, input, who, observe);
      check();
      const inventoryRows = Object.entries(gate.seals).flatMap(([group, rows]: [string, any]) => rows.map((row: any) => ({ group, ...row })));
      const offset = input.inventoryOffset ?? 0, limit = input.inventoryLimit ?? 50;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid enrollment inventory page");
      if (input.expectedEvidence === undefined) return response({ task: gate.task.id, repository: gate.closure.repository, policy: gate.policy,
        expectedEvidence: gate.evidence, selections: input.selections, deadlines: gate.deadlines, observation: gate.observation,
        inventory: Object.fromEntries(Object.entries(gate.seals).map(([group, rows]: [string, any]) => [group, { entries: rows.length, sha256: digest(JSON.stringify(rows)) }])),
        inventoryOffset: offset, inventoryLimit: limit, inventoryEntries: inventoryRows.slice(offset, offset + limit),
        nextInventoryOffset: offset + limit < inventoryRows.length ? offset + limit : null,
        authority: "enrollment-assessment-only", instruction: "Follow inventory pages until nextInventoryOffset is null with unchanged expectedEvidence. Inspect every selected payload and protected operational content. Confirm idleness and investigate process-visibility gaps. Explicitly authorize automatic irreversible loss of these sealed payloads after the displayed deadlines; overdue payloads can expire on the first scheduled run. Then supply expectedEvidence for fresh UI confirmation. No deletion/enrollment occurred; logs, original sessions, identity and audit stay." });
      if (input.expectedEvidence !== gate.evidence) throw new Error("Automatic enrollment assessment changed");
      if (!ctx.hasUI) throw new Error("Automatic enrollment requires fresh interactive confirmation");
      const approved = await ctx.ui.confirm("Authorize automatic expiry of these closed delegate payloads?", [
        `Task: ${gate.task.id}`, `Repository: ${gate.closure.repository.main}`, `Policy: ${gate.policy.id}`, `Groups: ${input.selections.join(", ")}`,
        `Deadlines (UTC): ${JSON.stringify(gate.deadlines)}`, `Evidence: ${gate.evidence}`,
        `Enrolled host identity hash: ${gate.observation.hostIdentity}`, `Current boot: ${gate.observation.bootId}; permission-limited PIDs: ${gate.observation.uninspectablePids.join(", ") || "none"}`,
        "One-time enrollment reserves the permanent disposal slot. Weekly unattended expiry irreversibly deletes exactly these sealed payloads, WITHOUT ANOTHER DIALOG. Already overdue data may expire on the first run. Recovery deletion has no replacement archive.",
        "Confirm all originating/custodian/foreground/build users and workers/descendants are idle, visibility gaps independently investigated, and protected operational content inspected. Do not borrow or modify enrolled payloads; changed data will be skipped.",
        "Preserve Mailhub plans/approved sets/Trash journals and unknown outcomes. No provider action, task-root purge, original-session/log deletion, source edit, worker start or custody transfer. Enrollment is not new terminal/stopped proof.",
        "A different host, new same-boot visibility gaps/PID identities, active/unknown jobs, changed data or partial claims cause skips. A real later boot on this prospectively enrolled host still permits expiry of unchanged closed data; it does not upgrade old worker evidence. No automatic claim clearing, re-enrollment or retry. Audit stays.",
      ].join("\n"));
      if (!approved) throw new Error("Automatic enrollment not authorized");
      check();
      return response(await enrollAutomaticRetention(runtime, input, who, observe, automaticEnrollmentAuthorization(gate, who), check));
    },
  });
  pi.registerTool({
    name: "delegate_retire", label: "Assess or confirm operator-attested delegate retirement", exposure: "model-only", executionMode: "sequential",
    description: "Opt-in archive-only discard of obsolete prior-boot/uncontained delegates and complete revision chains. Not verified terminal/stopped evidence: independently establish idleness. Exact admissions, fresh backend/process checks and per-task UI confirmation required. Read-only without both expected fields. Archives source/local/ignored files before worktree/ref removal. Active/unknown jobs, unresolved claims and protected evidence block. No retry, custody, workers or payload disposal; history, recovery and builds remain.",
    parameters: Type.Object({ task: Type.String({ pattern: "^[a-f0-9-]{36}$" }), repository: Type.String({ description: "Absolute canonical main checkout" }),
      reason: Type.String({ minLength: 1, maxLength: 1000, description: "Explicit discard rationale, not a claim of successful integration. No secrets." }),
      expectedEvidence: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      expectedFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, who = owner(ctx), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const check = () => {
        guard(start);
        if (signal?.aborted || owner(ctx).session !== who.session || owner(ctx).file !== who.file) throw new Error("Retirement canceled or session changed");
      };
      check();
      const committing = input.expectedEvidence !== undefined || input.expectedFingerprint !== undefined;
      if (committing && (!input.expectedEvidence || !input.expectedFingerprint)) throw new Error("Supply both expected fields from a fresh retirement assessment");
      const gate = await assessRetirement(runtime, input, who, observeRetirement);
      check();
      if (!committing) return response({ task: gate.task.id, repository: gate.repository, worktree: gate.task.worktree, branch: gate.task.branch,
        reason: input.reason, expectedEvidence: gate.evidence, expectedFingerprint: gate.fingerprint,
        attempts: gate.attempts.map((row: any) => ({ attempt: row.attempt, nonce: row.nonce, backend: row.backend,
          containmentRecorded: row.containment !== null, workerResultRecorded: row.result !== null })),
        observation: gate.observation, localFiles: gate.archive.files.map((file: any) => file.name), localBytes: gate.archive.bytes,
        authority: gate.authority, backendAuthority: false, terminalVerified: false, stoppedProof: false,
        instruction: "Assessment only. Inspect the complete retained draft and every local/ignored file, existing feedback and all attempt history. Independently establish that owners/custodians, old clients, workers/descendants and external build servers are idle. Process observations are NOT stopped proof; historical evidence may be incomplete. Explicitly authorize discarding this exact obsolete task, retaining recovery/build/evidence. Supply both expected fields with the identical reason for fresh UI confirmation. No removal, custody transfer or retry is authorized by assessment." });
      if (input.expectedEvidence !== gate.evidence || input.expectedFingerprint !== gate.fingerprint) throw new Error("Retirement assessment changed; inspect again");
      if (!ctx.hasUI) throw new Error("Operator-attested retirement requires fresh interactive confirmation");
      const approved = await ctx.ui.confirm("Retire this obsolete delegate WITHOUT verified historical stopped proof?", [
        `Task: ${gate.task.id}`, `Worktree: ${gate.task.worktree}`, `Branch: ${gate.task.branch}`, `Main repository: ${gate.repository.main}`,
        `Reason (JSON): ${JSON.stringify(input.reason)}`, `Receiving session: ${who.session}`, `Attempts: ${gate.attempts.length}`,
        `Evidence: ${gate.evidence}`, `Fingerprint: ${gate.fingerprint}`, `Current boot: ${gate.observation.bootId}`,
        "This is an operator-attested abandonment, NOT verified worker completion, successful integration or stopped-worker proof. Missing backend jobs and a reboot do not silently become proof.",
        `Processes with permission-limited observation: ${gate.observation.uninspectablePids.join(", ") || "none"}. Investigate these CURRENT identities independently before approving; this list may differ from the earlier assessment. The scan is not exhaustive stopped proof.`,
        `Confirmed process identities (PID/start time/command and cgroup hashes/visibility gaps): ${JSON.stringify(gate.observation.visibilityRecords)}`,
        "By approving, independently confirm: all originating/custodian sessions and old clients are idle; no worker or descendant survives; no external build server or foreground user can mutate this checkout. The process scan cannot prove this for unreferenced or uninspectable processes.",
        "Confirm you inspected the retained draft/local/ignored files and protected operational evidence. Preserve Mailhub plans/approved sets/Trash journals and unknown-outcome state; stop rather than authorize provider actions.",
        `Discard this obsolete draft. Archive ${gate.archive.files.length} local/ignored files (${gate.archive.bytes} bytes) plus a Git bundle at ${gate.task.directory}/retirement before worktree/ref removal.`,
        "All local bytes are preserved. Retirement alone permits up to 80 MiB when the exact ignored executable .cache/gobin/golangci-lint is present; other local content remains bounded to 64 MiB. No tool/cache file is omitted or deleted to evade archival.",
        "Original history/results/containment/claims, recovery, build outputs and logs stay. External symlink targets are untouched. No worker restart, custody, publication, permanent payload disposal or task-root purge.",
        "Permanent shared continuation and retirement claims fence cooperating updated clients. Partial failure remains blocked, with no claim clearing or automatic retry. Old clients must stay idle.",
      ].join("\n"));
      if (!approved) throw new Error("Operator-attested retirement not authorized");
      check();
      return response(await retireTask(runtime, input, who, observeRetirement, retirementAuthorization(gate, who, input.reason), check));
    },
  });
  pi.registerTool({
    name: "delegate_prune", label: "Later prune retained delegate artifacts", exposure: "model-only", executionMode: "sequential",
    description: "Separately opt-in later cleanup of a modern independently repository-bound original task only after a coherent completed delegate_dispose claim and receipt; legacyRecovery never enables it. No custody transfer, worker/provider/process action, task-root purge or retry. Read-only without expected fields; confirmation binds this receiving session, exact metadata/content-hash inventory, completed disposal/finalization history and fresh terminal/stopped evidence. Only documented payloads, diagnostic/review content and task-local worker transcripts are candidates. Unknown/protected evidence, external initiating/custodian sessions, summaries, claims and lifecycle identity remain retained.",
    parameters: Type.Object({ task: Type.String({ pattern: "^[a-f0-9-]{36}$" }), repository: Type.String({ description: "Absolute canonical main checkout; never inferred from cwd" }),
      selections: Type.Array(Type.Union([Type.Literal("build-output"), Type.Literal("recovery"), Type.Literal("diagnostics")]), { maxItems: 3 }),
      inventoryOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Read-only exact-inventory page offset; default 0." })),
      inventoryLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Inventory rows per assessment page; default 50." })),
      compactDisposalClaim: Type.Optional(Type.Boolean({ description: "Separate audit-inventory compaction only; selections must be empty. Replaces the completed disposal claim with a durable tombstone, never removes it." })),
      expectedNonce: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), expectedEvidence: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      expectedFinalization: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })), expectedInventory: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, who = owner(ctx), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const check = () => { guard(start); if (signal?.aborted || owner(ctx).session !== who.session || owner(ctx).file !== who.file) throw new Error("Retention prune canceled or session changed"); };
      if (input.compactDisposalClaim ? input.selections.length !== 0 : input.selections.length === 0) throw new Error("Compaction is separate and has no payload selection; pruning requires explicit retained payload groups");
      const committing = [input.expectedNonce, input.expectedEvidence, input.expectedFinalization, input.expectedInventory].some(value => value !== undefined);
      if (committing && (!input.expectedNonce || !input.expectedEvidence || !input.expectedFinalization || !input.expectedInventory)) throw new Error("Supply all expected fields from a fresh retention assessment");
      check();
      const gate = await assessPrune(runtime, input, observeReconciliation);
      const expectedFinalization = digest(JSON.stringify(gate.task.finalized));
      const expectedEvidence = pruneExpectedEvidence(gate, input, { session: who.session, file: who.file });
      check();
      const offset = input.inventoryOffset ?? 0, limit = input.inventoryLimit ?? 50;
      const page = gate.files.slice(offset, offset + limit);
      const retainedGroups = Object.fromEntries(Object.entries(gate.retainedGroups).map(([group, value]: [string, any]) =>
        [group, { present: value.present, entries: value.entries, allocatedBytes: value.allocatedBytes, pathsDigest: digest(JSON.stringify(value.paths)) }]));
      if (!committing) return response({ task: gate.task.id, repository: gate.proof.repository, selections: input.selections,
        compactDisposalClaim: input.compactDisposalClaim === true, availableGroups: gate.availableGroups, retainedGroups,
        entries: gate.files.length, inventoryOffset: offset, inventoryLimit: limit,
        nextInventoryOffset: offset + limit < gate.files.length ? offset + limit : null,
        paths: page.map((row: any) => row.path), inventoryEntries: page,
        allocatedBytes: gate.allocatedBytes, filesystemBefore: gate.filesystemBefore, compaction: gate.compaction,
        expectedNonce: gate.task.nonce, expectedFinalization, expectedInventory: gate.inventory, expectedEvidence,
        predecessor: gate.predecessor, authority: "retention-cleanup-only", backendAuthority: false,
        instruction: "Assessment only. Exact inventory/content hashes are paginated; follow nextInventoryOffset until null and require the same expectedInventory digest across pages. UI display summarizes paths. Arbitrary build/archive content still requires operator inspection. Confirm original/custodian/foreground/external-build users are idle, then supply every returned expected field in this same receiving session. Unknown files, sessions and lifecycle records remain retained." });
      if (input.expectedNonce !== gate.task.nonce || input.expectedFinalization !== expectedFinalization || input.expectedInventory !== gate.inventory || input.expectedEvidence !== expectedEvidence) throw new Error("Retention assessment changed; inspect again before confirmation");
      if (!ctx.hasUI) throw new Error("Retention prune requires fresh interactive confirmation");
      const approved = await ctx.ui.confirm(input.compactDisposalClaim ? "Compact completed delegate disposal audit inventory?" : "Permanently prune later retained delegate artifacts?", [
        `Task: ${gate.task.id}`, `Receiving session: ${who.session}`, `Repository: ${gate.proof.repository.main}`, `Finalization: ${expectedFinalization}`,
        `Exact inventory: ${gate.inventory}`, `Selections: ${input.compactDisposalClaim ? "disposal-claim audit compaction only" : input.selections.join(", ")}`,
        `Candidate paths (${gate.files.length}): ${gate.files.slice(0, 20).map((row: any) => row.path).join(", ")}${gate.files.length > 20 ? " … (see full assessment inventory)" : ""}`,
        `Observed allocated blocks: ${gate.allocatedBytes}; filesystem available bytes: ${gate.filesystemBefore.availableBytes}. Unlinking is not guaranteed free-space reclamation.`,
        ...(input.compactDisposalClaim ? ["This irreversibly destroys the old disposal claim's per-file paths/stamps/targets/allocation details while preserving its original operation identity and non-file proof fields."] : ["Operator inspection is mandatory for arbitrary build/archive content; allowlist heuristics do not prove absence of mail or unknown-outcome state."]),
        "Confirm originating/custodian/foreground sessions and external build users are idle. Fresh containment does not fence arbitrary foreground work.",
        "Preserve real-mail plans/approved sets/Trash journals and unknown-outcome evidence. Stop for protected content; no provider action is authorized.",
        "No task root, original Pi/Claude session, owner session file, lifecycle identity, finalization/disposal receipt or external symlink target is deleted. Interrupted claims stay blocked and are never retried.",
      ].join("\n"));
      if (!approved) throw new Error("Retention prune not authorized");
      check();
      const caller = { session: who.session, file: who.file };
      const authorization = pruneAuthorization(gate, input, caller);
      const receipt = input.compactDisposalClaim
        ? await compactDisposalClaim(runtime, input, observeReconciliation, authorization, check, caller)
        : await pruneTask(runtime, input, observeReconciliation, authorization, check, caller);
      return response({ authority: "retention-cleanup-only", backendAuthority: false, ...receipt,
        next: "Later retained operations require a new assessment against this completed history. Do not clear or retry interrupted claims." });
    },
  });
  pi.registerTool({
    name: "delegate_cleanup", label: "Assess or confirm historical delegate cleanup", exposure: "model-only", executionMode: "sequential",
    description: "Historical original-task cleanup; no custody transfer or workers. Opt-in runtime, bound terminal review and fresh stopped/backend proof required. No expected fields: read-only assessment; returned fields request fresh interactive confirmation. Git identity required except separately enabled legacyRecovery recovery-only disposal. Revisions, uncertainty and partial claims block; no retry/claim clearing. Preserve sessions/audit and real-mail plans/Trash journals.",
    parameters: Type.Object({ task: Type.String({ pattern: "^[a-f0-9-]{36}$" }), repository: Type.String({ description: "Absolute canonical main checkout; never inferred from cwd" }),
      action: Type.Union([Type.Literal("finalize"), Type.Literal("dispose")]),
      legacyRecovery: Type.Optional(Type.Boolean({ description: "Recovery-only legacy exception: opt-in runtime required; historical repository identity stays unverified." })),
      disposition: Type.Optional(Type.Union([Type.Literal("integrated"), Type.Literal("discarded")])),
      selections: Type.Optional(Type.Array(Type.Union([Type.Literal("build-output"), Type.Literal("recovery")]), { minItems: 1, maxItems: 2 })),
      expectedNonce: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      expectedEvidence: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      expectedFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      expectedFinalization: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, who = owner(ctx), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const check = () => {
        guard(start);
        if (signal?.aborted || owner(ctx).session !== who.session || owner(ctx).file !== who.file) throw new Error("Cleanup canceled or session changed");
      };
      check();
      if (input.action === "finalize" ? (!input.disposition || input.selections !== undefined || input.expectedFinalization !== undefined)
        : (input.disposition !== undefined || input.expectedFingerprint !== undefined)) throw new Error("Use an explicit finalization disposition, or disposal selections; do not mix operations");
      const committing = [input.expectedNonce, input.expectedEvidence, input.expectedFingerprint, input.expectedFinalization].some(v => v !== undefined);
      if (committing && (!input.expectedNonce || !input.expectedEvidence || (input.action === "finalize"
        ? !input.expectedFingerprint : !input.expectedFinalization || !input.selections))) throw new Error("Supply all expected fields and the exact operation from a fresh cleanup assessment");
      const assessed = await assessCleanup(runtime, input, observeReconciliation), task = assessed.task;
      const context = { cleanupCaller: { session: who.session, file: who.file }, cleanupVerify: (current: any, claim?: string, disposal?: string) => cleanupEvidence(current, input, runtime, observeReconciliation, claim, disposal) };
      let request: any, gate: any;
      if (input.action === "finalize") {
        request = { task: task.id, expectedNonce: input.expectedNonce ?? task.nonce,
          expectedFingerprint: input.expectedFingerprint ?? assessed.fingerprint, disposition: input.disposition };
        gate = await finalizationGate(task, request, runtime, [], undefined, undefined, context);
      } else {
        request = { task: task.id, expectedNonce: input.expectedNonce ?? task.nonce,
          expectedFinalization: input.expectedFinalization ?? digest(JSON.stringify(task.finalized)), selections: input.selections ?? ["build-output", "recovery"],
          legacyRecovery: input.legacyRecovery === true };
        gate = await disposalGate(task, request, runtime, context);
      }
      const expectedEvidence = digest(JSON.stringify([who.session, who.file, input.action, request,
        gate.repository, gate.cleanupEvidence, gate.archiveFingerprint ?? gate.inventory]));
      check();
      if (!committing) return response({ task: task.id, action: input.action, repository: gate.repository,
        expectedNonce: task.nonce, expectedEvidence,
        ...(input.action === "finalize" ? { expectedFingerprint: assessed.fingerprint, disposition: request.disposition,
          worktree: task.worktree, localFiles: gate.local.files.length, localBytes: gate.local.bytes }
          : { expectedFinalization: request.expectedFinalization, selections: request.selections, entries: gate.files.length, allocatedBytes: gate.allocatedBytes }),
        authority: "cleanup-only", backendAuthority: false, legacyRecovery: gate.legacyRecovery ?? false,
        repositoryBinding: gate.legacyRecovery ? "operator-selected; historical identity unverified" : "verified",
        instruction: "Assessment only. Review this exact task and payload scope, then supply all returned expected fields and the same legacyRecovery mode for separate fresh confirmation. No custody transfer, worker start or deletion is authorized by assessment. Other identity/uncertainty barriers remain." });
      if (input.expectedEvidence !== expectedEvidence) throw new Error("Cleanup assessment changed; inspect again before confirmation");
      if (!ctx.hasUI) throw new Error("Cleanup requires fresh interactive confirmation");
      const approved = await ctx.ui.confirm(input.action === "finalize" ? "Archive and remove this historical delegate?"
        : gate.legacyRecovery ? "Irreversibly discard legacy recovery without historical repository identity?" : "Permanently delete selected historical delegate payloads?", [
        `Task: ${task.id}`, `Original source: ${task.repo}`,
        `${gate.legacyRecovery ? "Operator-selected current main repository (historical relationship UNVERIFIED)" : "Verified main repository"}: ${gate.repository.main}`,
        `Git directory: ${gate.repository.common}`, `Original nonce: ${task.nonce}`, `Evidence: ${expectedEvidence}`,
        ...(input.action === "finalize" ? [`Disposition: ${request.disposition} (not automatic integration proof)`, `Worktree: ${task.worktree}`, `Branch: ${task.branch}`,
          `Fingerprint: ${request.expectedFingerprint}`, `Archive: ${gate.local.files.length} local/ignored files (${gate.local.bytes} bytes), plus Git bundle. Build outputs, recovery, logs and audit records remain.`]
          : [`Selections: ${request.selections.join(", ")}`, `Finalization: ${request.expectedFinalization}`, `Entries: ${gate.files.length}; allocated bytes: ${gate.allocatedBytes}`,
            "No replacement archive. Recovery selection irreversibly removes the Git bundle and local-files archive; allocation is not guaranteed reclaimed free space."]),
        ...(gate.legacyRecovery ? ["LEGACY EXCEPTION: historical repository identity was not recorded. You explicitly authorize loss of only these finalized recovery copies despite that missing binding; this does not prove integration or grant authority over source/worktrees/builds.",
          `Exact archive directory: ${task.directory}/finalization`, "Only source.bundle and local-files.json are deleted. No old receipt or identity is rewritten."] : []),
        "Confirm all originating/custodian/foreground sessions and external build servers are idle. Worker containment does not fence arbitrary foreground activity.",
        "Preserve real-mail plans/sets and Trash journals. Stop if selected payloads contain operational evidence; no provider action or unknown-outcome override is authorized.",
        "Cleanup only: no foreground custody transfer, worker restart, publication, claim clearing or automatic retry. Interrupted operations stay blocked; sessions and audit records remain.",
      ].join("\n"));
      if (!approved) throw new Error("Historical cleanup not authorized");
      check();
      const result = input.action === "finalize"
        ? await finalizeTask(task, request, runtime, [], finalizationAuthorization(task, request, gate), check, undefined, context)
        : await disposeTask(task, request, runtime, context, disposalAuthorization(task, request, gate), check);
      return response({ action: input.action, authority: "cleanup-only", backendAuthority: false, ...result,
        next: "No custody was transferred. Assess again for any separately authorized next lifecycle operation; never retry an interrupted claim or delete a task directory." });
    },
  });
  pi.registerTool({
    name: "delegate_reconcile", label: "Reconcile retained delegate custody", exposure: "model-only", executionMode: "sequential",
    description: "Assess a retained original attempt across sessions using its private originating terminal tool record, exact admission identity and independent stopped cgroup proof. Task alone is read-only. With all expected fields, requires fresh interactive user confirmation to transfer foreground-only custody. No invented Pueue status, retry, worker start, integration, publication or cleanup. Revisions, conflicting evidence and pending claims fail closed. Review all changes/checks afterward; archived exit is not acceptance.",
    parameters: Type.Object({ task: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
      expectedNonce: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      expectedFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      expectedEvidence: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, who = owner(ctx), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      const check = () => {
        guard(start);
        if (signal?.aborted || owner(ctx).session !== who.session || owner(ctx).file !== who.file) throw new Error("Reconciliation canceled or session changed");
      };
      check();
      const committing = input.expectedNonce !== undefined || input.expectedFingerprint !== undefined || input.expectedEvidence !== undefined;
      if (committing && (!input.expectedNonce || !input.expectedFingerprint || !input.expectedEvidence)) throw new Error("Supply all three expected fields from the read-only assessment");
      const gate = await assessReconciliation(runtime, input, who, observeReconciliation);
      check();
      if (!committing) return response(reconciliationSummary(gate));
      if (input.expectedNonce !== gate.task.nonce || input.expectedFingerprint !== gate.fingerprint || input.expectedEvidence !== gate.evidenceDigest) throw new Error("Assessment changed; inspect again before confirmation");
      if (!ctx.hasUI) throw new Error("Reconciliation requires fresh interactive user confirmation");
      const approved = await ctx.ui.confirm("Transfer foreground custody of this stopped delegate?", [
        `Task: ${gate.task.id}`, `Original owner: ${gate.task.owner.session}`, `Receiving session: ${who.session}`,
        `Worktree: ${gate.task.worktree}`, `Original nonce: ${gate.task.nonce}`,
        `Evidence: ${gate.evidence.kind} · backend present: ${gate.current !== null}`,
        `Stopped proof: ${gate.stopped.observed}`, `Current fingerprint: ${gate.fingerprint}`,
        "Confirm the original session is idle: arbitrary foreground edits/checks are not covered by the worker cgroup or continuation claim.",
        "This permanently claims the original attempt for foreground review/editing only. No worker restart, acceptance, integration, publication or removal. Prior records stay unchanged.",
      ].join("\n"));
      if (!approved) throw new Error("Reconciliation not authorized");
      check();
      const result = await transferReconciliation(runtime, input, who, observeReconciliation, reconciliationAuthorization(input, who), check);
      check();
      pi.appendEntry(ENTRY, result.task);
      return response({ task: result.task.id, reconciliationId: result.receipt.id, restored: result.restored,
        worktree: result.task.worktree, artifacts: result.task.directory, authority: "foreground-only", accepted: false,
        next: "delegate_review, inspect all changes and current checks, then delegate_feedback. No automatic retry or cleanup." });
    },
  });
  pi.registerTool({
    name: "delegate_models", label: "List delegate model routes", exposure: "model-only", executionMode: "sequential",
    description: "List delegate model routes, filter by backend/provider/query, and paginate. Use an exact entry ID as model for task/revise; omit backend. Anthropic routes use Claude Code; local/OpenAI use Pi. Discovery only: no model calls or auth/readiness checks; listed routes may not work in the worker environment. Configured Pi admission policy can hide routes and constrain thinking; select only the listed routes/levels. Reserve GMKtec models for simple, well-specified mechanical work, not complex multi-file reasoning or policy alignment; choose any stronger route explicitly, never by automatic fallback.",
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
    description: "Start an explicitly authorized implementation task via Pueue in a retained sibling worktree, snapshotting staged/unstaged changes and nonignored new files without changing the source branch/index. Supply exact delegate_models ID, thinking, self-contained brief (scope, files, acceptance criteria, review complexity), configured profile and necessary checks. Anthropic requires Claude Code; local/OpenAI require Pi; no route guessing/fallback. Claude requires runtime.claude and effort low/medium/high/xhigh/max. No conflicts, submodules or sparse/assume-unchanged entries. Worker tools cannot shell, publish, commit or delegate; NOT an OS sandbox. Keep inputs secret-free. No automatic retry, integration, publication, cleanup or SDK setup; deployment choices and integration/publication require authorization. After completion use delegate_review, personally inspect all changes/context/checks and report a verdict; after review or terminal-failure investigation call delegate_feedback. Exit zero/report is not acceptance. Reconcile source drift before integration. UI already shows model/thinking/status; avoid redundant narration. Reserve GMKtec models for simple, well-specified mechanical work; use an explicitly selected stronger route for complex multi-file reasoning or policy alignment. Pi workers stop after 3 cumulative unavailable-tool calls and retain failure evidence; never retry automatically.",
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
    description: "Start one authorized revision in the owned task's same worktree/build directory, preserving changes/artifacts and frozen checks/profile, with fresh context. Requires confirmed EXITED/0, no cancellation/integrity error, latest nonce and current fingerprint from delegate_review. Supply self-contained brief, exact model ID and thinking; Anthropic requires Claude, local/OpenAI require Pi, no fallback. Claude effort: low/medium/high/xhigh/max. One continuation per prior attempt; uncertain/failed evidence blocks revision. No automatic retry, cleanup, publication or integration; not an OS sandbox. Review each attempt with delegate_review, then record delegate_feedback (also after terminal-failure investigation). Reserve GMKtec models for simple, well-specified mechanical work, not complex multi-file reasoning or policy alignment; select a stronger route explicitly, without automatic fallback.",
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
      await authority(task, ctx);
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
      await authority(task, ctx);
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
    description: "Record your own assessment after reviewing a terminal attempt's changes/context/checks or investigating failure; explicit foreground reconciliations retain archived provenance, never live backend authority. Bind task and exact nonce (historical attempts on this branch supported). Use partial/not_reviewed and not_assessed for incomplete evidence; exit zero is not review, KILLED is not proof descendants stopped. No prompts, file bodies or secrets. Append-only private record; supersedes corrects earlier feedback for the same attempt. Not acceptance, source verification, integration/publication or retry permission; no worker/worktree mutation.",
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
      await authority(task, ctx, true);
      const rows = task.reconciliationId ? [await reconciledStatus(task, runtime, who, observeReconciliation)]
        : nested(await ctx.executeTool("pueue_status", { nonce: task.nonce }, { signal }));
      await authority(task, ctx, true);
      const check = () => { guard(start); if (signal?.aborted) throw new Error("Feedback cancelled before recording"); };
      check();
      const recorded = await writeFeedback(runtime, task, input, rows,
        { session: who.session, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null }, check);
      return response({ ...recorded, finalization: finalizationRequest(task) });
    },
  });
  pi.registerTool({
    name: "delegate_finalize", label: "Finalize delegate task", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status"],
    description: "After review/feedback and authorized integration/discard, archive source/local files and remove the owned worktree/branch. Reconciled original attempts use bound archived terminal evidence, never invented backend status. Requires current reviewed fingerprint, terminal evidence and fresh independent stopped proof for EVERY attempt, plus fresh interactive user confirmation. Archives/build state remain; discarded does not mean permanent deletion. Use separately confirmed delegate_dispose for selected finalized payloads. Uncertainty/partial failures block retries. No automatic cleanup, integration or publication.",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1, maxLength: 200 }),
      expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      disposition: Type.Union([Type.Literal("integrated"), Type.Literal("discarded")]) }),
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Subagent · finalize task")) + `\nTask: ${args.task} · ${args.disposition}`, 0, 0);
    },
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, task = owned(ctx, input.task), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      await authority(task, ctx, true);
      const check = () => {
        guard(start);
        if (signal?.aborted || owned(ctx, input.task).nonce !== task.nonce) throw new Error("Finalization canceled or latest attempt changed");
      };
      check();
      if (!ctx.hasUI) throw new Error("Finalization requires fresh interactive user authorization");
      const statuses = async () => {
        if (task.reconciliationId) return []; // finalizationGate verifies archived evidence itself.
        const attempts = await finalizationAttempts(task, runtime), rows = [];
        for (const attempt of attempts) rows.push(...nested(await ctx.executeTool("pueue_status", { nonce: attempt.nonce }, { signal })));
        return rows;
      };
      const context = { who: owner(ctx), observe: observeReconciliation, statuses };
      const gate = await finalizationGate(task, input, runtime, await statuses(), undefined, undefined, context);
      check();
      const approved = await ctx.ui.confirm("Archive and remove this delegate worktree/branch?", [
        `Task: ${task.id}`, `Disposition: ${input.disposition} (caller declaration, not automatic merge verification)`,
        `Worktree: ${task.worktree}`, `Branch: ${task.branch}`, `Reviewed fingerprint: ${input.expectedFingerprint}`,
        `Recovery archive: ${gate.local.files.length} local files, including ignored files (${gate.local.bytes} bytes), plus Git bundle.`,
        `Retained evidence: ${task.directory}`, "Logs, checks, feedback and build state remain. This cannot be automatically retried after a partial failure.",
      ].join("\n"));
      if (!approved) throw new Error("Finalization not authorized; nothing removed");
      check();
      const authorization = finalizationAuthorization(task, input, gate);
      const receipt = await finalizeTask(task, input, runtime, await statuses(), authorization, check, undefined, context);
      pi.appendEntry(ENTRY, { ...task, finalized: receipt });
      return response({ finalized: true, ...receipt, expectedFinalization: digest(JSON.stringify(receipt)),
        next: "Recovery data and build outputs remain. Only after separate disposal approval use delegate_dispose with explicit selections; never delete the task directory." });
    },
  });
  pi.registerTool({
    name: "delegate_dispose", label: "Permanently dispose finalized payloads", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status"],
    description: "Permanently delete explicitly selected build-output and/or recovery payloads from a successfully finalized owned task. Task/nonce alone assesses read-only; supply expectedFinalization and selections to request fresh interactive confirmation. Recovery deletion is irreversible; logs, sessions, identity, claims and audit evidence remain. Requires fresh terminal/stopped evidence for every attempt; reconciled originals retain archived provenance. No task-root purge, symlink target deletion, retry of partial disposal, backend reset or provider action. One disposal claim per task: select the complete intended payload set together. Preserve real-mail plans/sets and Trash journals.",
    parameters: Type.Object({ task: Type.String(), expectedNonce: Type.String({ minLength: 1, maxLength: 200 }),
      expectedFinalization: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      selections: Type.Optional(Type.Array(Type.Union([Type.Literal("build-output"), Type.Literal("recovery")]), { minItems: 1, maxItems: 2 })) }),
    async execute(_id, input, signal, _update, ctx) {
      const start = epoch, task = owned(ctx, input.task), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      if (input.expectedNonce !== task.nonce) throw new Error("Latest nonce required");
      const check = () => {
        guard(start);
        if (signal?.aborted || owned(ctx, input.task).nonce !== task.nonce) throw new Error("Disposal canceled or session changed");
      };
      const receipt = await lifecycleJSON(join(task.directory, "finalized.json"));
      const expectedFinalization = digest(JSON.stringify(receipt));
      const context = { who: owner(ctx), observe: observeReconciliation, statuses: async () => {
        const rows = [];
        for (const attempt of await finalizationAttempts(task, runtime)) rows.push(...nested(await ctx.executeTool("pueue_status", { nonce: attempt.nonce }, { signal })));
        return rows;
      } };
      const committing = input.expectedFinalization !== undefined || input.selections !== undefined;
      if (committing && (!input.expectedFinalization || !input.selections)) throw new Error("Supply finalization digest and explicit selections together");
      const request = { ...input, expectedFinalization: input.expectedFinalization ?? expectedFinalization,
        selections: input.selections ?? ["build-output", "recovery"] };
      const gate = await disposalGate(task, request, runtime, context);
      check();
      if (!committing) return response({ task: task.id, expectedNonce: task.nonce, expectedFinalization,
        entries: gate.files.length, allocatedBytes: gate.allocatedBytes, availableSelections: ["build-output", "recovery"],
        instruction: "Assessment only, not deletion approval. Select all intended payload groups together for a separately confirmed one-shot operation. Logs/sessions/audit data remain; archived recovery can be permanently lost." });
      if (!ctx.hasUI) throw new Error("Permanent disposal requires fresh interactive confirmation");
      const approved = await ctx.ui.confirm("Permanently delete selected delegate payloads?", [
        `Task: ${task.id}`, `Directory: ${task.directory}`, `Selections: ${request.selections.join(", ")}`,
        `Finalization: ${expectedFinalization}`, `Entries: ${gate.files.length} · allocated bytes observed: ${gate.allocatedBytes}`,
        "Confirm all originating/foreground users and build servers are idle. Worker containment does not fence arbitrary foreground activity.",
        "No new archive is made. Selecting recovery permanently removes the Git bundle and local-files archive. Shared symlink targets, originating sessions, logs and audit evidence stay.",
        "If a selected payload contains real-mail plans/sets or Trash journals, stop and preserve that operational evidence; this grants no provider action or unknown-outcome override.",
        "This is one-shot; interruption/partial failure remains blocked for manual investigation, never an automatic retry.",
      ].join("\n"));
      if (!approved) throw new Error("Permanent disposal not authorized");
      check();
      return response(await disposeTask(task, request, runtime, context, disposalAuthorization(task, request, gate), check));
    },
  });
  pi.registerTool({
    name: "delegate_review", label: "Collect delegate changes", exposure: "model-only", executionMode: "sequential",
    reachesTools: () => ["pueue_status", "worktree_panel_target"],
    description: "Omit task to list this branch's owned tasks/nonces. With task UUID, collect untrusted report, worker-only trackedPatch, new files and current-fingerprint check evidence after Pueue EXITED (or KILLED with independently verified empty containment), or an explicit foreground reconciliation grant with archived provenance. openDiff optionally opens the panel. The main agent must review the entire trackedPatch, every untracked file, relevant context and current checks against the brief; report findings/verdict, then call delegate_feedback. Do not offload review to the user or rate incomplete evidence as reviewed/correct. If sourceState drifted/unavailable, recheck destination and reconcile before integration; never overwrite inherited work. Collection is not acceptance or an integration lease; exit zero proves neither. Ignored files are not certified. No polling, retry, integration or cleanup.",
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
            `Task: ${t.task}${t.attempt ? " (revision)" : ""}${t.finalized ? " · finalized" : ""}`,
            `  ${t.model ?? "model unavailable"} · requested thinking: ${t.thinking ?? "unknown"}`,
            ...(expanded ? [`  Pueue: ${t.nonce ?? "binding unavailable"}`, `  Worktree: ${t.worktree}`, `  Artifacts: ${t.artifacts}`] : []),
          ]) : ["No delegated tasks on this session branch."];
          return new Text(lines.join("\n"), 0, 0);
        }
        if (!data.task || !data.status) return new Text(raw, 0, 0);
        const missing = data.missingChecks ?? [], checks = data.checks ?? [], files = data.untracked ?? [];
        const lines = [
          theme.fg("accent", `Pueue #${data.status.id ?? "?"} · ${data.status.phase} · exit ${data.status.exitCode ?? "unknown"}`),
          ...(data.status.phase === "RECONCILED_EXITED" ? ["Archived terminal evidence · foreground-only custody · not live Pueue authority"] : []),
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
        return response([...tasksFrom(ctx.sessionManager.getBranch()).values()].filter((t: any) => (t.custodian ?? t.owner).session === who.session && (t.custodian ?? t.owner).file === who.file)
          .map((t: any) => ({ task: t.id, attempt: t.attempt, nonce: t.nonce, initiator: initiator(t), route: t.route, backend: t.backend ?? "pi", model: t.model, thinking: t.thinking, worktree: t.worktree, artifacts: attemptDirectory(t, t.attempt), finalized: t.finalized ?? null })));
      }
      const start = epoch;
      const task = owned(ctx, input.task), runtime = await runtimeFrom(process.env.PI_DELEGATE_RUNTIME);
      await authority(task, ctx, true);
      if (!task.nonce) throw new Error("Admission binding unavailable; reconcile originating Pueue history manually");
      const rows = task.reconciliationId ? [await reconciledStatus(task, runtime, owner(ctx), observeReconciliation)]
        : nested(await ctx.executeTool("pueue_status", { nonce: task.nonce }, { signal }));
      if (rows.length !== 1 || !["EXITED", "KILLED", "RECONCILED_EXITED"].includes(rows[0].phase)) throw new Error("Worker is not authoritatively terminal; retain evidence and do not retry");
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
      await authority(task, ctx, true);
      if (signal?.aborted) throw new Error("Review canceled");
      if (input.openDiff === true) await ctx.executeTool("worktree_panel_target", { path: task.worktree, base: task.base }, { signal });
      let report;
      try { report = await tail(join(directory, "report.md")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      let sourceState;
      if (task.sourceFingerprint) {
        try { sourceState = { unchanged: await sourceSnapshot(task.repo, runtime) === task.sourceFingerprint }; }
        catch { sourceState = { unchanged: null, error: "Source state unavailable" }; }
      }
      guard(start);
      await authority(task, ctx, true);
      return response({ task: task.id, attempt: task.attempt, initiator: initiator(task), route: task.route, backend: task.backend ?? "pi", status: rows[0], worker, fingerprint, trackedPatch, untracked, checks, report,
        baseline: { base: task.base, sourceHead: task.sourceHead ?? task.base, sourceFingerprint: task.sourceFingerprint ?? null }, sourceState,
        worktree: task.worktree, reviewRequired: true, reviewer: "main-agent", accepted: false,
        feedback: feedbackRequest(task), finalization: finalizationRequest(task),
        missingChecks: task.checks.map((_: unknown, i: number) => i).filter((i: number) => !checks.some(c => c.index === i && c.passed && c.current)) });
    },
  });
}
