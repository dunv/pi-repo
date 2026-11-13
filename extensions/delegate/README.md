# Thin delegated workers (v1)

Optional orchestration over this package's Pueue adapter and worktree panel.
No new daemon, scheduler, watcher, polling, automatic retry, merge or cleanup.
Loading this entry registers tools but starts no processes. Execution requires an
explicit `PI_DELEGATE_RUNTIME`; an unconfigured installation fails before preparation.

## Current scope

Source checkouts may contain staged, unstaged and nonignored untracked changes.
Each worker gets a fresh context and an isolated snapshot worktree, never a shared
mutable checkout. Verification uses explicit,
operator-configured command profiles, not a particular build system or package
manager. No toolchain setup or dependency installation is implicit. The current
worker/lock runtime targets Linux with Git, Bash, Node 24+, Pi and `flock`.
An optional absolute `claude` executable enables Claude Code as a separate worker
harness; it does not use Pi's provider catalog or Pi authentication.

## Shared catalogue and deterministic routing

`delegate_models {backend?, provider?, query?, offset?, limit?}` lists a shared
execution-route catalogue without model calls, login probes or endpoint health
checks. It combines Pi's current registry (including custom/local providers such
as GMKtec's `evo-x2`) with operator-declared Claude Code entries. Harness policy
is strict: **Anthropic models only through Claude Code; local and OpenAI models
only through Pi.** Anthropic entries in Pi's registry supply discovery IDs, not
Pi API routes or Pi authentication. Pi models are
not copied into another static list; refreshed Ollama models appear when Pi
reloads its registry (`/model`). Results are paged (default 50, maximum 100) and
can be filtered by provider, backend or case-insensitive ID/name substring.

Use the exact catalogue `id` as the task/revision `model`; omit `backend`:

| Selection | Harness | Native worker model |
|---|---|---|
| `evo-x2/qwen3-coder-next-agent` | Pi → configured Ollama endpoint | same provider/model |
| `openai-codex/<model-id>` | Pi → configured OpenAI provider | same provider/model |
| `anthropic/claude-sonnet-4-6` | Claude Code → its configured endpoint | `claude-sonnet-4-6` |
| `claude-code/claude-sonnet-4-6` | Claude Code → its configured endpoint | `claude-sonnet-4-6` |

Anthropic provider-style selections are aliases for the same canonical Claude
Code route (`canonicalId`), not an alternative Pi execution path. Exact native
`claude-*` IDs also route to Claude Code. Other hosted Anthropic namespaces such
as `openrouter/anthropic/claude-*` route to the exact native Claude ID; unsupported
vendor-specific aliases (e.g. Bedrock version/region IDs) are not guessed or sent
through Pi. Known local providers (`evo-x2`, `ollama`, `llama.cpp`) and OpenAI/
Azure-OpenAI providers remain Pi-only, independent of their model tags.
There is no fuzzy matching, task-based model selection, load balancing, or
automatic fallback—especially not local-to-paid fallback.
Unknown IDs, conflicting backend overrides and missing executables fail closed.
Model/effort/auth rejection during execution does not select another route.
The catalogue covers **delegation**, not the foreground Pi `/model` picker:
Claude Code is a different harness, not a fake Pi provider.

Each entry exposes its harness/native model, provider, redacted endpoint origin,
authentication source, source-tool/check capabilities and known Pi context/input/
pricing metadata for Pi routes. Anthropic aliases expose Claude Code auth/endpoint
and unknown pricing/context, not Pi Anthropic metadata. Claude CLI context/pricing/
auth status remain unknown. Pi's
`hostConfigured` authentication flag is not worker readiness: foreground env keys
are scrubbed and the child uses HOME/provider configuration. No credentials,
headers, credential-bearing URL paths/query strings or resolved keys are returned.
The harness having tools does not establish a successful model agent-loop test.

**GMKtec model guidance:** reserve `evo-x2/*` models for simple, well-specified
mechanical work with narrow scope and easily checked acceptance criteria (for
example, literal edits or small fixtures). Do not use them for complex multi-file
reasoning or policy alignment. This is advisory task-selection guidance, not an
automatic model switch or a claim that every simple task succeeds. Select any
stronger route explicitly; there is no local-to-paid fallback. Full main-agent
review remains required for every model.

### Optional Pi model admission policy

An operator can restrict production delegation without removing experimental
models from Pi's registry or foreground `/model` picker. `piModelPolicy` in the
immutable delegate runtime maps provider names to exact model IDs and their
allowed Pi thinking levels. For example:

```json
{
  "piModelPolicy": {
    "evo-x2": { "qwen3.8:27b": ["medium"] },
    "ollama": {},
    "llama-cpp": {},
    "llama.cpp": {}
  }
}
```

Configured empty provider objects disable their Pi routes; omitted providers are
unrestricted. Provider keys are lowercase and matched case-insensitively; model
IDs are exact/case-sensitive, with no inferred aliases or suffix normalization.
Each allowed model must have one or more explicit thinking levels. Malformed
policies fail admission closed, not back to an unrestricted catalogue.

The catalogue omits excluded Pi routes and reports restricted levels in
`capabilities.thinking`. Task/revision selection, preparation and worker startup
reject excluded models/levels, including explicit backend/native syntax. They do
not clamp effort, substitute another model, contact endpoints or change auth.
Hosted providers not named in the policy and Anthropic's Claude Code routing are
unchanged. A missing allowed model means no such local route, never fallback.
This is configured provider policy, not automatic detection of every local
endpoint: review new provider namespaces explicitly.

Historical jobs retain their original immutable runtime/source. Nothing rewrites
queued/running tasks, sessions or model installations. A new policy requires
explicit publication/deployment and a fresh initiating Pi process. Starting an old
manifest with a policy that excludes it is refused; do not mutate manifests or
retry automatically to evade the gate. This policy does not configure provider
request serialization: the corresponding model must separately support and send
the chosen effort through Pi's model configuration.

The resolved route identity and descriptive metadata are copied into each task or
revision manifest and surfaced in submission/review evidence. Workers use their
frozen backend/native model, not a later catalogue lookup. This is not a snapshot
of external endpoints, credentials, model weights or pricing: preserve matching
immutable runtime/CLI paths and configuration through execution. Fresh revisions
resolve their explicitly selected catalogue entry again: local/OpenAI IDs select
Pi and Anthropic IDs select Claude Code, independently of the previous backend.
Old Pi-Anthropic manifests fail runner validation rather than being silently
rerouted; retain matching historical runtime/evidence for existing jobs.

For compatibility, explicit backend/native-model syntax still works **within
policy**. `backend: "pi"` cannot force an Anthropic model through Pi, and
`backend: "claude"` cannot force local/OpenAI models through Claude Code.
Native `claude-*` IDs always select Claude Code, even on a revision of a Pi task.
Anthropic models require CLI effort (`low`, `medium`, `high`, `xhigh`, `max`);
Pi-only levels such as `off` are rejected, not silently converted.

## Tools

- `delegate_task {repo, brief, backend?: "pi"|"claude", model, thinking, profile, checks}` starts from the
  selected checkout's current working state in a fresh sibling worktree. Staged
  and unstaged contents are combined into an internal baseline, with nonignored
  new files included (and staged ignored additions preserved). Supply
  an exact shared catalogue entry ID and requested thinking. Pi uses its thinking
  levels; Claude Code uses CLI effort (`low`, `medium`, `high`, `xhigh`, `max`).
  Explicit backend/native-model selection is also supported within policy. Fuzzy
  aliases such as `sonnet` and unsupported effort levels fail before preparation;
  model/effort support is ultimately determined by the installed Claude CLI/API.
  Supply a self-contained bounded brief with
  scope/paths/acceptance criteria and review assessment, and only necessary
  `{kind: "test"|"build", targets: ["package:test"]}` checks (`[]` is allowed).
- `delegate_reconcile {task, expectedNonce?, expectedFingerprint?, expectedEvidence?}`
  assesses an original stopped attempt across sessions. Task alone is read-only;
  supplying all expected fields requests fresh interactive authorization for
  foreground-only custody. See [Foreground reconciliation](#foreground-reconciliation).
- `delegate_resume {task, expectedNonce, expectedFingerprint, brief}` explicitly
  recovers a stopped failed/canceled attempt after fresh user confirmation. It
  preserves the frozen invocation/check plan. See [Explicit recovery](#explicit-recovery).
- `delegate_review {}` lists active-branch owned tasks without querying the backend.
  `delegate_review {task, openDiff?: false}` requires authoritative Pueue EXITED
  (or KILLED with independently verified empty attempt containment),
  collects cumulative tracked diff, new-file list, untrusted report and current
  check evidence. Optional panel targeting does not change the agent's cwd.
- `delegate_finalize {task, expectedNonce, expectedFingerprint, disposition: "integrated"|"discarded"}`
  explicitly archives and removes a reviewed task's worktree and branch after fresh
  interactive confirmation. See [Explicit finalization](#explicit-finalization).
- `delegate_dispose {task, expectedNonce, expectedFinalization?, selections?}` assesses
  finalized payloads read-only, or permanently removes explicitly selected per-task
  build outputs/recovery payloads after separate fresh interactive confirmation.
  See [Permanent payload disposal](#permanent-payload-disposal). This is not a task-root purge.
- `delegate_feedback {task, expectedNonce, reviewStatus, usefulness, correctness,
  instructionFollowing, reviewEffort, wouldDelegateAgain, rationale, problems,
  improvements, evidence, reviewedFingerprint?, supersedes?}` records the **calling
  agent's** assessment of one terminal attempt. See [Caller feedback](#caller-feedback).
- `delegate_revise {task, expectedNonce, expectedFingerprint, brief, backend?, model, thinking}`
  starts one explicitly authorized revision in the **same** worktree/output base.
  Get identities from the latest review. The previous attempt must be confirmed
  EXITED/0 without cancellation or integrity error. Supply a fresh self-contained
  brief; original profile/check plan are inherited. Selecting a shared catalogue
  entry determines the backend independently of the previous attempt. Every
  revision starts a fresh session, not a Claude `--resume`. Permanent per-parent claims
  prevent duplicate revisions, including after uncertain admission or navigation.

Use the existing `pueue_status`, `pueue_result` and confirmed cancellation tools.
Missing/uncertain evidence never permits automatic retry. Branch ownership and
session identity are preserved; a fork does not gain another session's authority.
Preparation/admission failures retain artifacts for manual reconciliation.

## Cleanup-only historical operations

`delegate_cleanup {task, repository, action, disposition?, selections?,
expectedNonce?, expectedEvidence?, expectedFingerprint?, expectedFinalization?, legacyRecovery?}`
provides a separately confirmed cleanup route across sessions or after removal of
a linked source checkout. Enable `cleanupProtocol: 1` alongside scoped
reconciliation/finalization (and disposal for permanent payload deletion), only
after separate reviewed deployment and a fresh Pi session. No runtime flag or
provisioning change is implicit in this package.

The tool never adopts a task into the caller's branch, transfers foreground
custody onward, edits a manifest/history, starts a worker or changes backend
ownership. It performs only the existing finalization or disposal operation,
using bound original private terminal evidence rather than a missing live job as
proof. No model-supplied statuses, stopped proofs or repository identities are
accepted. Original scoped attempts only: revision chains and uncertain records
stay blocked. The recorded status is `RECONCILED_EXITED`,
`backendAuthority: false`, `authority: "cleanup-only"` even for an unreconciled
original; it describes archived provenance, not a new reconciliation grant.

1. Supply the task UUID and absolute canonical **main checkout** as `repository`.
   For archive-and-remove use `action: "finalize"` and explicit `disposition`;
   for permanent payload removal use `action: "dispose"` and intended `selections`.
   With no expected fields the call is read-only. Existing review/feedback and
   integrated-disposition check requirements still apply. A defective original
   draft is not integrated merely because the corrected parent feature merged.
2. The assessment binds exact operation fields, current source/local archive or
   payload inventory, recipient session, original terminal provenance and local
   repository identity. Review it and obtain explicit candidate/disposition
   approval. To change payload selections, assess those selections again.
3. Supply all returned expected fields: `expectedNonce`, `expectedEvidence`, plus
   `expectedFingerprint` for finalize or `expectedFinalization` for dispose.
   Each operation requests fresh interactive confirmation and revalidates after
   the dialog and after exclusively claiming it. Confirm all original/custodian
   sessions and foreground users/external build servers are idle. Worker cgroups
   cannot fence arbitrary foreground activity. Denial/abort/session navigation
   admits nothing; an interrupted claim stays blocked, never automatically retried.
4. Finalization preserves the old reconciliation claim when present, takes the
   existing exclusive finalization/continuation claim, archives local work, then
   removes only the registered worktree and unchanged branch. It retains recovery,
   build outputs and diagnostics. Disposal is a **separate** read-only assessment,
   exact payload selection and confirmation, with the existing one-shot claim,
   no replacement archive and no task-root/session/audit purge. Cleanup caller
   session/file and archived provenance are retained in operation authorization.

For a retained worker, canonical main and worker paths must prove the same local
Git common-directory identity; an extant original source must agree too. Main
checkout and common-directory paths must be canonical/user-owned, with a standard
main `.git` directory. Clones, aliases, bare/nonstandard layouts and replacement
source paths fail closed; origin URLs and matching commits are not identity.
New finalizations record main-checkout/common-directory paths and device/inode
identities in authorization, ready record and receipt. Those bound records allow
future cleanup-only disposal even if the linked source no longer exists.
**Older finalized archives without that independent identity remain blocked by default.**
The separately enabled recovery-only exception below explicitly authorizes loss
without claiming historical identity. No fallback fabricates a binding from bundle
ancestry, recreates a source checkout, edits manifests/receipts or clears claims. Existing owning-session
operations remain available under their original gates; legacy scoped/stopped
limitations are unchanged.

All historical cleanup gates recheck exact original admission identity against a
complete fresh backend snapshot (absent or exactly agreeing), original private
review ancestry, unchanged worker result and reconciliation provenance, and
independent same-boot stopped proof. Active/UNKNOWN/reused identities, missing
history, legacy containment and prior-boot evidence remain blockers. Mailhub
plans/sets/Trash journals and unknown-outcome barriers remain protected: inspect
selected payload scope and stop for protected operational evidence, never invoke
a provider action to make cleanup possible. See the [cleanup skill](../../skills/delegate-cleanup/SKILL.md)
for inventory, fish-compatible usage and retained-space reporting.

### Explicit legacy recovery-only exception

`legacyRecoveryDisposalProtocol: 1` is a separate operator opt-in, requiring all
ordinary cleanup/disposal/scoped protocols and a reviewed deployment/fresh Pi
session. It enables only `delegate_cleanup` with `action: "dispose"`,
`selections: ["recovery"]` and `legacyRecovery: true` for already-finalized
original scoped attempts whose old receipt/authorization/intent/ready records
entirely lack repository bindings. Missing, partial/null, mismatched or modern
identity records cannot be downgraded through this flag. Do not rewrite real
records to make them eligible. The ordinary path still refuses legacy archives.

The user explicitly selects a canonical user-owned current main checkout. Its
local identity is checked for path safety/reused delegate refs, but the archive's
historical repository relationship is **unverified**, not reconstructed from a
bundle, origin or matching commits. An extant original source must agree. The
exception authorizes loss of recovery copies despite that missing historical
binding, not source disposal or proof that the original work was integrated.

First assess with no expected fields. Review exact payload scope/protected data
and obtain explicit approval. Then supply the returned nonce, evidence and
finalization digests with the same flag/selections. Assessment binds the caller,
mode, current repository, payload metadata and unchanged old finalization records.
The fresh confirmation names the legacy exception and irreversible loss. Denial,
no UI, abort, navigation or changed evidence admits nothing. Original terminal
review ancestry, backend consistency, fresh independent same-boot stopped proof,
complete coherent finalization, no revisions, absent worker/ref and exclusive
permanent disposal claims remain mandatory. Old uncontained/prior-boot evidence
and interrupted/partial operations remain blockers; no force/retry/claim clearing.

Only `finalization/source.bundle` and `finalization/local-files.json` are unlinked
using the existing held-directory, ownership, symlink and mount safeguards. No
new archive or retroactive identity record is created; build outputs, worktrees,
branches, task roots, sessions and audit records are not deleted. The new disposal
authorization/claim/receipt record `legacyRecovery: true` and
`repositoryBinding: "operator-selected; historical identity unverified"`.
Inspect and preserve real-mail plans/sets/Trash journals before approval; the
exception grants no provider action or unknown-outcome override. See the
[cleanup skill](../../skills/delegate-cleanup/SKILL.md#explicit-legacy-recovery-disposal)
for the operation sequence and retention/accounting limits.

## Working-state snapshots

Preparation copies the source index to a private temporary index and captures its
current working contents with Git. The source's HEAD, branch, index and files are
not changed. Ignored untracked caches and empty directories are not copied;
tracked ignored files are included. Binary files, executable bits, symlinks,
renames and deletions use Git's normal tree representation and attributes/filters.
The worker does not inherit which changes were staged: its index starts clean.

For a dirty tree, preparation creates an internal snapshot commit whose parent is
source HEAD, then creates only the delegate branch at that baseline. This object
is stored in the repository's shared Git object database and retained by the
worker branch; it is not a commit on the main agent's branch and invokes no commit
hooks or signing. Treat included untracked files as retained source, not temporary
private scratch space: do not include secrets. Clean trees reuse HEAD directly.

Manifests retain `base` (worker baseline), `sourceHead`, `sourceTree` and
`sourceFingerprint`. Review patches, new-file lists, fingerprints, checks and
revisions are relative to `base`, so inherited changes are not reported as worker
work. An inherited untracked file modified by a worker appears in the tracked
patch, not the new-file list. Opening the panel pins its comparison base too.
Existing tasks without snapshot metadata keep their original HEAD-based behavior.

Preparation rechecks the source before and after worktree creation and refuses
admission on detected changes, retaining evidence without retry. This is not an
atomic filesystem snapshot or a lock: do not edit the source during preparation.
After handoff the main agent may continue working independently. Review returns
`sourceState.unchanged` and warns if the main checkout has drifted, or cannot be
inspected. This is a collection-time observation, not an integration lease.
Recheck the destination and reconcile conflicts when applying worker-only changes;
never overwrite the main checkout with the worker's full files blindly. There is
still no automatic integration, merge or publication.

Conflicted source indexes, submodules/embedded repositories and
sparse/assume-unchanged entries fail closed rather than silently omitting source.
Snapshots are bounded to 10,000 changed/new files and 64 MiB of changed/new source
content (with bounded Git output and index size too). Toolchain caches remain
ignored and uncopied. A fresh worker still needs the configured verification
runtime; no dependency installation or SDK bootstrap is implied.

## Review and evidence

The UI action **Collect changes and report** gathers the files/report for review;
it does not perform or record a review verdict. Its neutral line reads
**Changes collected · review verdict is separate**. This is a static collection
snapshot, not a warning, a pending-review tracker or an approval signal. The main
agent's subsequent review message supplies the verdict. Actual missing worker
results, failures, cancellations, stale source and integrity errors retain their
warning/error styling. Zero planned checks means none were requested, not failure.

A report or exit zero is **not acceptance**. The main agent must read the entire
tracked patch and every new file, inspect relevant context and current check
records against the brief, then report findings or a concise verdict. Do not
require the user to inspect diffs manually by default. Integration/publication
still require their existing authorization.

Checks require unchanged root/branch/base HEAD, unstaged index and identical
before/after source fingerprints. Evidence is current only while the fingerprint
matches. Fingerprints cover tracked changes and nonignored new-file content/mode,
not ignored caches, external state or detached descendants. Oversized artifacts
fail closed. Interrupted checks leave intent/logs, never invented success.
Revisions recheck the handoff fingerprint immediately before worker startup.
Do not edit or check a worktree while its worker/check owns it.

Task state remains under the configured private state directory:
`<uuid>/task.json`, brief, receipts, started/result records, sessions, report,
worker log, check evidence, tracked diff and `build-output/`. Revisions retain
separate artifacts under `revisions/<attempt-uuid>/` while sharing the original
output base. At startup, both Pi and Claude workers log the JSON-quoted absolute
path to that attempt's `brief.md` (including revisions), not its contents. The
brief remains a private 0600 artifact; prompt text is not copied into startup logs.
No automatic pruning, artifact deletion or worktree cleanup. After authorized
integration or an explicit discard decision, use `delegate_finalize` rather than
leaving disposable worktrees indefinitely. Review and feedback results include a
finalization reminder; neither operation triggers deletion.

Delegate live output and `worker.log` lines are prefixed with UTC ISO timestamps
(e.g. `[2026-11-05T09:42:17.123Z]`); the Bash launcher uses whole seconds.
The timestamp records when a line's first bytes are observed, not model token time.
Partial lines stream immediately without waiting for a newline or adding a prefix
per chunk. Final `report.md` contents and structured artifacts remain unchanged.
Ordinary Pueue jobs are not timestamped by the adapter; callers that want timestamps
must print them from their own command.

## Foreground reconciliation

Normal resume of the **same session and branch** restores ownership from history.
A Taskboard handoff or new conversation restores context, not authority. Separately,
operator removal of Pueue history can block the original owner too. Never solve
these cases by copying session entries, changing manifests or inventing a backend
completion. Existing `delegate_resume` remains a distinct new-worker operation;
its terminal-backend requirement has not been relaxed.

`delegate_reconcile` is an opt-in, one-time transfer of an **original scoped
attempt** to a persistent receiving session (which can also be the original
session when its backend history is gone). Enable `reconciliationProtocol: 1`
with `containmentProtocol: 1` in the operator-managed runtime and explicitly
reload/deploy the reviewed extension in participating sessions. Loading code alone
is not permission to transfer a task. No runtime configuration or deployment is
performed by this tool.

1. Call with only `task` for a bounded, **read-only assessment**. It reads the
   immutable manifest/submission/result, private original Pi v3 session tree,
   current source fingerprint and trusted attempt containment. It creates no
   artifacts/worktree, locks, claims, workers or model calls. Only bounded
   read-only Git/Pueue queries spawn subprocesses.
2. A genuine non-error `delegate_review` tool result in the original session must
   bind the same task, worktree/base, exact admitted nonce/ID/creation/namespace
   and worker result to its ancestral assistant tool call and owning branch
   entries. The evidence digest binds that provenance, not unrelated appended
   chat, so same-session assessment does not invalidate itself. An assistant claim, completion notification, handoff, log tail or
   `result.json` alone is insufficient. Conflicting task/terminal evidence,
   revision/finalization history, missing private history, legacy containment or
   existing continuation claims block assessment. Session reads are bounded to
   64 MiB/200,000 entries and remain local; prompts/mail/file bodies are never
   copied into reconciliation records or model-facing results.
3. A complete fresh Pueue snapshot must succeed under the original namespace.
   The exact matching identity must be terminal and agree with the archive, or
   genuinely absent. Reused/replaced identities, active/UNKNOWN/KILLED states,
   contradictory exits and query failures block. Absence itself establishes
   **nothing**: terminal evidence comes from the original bound tool result.
4. Independently verify same-boot, exact attempt cgroup-v2 stopped proof, including
   descendants, using the existing recovery verifier. Rebooted, replaced, populated
   or unrecorded containment remains blocked. Verify the current unstaged retained
   worktree/branch/base and shared Git repository; no inherited work is overwritten.
5. Review the assessment. Call again with its `expectedNonce`,
   `expectedFingerprint` and `expectedEvidence`. A fresh UI confirmation identifies
   both owners, the worktree, evidence provenance and **foreground-only** scope.
   The operator must ensure the original session is idle: arbitrary main-agent
   foreground commands are outside worker containment and cannot be fenced here.
   Denial/non-UI/abort/session changes admit nothing. Revalidate after confirmation
   and again after exclusively claiming the attempt.
6. Exclusively create and fsync the SAME permanent `revision-after-<nonce-hash>`
   claim used by revise/resume/finalize, then fsync `reconciliation.json` and its
   directory. The receipt binds the evidence, recipient and source fingerprint;
   original manifests, results, session history and Pueue jobs are untouched.
   Concurrent attempts have one winner. Partial persistence or interrupted claims
   remain blocked; there is no automatic release or force option.
7. Append a task reference with the original initiator plus separate custodian to
   the receiving session branch. Lost append/reload can be repaired by the same
   recipient through another fresh assessment/confirmation; it reuses the receipt,
   never creates a second grant. Other sessions, forks and stale branches cannot
   acquire it by knowing the task ID. This v1 grant cannot be transferred onward.
8. Use `delegate_review`, inspect the full patch/every new file/relevant context,
   run applicable current checks, report the verdict, then `delegate_feedback`.
   Collection/feedback explicitly say **RECONCILED_EXITED**, name archived
   provenance and set `backendAuthority: false`, even if the original job is still
   present. Fresh stopped/backend checks guard collection. Foreground edits are
   allowed but invalidate old source-check evidence as usual. A historical exit is
   neither acceptance nor proof that current source passes tests.

This is **not Pueue ownership adoption**: no submit, enqueue, signal, daemon
maintenance or source edit occurs during reconciliation, and original Pueue groups,
notifications and cancellation ownership do not move. Original delegate owners are
fenced by the shared claim; updated tools reject stale custody. Cooperating clients
must use the updated extension; this is not an OS sandbox against same-user code,
manual source edits or tampering with all private evidence files.

A reconciliation grant itself permits foreground review/editing and diagnostic
feedback only. `delegate_revise` and `delegate_resume` stay disabled. Updated
`delegate_finalize` can separately confirm finalization of a reconciled original
attempt, retaining archived provenance and fresh stopped/backend checks. It preserves
(rather than clears/replaces) the custody claim and takes a second exclusive
finalization claim. No worker is restarted. Continuation, integration/publication,
provider actions and cleanup retain their separate approvals. Revision chains, missing trustworthy terminal records, repeated
transfers and pending reconciliation need separate operator investigation, not a
new key/task/claim to bypass a barrier. Keep retained artifacts available.

## Explicit recovery

`delegate_resume` is a separate path from successful `delegate_revise`. It never
changes a previous result to success, clears cancellation intent, restarts a Pueue
job or continues an old Claude session. Every recovery:

1. Requires the latest owned task/nonce on the active session branch and a known
   backend-terminal failed/canceled job. Absent, UNKNOWN, admission-unknown,
   running, queued and paused states remain blocked. Successful uncanceled attempts
   use `delegate_revise` instead.
2. Independently verifies a trusted `containment.json` startup record against the
   current boot and exact per-attempt cgroup identity. `cgroup.events: populated 0`
   covers the whole subtree, including double-fork/`setsid` descendants. A removed
   recorded cgroup also proves emptiness: Linux cannot remove populated cgroups.
   A missing events file, replaced directory, reboot, missing startup record or
   unknown liveness fails closed. KILLED, a missing PID or an exit code alone does
   **not** establish stopped descendants.
3. Checks the CURRENT retained worktree fingerprint, root/branch/base and unstaged
   index. Reviewed foreground fixes are allowed: supply their current fingerprint,
   not the failed worker's old fingerprint. Collect/review the complete current diff
   and all new files first. KILLED/cancellation collections require stopped evidence.
4. Shows a fresh user confirmation with the old job, model/thinking, fingerprint
   and complete recovery brief. No model-supplied `authorized: true` exists. A
   non-UI caller cannot recover. Denial, abort or session change admits nothing.
5. Requeries backend state, rechecks containment and recomputes the fingerprint
   after confirmation. Exclusive per-parent claims are shared with `delegate_revise`,
   preventing duplicate continuations across races, stale branch history and lost
   replies. Claims and uncertain preparations are never automatically released.
6. Starts a new attempt under `revisions/<new-uuid>/`, with a fresh Pi context or
   Claude session UUID, reusing the original worktree and `build-output/`. Backend,
   route, model, thinking, frozen profile command and planned checks are inherited
   from manifests, not caller-selectable or refreshed from a changed catalogue.
   Previous results, briefs, logs, check evidence and cancellation history remain
   intact. The new manifest records authorization, previous attempt/nonce, backend
   cancellation/exit state and independent stopped evidence.
7. Rechecks stopped evidence and the handoff fingerprint at actual worker startup.
   Full patch/new-file/context/check review and caller feedback are still mandatory;
   recovery grants no acceptance, integration, publication or cleanup permission.

**Legacy limitation:** recovery cannot retroactively prove that descendants of an
unscoped worker stopped. Old jobs without trusted per-attempt startup containment
remain blocked; do not manufacture a record, edit their result/status or infer
liveness from KILLED. Jobs canceled before a scope was recorded are blocked too.
Retain evidence and investigate manually rather than weakening this gate.

### Scoped runtime for recovery

Enable `containmentProtocol: 1`, configure an absolute `systemdRun` executable and
materialize `launch.sh` with `@runner@` pointing to **`scope.mjs`**, not `run.mjs`.
All other launcher replacements and `revisionProtocol: 1` remain unchanged. The
scope wrapper uses the configured local user's systemd manager over derived
`/run/user/<uid>/bus` paths; it does not inherit a foreground D-Bus address, tokens
or agent sockets. The user manager and unified cgroup v2 must be available.

Each attempt gets a unique `pi-delegate-<task>-<attempt-or-initial>.scope`. The
runner records its kernel cgroup/boot/inode identity before any worker starts,
then refuses to execute outside that recorded scope. All normal forked descendants,
including MCP and verification commands, inherit it. Failed scope setup starts no
model and never falls back to uncontained execution. `systemd-run --scope` is an
execution envelope, not another retry scheduler; Pueue still owns admission,
logs/status and cancellation intent. Recovery itself never signals/stops a scope.
Old immutable launchers/configurations remain necessary for existing queued jobs.

This is **not an OS sandbox** against hostile same-user code or privileged cgroup
migration: trusted verification commands must not escape the scope, enlist external
services to mutate the worktree later or migrate processes to another cgroup.
External endpoint side effects are not rolled back or proven absent. Do not run
foreground checks/edits concurrently with a worker; source fingerprints do not
lease external state or certify ignored caches. New runtime deployment/reloading
is explicit; merely loading the tool does not start processes or migrate old jobs.

## Explicit finalization

`delegate_finalize` closes the lifecycle after main-agent review, caller feedback
and authorized integration (or an explicit discard decision). It is deliberately
**not** an exit hook, age-based sweeper, automatic acceptance, or merge operation.
Loading the extension never removes anything. Enable `finalizationProtocol: 1`
and `containmentProtocol: 1` in the runtime; restart Pi after deployment.

Every call requires the latest task nonce and current reviewed fingerprint on the
owning session branch. All retained attempts, including earlier revisions, must
have authoritative terminal Pueue status and independent current-boot cgroup-v2
proof that their worker and descendants stopped. A reconciled original instead
uses its bound original private terminal review, unchanged result/containment
identity and current custody receipt, with a fresh complete backend observation
that must remain absent or agree exactly. Its status stays `RECONCILED_EXITED`,
`backendAuthority: false`; absence alone is never terminal evidence. This path
supports original attempts only, not revision-chain reconciliation. Absent/UNKNOWN/active jobs,
unresolved preparations, missing/legacy containment, rebooted/replaced scopes,
changed branch/HEAD/index and stale source fail closed. Legacy tasks need manual
reconciliation, not manufactured evidence or a force option.

A fresh UI confirmation shows the exact worktree, branch, disposition, fingerprint
and recovery location/count/size. Denial, no UI, abort or session navigation grants
no cleanup permission. Backend status, containment and source/local-file content
are checked again after the dialog. `integrated` records the caller's declaration,
**not** automatic proof of a merge: it additionally requires current reviewed/good
feedback and current passing evidence for every planned check. `discarded` still
requires caller feedback/investigation, but permits failed/incomplete work.

Before removal, the tool retains under `<task>/finalization/`:

- `source.bundle`: a verified Git bundle of the delegate branch, including any
  inherited dirty-source baseline commits, whether merged or not;
- `local-files.json`: the binary Git patch plus changed/new/**ignored** files,
  their modes, base64 file contents, symlink targets and deletion markers;
- `intent.json` and `ready.json`: authorization, disposition and stopped evidence.

Local files are bounded to 10,000 paths and 64 MiB; oversized/unsupported files
block deletion. Symlinks are archived without dereferencing their targets.
Ignored files and external caches are not evidence of integration. External
symlink targets are never copied or deleted. Existing logs, reports, checks,
feedback, sessions and `build-output/` remain. Nothing is pushed or uploaded.
Archives can contain sensitive local data: directories are private, artifacts
0600. For recovery, fetch `source.bundle` into a separate repository using the
branch ref in `local-files.json`, check out that baseline, then restore the archived
file entries (base64 bytes + mode, symlink target, or deletion marker). The `patch`
field is also available as a standard binary Git patch. No automatic restore or
cleanup of recovery evidence is performed.

Ordinary finalization competes with revise/resume for the same exclusive permanent
per-parent continuation claim. Reconciled originals already own that immutable
claim: finalization preserves it and exclusively creates
`finalization-after-<nonce-hash>.json`. That second claim fences further foreground
use, competing cleanup and reattachment. No claim is cleared or overwritten.
Lifecycle claims/receipts are fsynced along with their parent directories. After archiving and another fingerprint/containment
check, Git removes only that worktree, then compare-and-deletes only its unchanged
branch. Git's locked-worktree protection remains enabled. A `finalized.json`
receipt and session entry are written only after both removals succeed; task lists
show the finalized state. Partial failures retain the claim and archives for
manual reconciliation—never retry automatically or release an uncertain claim.
The tool is not a filesystem transaction or an OS sandbox against concurrent
same-user changes. Do not run foreground edits/builds in the task checkout while
finalizing. Preserve the original configured runtime and backend evidence until
finalization; clearing Pueue history first can block safe disposal.

## Permanent payload disposal

`discarded` above means unwanted work, **not permanent deletion**. Finalization
retains recovery data and build outputs indefinitely. Git integration and local
data disposal are separate decisions. After routine review/integration/discard,
finalize explicitly rather than leaving obsolete worktrees, then separately decide
which finalized payloads may be permanently lost. There is no automatic purge.

Enable `disposalProtocol: 1` alongside scoped finalization only after reviewing and
separately deploying this source. Loading a skill or this checkout does not update
an installed extension/runtime. See the packaged
[cleanup skill](../../skills/delegate-cleanup/SKILL.md) for the agent workflow and
read-only inventory script (including fish-compatible usage). Package installs
expose it through `pi.skills`; extension-directory-only deployments must also
explicitly provision the skill directory if it should be discoverable.

1. `delegate_dispose {task, expectedNonce}` assesses a **successfully finalized**
   owned task read-only, returning its `expectedFinalization` receipt digest and
   allocation estimate. This does not grant disposal permission. Missing records
   are not recreated during assessment.
2. After explicit approval of exact candidates/disposition, supply that digest and
   `selections: ["build-output"]`, `["recovery"]`, or both. Select the complete
   intended set together: this version permits one disposal claim per task, not
   successive sweeps. A fresh interactive dialog names the directory/groups and
   warns about irreversible loss; denial/no UI admits nothing.
3. The gate requires unchanged manifest/claim/finalization intent/ready/receipt,
   owning session/custodian, absent worktree and delegate ref, and fresh terminal
   evidence plus independent same-boot stopped proof for **every** attempt.
   Reconciled originals revalidate their private originating terminal record and
   retain archived provenance. Live, unknown, rebooted, conflicting or incomplete
   evidence blocks. A new session cannot adopt already-finalized historical tasks
   via original-attempt reconciliation. Separately enabled cleanup-only disposal
   can operate without custody only when the finalization records durably bind
   independent local repository identity; legacy archives lacking that binding
   stay blocked unless separately opted into the explicit recovery-only legacy
   exception above. Otherwise use the owning session or investigate.
4. The tool inventories the exact selected payload metadata, ownership, inode,
   device, mode, size, link count and timestamps without copying build contents.
   Confirmation binds that inventory. A durable exclusive `disposal-claim.json`
   fences concurrent disposals; backend/containment/inventory are checked again
   after claiming. Unsafe metadata symlinks, foreign-owned entries, mount crossings,
   unsupported file types and inventories above 250,000 entries or 64 MiB block disposal.
5. Only `<task>/build-output/` and/or `finalization/source.bundle` plus
   `finalization/local-files.json` are removed. Symlinks themselves can be
   unlinked, never their targets. Linux held-directory-descriptor traversal
   prevents intermediate symlink replacement from redirecting deletion. Shared
   SDKs/caches outside those payloads are untouched. No new archive is created.
6. A durable `disposed.json` is written only after completion. Interrupted/partial
   disposal retains its claim and path/identity inventory for manual investigation;
   there is no forced retry, claim release or automatic recovery. Filesystem
   operations are not transactional or a sandbox against arbitrary same-user
   changes. Confirm all foreground users and external build servers are idle;
   worker cgroup proof alone does not fence them.

At minimum, task/attempt/submission identities, permanent claims, reconciliation
provenance, results/containment, finalization intent/ready/receipt, disposal
intent/receipt and review/check evidence remain. This version additionally keeps
briefs, reports, feedback, logs and session artifacts: **no log/session purge or
retention deadline** is implemented. Originating sessions, real-mail plans/sets
and Trash journals must be preserved. Inspect candidate payloads for protected
operational state; if present, stop rather than treating it as disposable cache.
In particular, Mailhub unknown-outcome barriers and metadata-only investigation
requirements are unchanged; no provider action or journal removal is authorized.

`unlinkedAllocatedBytes` excludes multiply-linked files and counts observed
unlinked allocations, not guaranteed reclaimed free space. Open handles, shared
blocks/snapshots and concurrent changes can retain storage. Report actual removed
paths/groups and remaining blockers, and compare before/after allocation/free
space honestly; archiving is retention, not space reclamation. The inventory
script labels every task unassessed: age, a merged branch, receipts or historical
exit files alone are not a deletion manifest. Its default scan measures task-state
allocation and Git registration, without recursively measuring worktree contents.
Use `inventory.mjs --worktrees` to opt into potentially expensive worktree allocation;
state scans can still be large when build outputs remain. The JSON
`worktreeAllocationRequested` flag records the scope, and absent
`worktreeAllocatedBytes` means unmeasured/unavailable, not zero. Optional worktree
scan failures retain state accounting and add a blocker. Direct script paths and
installed skill-directory symlinks both work; `--help` needs no runtime.

## Caller feedback

After reviewing each attempt and reporting its verdict, the caller should invoke
`delegate_feedback`. Submission/revision tool instructions request this, and
`delegate_review` returns a structured `feedback` reminder with the exact task,
nonce and storage directory. This is a reminder, not an automatic extra model
turn, forced grade, review attestation or blocker on authorized revisions.
Record diagnostic feedback after investigating failures too, even when there is
no report, diff or usable worker result. Missing feedback means **not assessed**.

Required assessment fields:

| Field | Values |
|---|---|
| `reviewStatus` | `reviewed`, `partial`, `not_reviewed` |
| `usefulness` | `useful`, `partly`, `not_useful`, `not_assessed` |
| `correctness`, `instructionFollowing` | `good`, `issues`, `not_assessed` |
| `reviewEffort` | `low`, `moderate`, `high`, `not_assessed` |
| `wouldDelegateAgain` | `yes`, `no`, `unsure` |
| `rationale` | Nonempty explanation, at most 4,000 characters |
| `problems`, `improvements`, `evidence` | Arrays of at most 12 nonempty strings, at most 1,000 characters each; empty arrays allowed |

Use `not_assessed` rather than guessing; exit zero, worker self-review and passing
checks alone are not proof of correctness or usefulness. Describe actual saved
work or review/rework burden in the rationale. Keep text concise and free of
secrets, full prompts, file bodies and copied worker output. The system cannot
reliably redact secrets from free text: all artifacts remain private, local data.
Feedback is untrusted caller opinion, not an objective benchmark or permission
to accept, integrate, publish, retry or stop a worker.

The tool binds `task` plus `expectedNonce` to a submitted attempt in the caller's
active session branch, including earlier attempts after revisions. It queries
Pueue and requires a known terminal `EXITED` or `KILLED` state; absent, uncertain
and active states are rejected. `KILLED` is retained only as diagnostic status,
not proof descendants stopped. No source reads, fingerprint recomputation,
worker mutation or worktree requirement is involved. Optional
`reviewedFingerprint` is a caller-supplied historical review reference, **not**
fresh verification. The frozen task/revision/submission manifests must match.

Versioned records are stored as:

```text
$PI_DELEGATE_RUNTIME.state/<task-uuid>/feedback/<feedback-uuid>.json
```

With the usual runtime this is
`~/.local/share/pi-delegate/<task-uuid>/feedback/`. Directories are private (0700),
records are exclusive-create (0600). Each record contains `schemaVersion: 1`,
UUID, UTC timestamp, task/attempt/job binding, caller session/model (when known),
automatic invocation parameters (repo, base revision, backend, model, thinking,
profile and planned checks), backend status, assessment and artifact paths for
the brief, worker result, metrics and tracked diff. Prompts, tool arguments,
provider payloads and credentials are not automatically copied. Paths link to
retained artifacts; they do not certify those artifacts exist or that checks
passed. Original attempts use `attempt: null`; revisions use their attempt UUID.

Corrections append a full new assessment with `supersedes: <feedback-uuid>` for
the same task and attempt; the old record is never overwritten. Multiple records
and concurrent correction branches are possible: analyze their IDs/supersedes
links, not record count as invocation count. Join by task/attempt/nonce to timing
and check evidence. Nothing is uploaded, committed, pruned or automatically
filled in for historical tasks. For a local JSONL export (read-only):

```sh
find ~/.local/share/pi-delegate -path '*/feedback/*.json' -type f -exec jq -c . {} +
```

## Initiating-session identity in Pui

New worktree basenames include the initiating session label, so Pui's existing
**Path suffix** column identifies the parent without a Pui patch:

```text
delegate-cart-checkout-fixes-s1234abcd-<full-task-uuid>/
```

The label uses the session's name at task creation: a path-safe lowercase ASCII
slug of at most 28 characters, followed by `s` plus the first eight characters of
the session UUID. Unnamed/non-ASCII-only names use `session`; non-UUID session IDs
use a deterministic short hash. The full task UUID still guarantees path
uniqueness, and full session ID/file remain the ownership authority. The bounded
original session name and label are retained in the manifest; submission/list/
review evidence expose the initiator and worker logs print the label/session ID.
Names appear in paths/logs: do not put secrets in session names.

Revisions keep exactly the same worktree and original initiating label, even if
the parent session is renamed. Existing paths/jobs are **not** renamed or
migrated; their owner IDs remain available in retained metadata. Generic Pueue
jobs such as PR reviews in `goMonorepo/` are not renamed by this delegate change.

## Execution boundary and visibility

Pi workers use fresh persistent Pi print-mode sessions with explicit model/thinking,
no auto-loaded extensions/skills/templates/MCP or project Pi settings. They can
read/search/edit/write and invoke planned checks by index, not shell, Git,
publication, Pueue or delegation. Write hooks reject outside-worktree and protected
Git/agent configuration paths, including symlink escapes. This is **not an OS
sandbox**: verification commands execute as the user and HOME credentials remain
accessible. See [worker policy](policy.md).

### Pi invalid-tool circuit breaker

A Pi worker stops after **three cumulative calls to unavailable tool names** in
one attempt, including calls spread across responses or interleaved with valid
calls. The guard compares finalized assistant tool calls against Pi's offered
loadout. Ordinary tool failures (missing files, rejected edits, schema errors or
failed checks) do not count. Neither does text that merely mentions a tool.

Once a response reaches the limit, remaining valid tool calls in that batch
(including writes/checks) are blocked. After the batch's tool results are recorded, the guard requests SDK
abort before another model turn, not a Pueue cancellation or process signal.
Already completed work is retained; this is not a rollback or proof external
processes/inference stopped. It does not add a timeout, model fallback, automatic
retry, cleanup, revision or recovery permission. Claude's separate worker harness
is unchanged.

The worker exits nonzero, prints `invalid-tool-limit` and saves private per-attempt
`invalid-tools.json` with the threshold/count and at most three bounded sanitized
tool names, not arguments, prompts, results or file bodies. `result.json` exposes
`failureReason: "invalid-tool-limit"` and `invalidTools`. The runner preserves the
original child status as `workerCode` and forces failure even if a CLI reports
exit zero. Malformed/unreadable marker evidence also fails closed as
`invalid-tool-evidence`. Each explicitly authorized fresh attempt gets its own
budget and artifact; prior evidence, partial report, sessions, checks, logs and
worktree remain available. The parent must inspect them, report the failure and
record feedback; exit zero or a partial success claim cannot override the guard.
This guard does not detect incorrect reasoning or certify task success.

### Claude execution boundary

Claude workers use print mode with a fresh explicit session UUID, exact model and
CLI effort. All built-in tools are disabled; a private, strict stdio MCP exposes
only `read`, `ls`, literal `find`/`grep`, guarded `write`/unique-occurrence `edit`,
and `delegate_check` by index. Source reads are worktree-confined and text-only;
results are bounded. Calls are serialized so writes cannot overlap checks through
this bridge. The bridge reuses the same write guards, check runner, heavy-check
lock, fingerprint and per-attempt artifacts as Pi. No arbitrary command, Git,
network or delegation tool is exposed. This remains a capability boundary, not an
OS sandbox or protection against concurrent external mutation.

Claude runs with `--restricted`, empty user/project/local setting sources,
disabled hooks and slash commands, no Chrome, strict explicit MCP, `dontAsk`
permissions and no permission prompts. It does **not** use bypass permissions or
`--bare` (which would disable subscription OAuth). Managed Claude policy still
applies; only deploy with trusted CLI/managed policy. Repository instructions such
as CLAUDE.md may still be read. Existing HOME-based Claude subscription login is
used independently of Pi auth; missing auth fails, without automatic login or
fallback. Use the pinned CLI's help/auth-status commands for no-model preflight.

The brief goes over stdin, not argv. Claude runs with `--output-format stream-json`,
`--verbose` and `--include-partial-messages`. Assistant text deltas and numbered
tool start/end markers are rendered as they arrive into both the private
`worker.log` and Pueue's live log. Completed assistant messages are a fallback when
no deltas were emitted, not a second copy of streamed text. The renderer excludes
thinking/signatures, prompts, tool arguments, tool result/file bodies and unrelated
system events; raw stream JSON is not mirrored or archived. Content-free response
start/thinking notices, allowlisted usage and stop reasons are also rendered.
`max_tokens` is explicitly reported as nonterminal, with a notice when the next
CLI response starts. Two or more consecutive responses whose reported output
is entirely thinking and ends at `max_tokens` produce a warning. This changes
visibility only: it adds no continuation, retry, cancellation or effort adjustment.
Assistant text itself
can still contain sensitive material and logs must remain private. Terminal control
characters in assistant text are escaped. CLI stderr remains mirrored with line timestamps; its contents are otherwise unchanged.
The MCP bridge also emits bounded previews on its stderr, which Claude may capture
rather than forward to Pueue.

`claude-mcp.json`, the terminal result envelope in `claude-result.json`, `worker.log`
and final `report.md` are retained per attempt, including revisions; Claude's own
transcript remains in its normal HOME-based session storage. The final report is
written only after CLI exit zero and exactly one successful terminal result.
Malformed or oversized events (over 8 MiB per line), missing/duplicate results and
post-result events fail closed, even if the CLI exits zero. Protocol errors drain
the worker output and wait for exit; there is no signal, timeout, retry or fallback.
Streaming uses bounded buffering and backpressure, not whole-transcript capture.
A successful result is still not acceptance or proof all checks passed.

Example selection (with the usual repo/brief/profile/check fields):

```json
{ "backend": "claude", "model": "claude-sonnet-4-6", "thinking": "high" }
```

Only explicit HOME/PATH/LANG and noninteractive Git settings enter the runtime;
foreground tokens and agent sockets are not forwarded. Pi resolves subscription
credentials from existing HOME configuration. Keep briefs/artifacts/logs private;
never place secrets in argv.

Six cooperating workers and one heavy check per machine are bounded by kernel
`flock`, not a second scheduler. Unrelated Pueue work is not globally limited.
Ordinary Pueue session groups admit three jobs at a time, including delegates;
this budget is shared with that session's other ordinary jobs. Launchers waiting
for a global slot count as running Pueue jobs but do not start a model. Existing
slot-0/1 locks remain shared with older launchers, so running workers need not be
stopped. Slot waiting can cause head-of-line blocking. Keep worktrees/output bases through
review/revision; external tool caches can remain shared. Cache hits are not
guaranteed and no persistent build lane is created.

Transcript calls show exact model/requested thinking and submission status;
Pueue owns authoritative completion. Live output includes assistant text and
numbered tool start/end markers with bounded allowlisted previews, not thinking,
file/replacement bodies or tool result bodies. Paths/patterns and assistant text
may still be sensitive. Reports and worker logs retain full output. Actual model
usage stays in the child transcript, not the parent's token totals.

### Timing and usage telemetry

Pi workers print a line per assistant response: elapsed time, first-output latency,
reported output tokens, observed provider-request count and outcome. The response
clock starts at turn start, so it includes context preparation and provider waits,
not just server inference; it stops before tools execute. First output means the
first nonempty text, thinking or tool-call delta, **not** first visible text or an
exact token timestamp. Thinking content is never logged. Request counts are not
retry counts: provider-internal retries may be invisible.

At settlement a worker summary reports elapsed time, summed response time, union
of tool execution intervals, check time (a subset of tool time), response count,
tool errors and output tokens. Unattributed overhead is not called model time.
Checks include lock waiting. Abruptly killed workers may lack a final summary.
Claude response logs show observed stream duration from `message_start` to the
observed completion, not request latency, provider inference time or time spent
waiting before the stream started. Completed-envelope-only fallback has duration
`n/a`. Response summaries deduplicate repeated CLI envelopes by message identity;
input/output/thinking token counts appear only when explicitly reported. Thinking
content and continuation prompt text are never rendered. Missing fields show
`n/a`, never invented zeros. A thinking notice proves observed activity, not
ongoing liveness during a later silence. No heartbeat or watchdog is added.
Claude `metrics.jsonl` still contains only final CLI aggregate API time, turns
and usage; the new response diagnostics live in the timestamped worker/Pueue logs.
Abrupt cancellation can leave a response without a summary.

Each attempt retains private `metrics.jsonl` alongside `worker.log`, including
revisions in their own artifact directory. Records carry `schemaVersion: 1`, a UTC
record timestamp, backend and record type (`response` or `summary`). Durations are
milliseconds; `firstOutputMs: null` means no output delta was observed. Usage fields
`input`, `output`, `cacheRead`, `cacheWrite` are included only when the harness
reports finite nonnegative values. Summary usage sums the observed Pi responses;
it is not a guarantee of provider billing totals. No prompts, provider payloads,
thinking, tool bodies, credentials or error text are added to these records.
These diagnostics neither change the model context nor certify success/review.

## Deployment

The operator supplies executable paths, a private state directory, noninteractive
credentials, the external backend and runtime JSON. This package does not manage
services or install a runtime. `PI_DELEGATE_RUNTIME` names an absolute JSON file
with absolute `git`, `node`, `pi`, `flock`, `ssh`, `home`, `state`, `launcher`, an
absolute-component `path`, `revisionProtocol: 1`, and a `profiles` map. Add an
absolute `claude` executable path to opt in to Claude workers. Add an optional
`catalogue` array to expose named CLI routes:

```json
{
  "catalogue": [
    {
      "id": "claude-code/claude-sonnet-4-6",
      "name": "Sonnet through Claude Code",
      "backend": "claude",
      "model": "claude-sonnet-4-6"
    }
  ]
}
```

Only explicit Claude Code entries belong here; Pi's registry supplies local/OpenAI
Pi routes and Anthropic discovery aliases, which are always mapped to Claude Code.
The `claude-code` provider namespace is reserved; duplicate/malformed CLI entries
or a colliding Pi provider fail closed. Entries are deployment policy, not proof
that a CLI model is currently supported or authenticated. Existing runtimes
and manifests without backend metadata still default to Pi, subject to the
Anthropic prohibition at runner validation. The selected backend
is frozen per task/attempt; changing the configured CLI path still requires
retaining the matching immutable runtime for queued/running jobs.

For example, a trusted check wrapper could accept a kind and literal test names:

```json
{
  "profiles": {
    "project": {
      "command": "/opt/project-tools/check",
      "args": ["--workspace={worktree}", "--output={outputBase}", "{kind}", "{targets}"]
    }
  }
}
```

This is only the profiles portion of the runtime. Supply the other fields above
using paths appropriate to the installation. No profile names are built in.
`delegate_task.profile` selects one configured profile; its absolute command and
argument template are copied into the immutable task manifest. Later runtime
profile edits do not replan existing tasks or revisions.

Arguments are passed directly without a shell. `{worktree}`, `{outputBase}` and
`{kind}` expand literally within arguments; the one required standalone
`{targets}` token expands to the planned target arguments. Targets are bounded
identifier/path strings, not flags, shell expressions or arbitrary argv. A trusted
wrapper can translate this interface to the project's build/test tools. The output
path is stable across revisions; the wrapper is responsible for using it. A
wrapper that interprets targets as code defeats this capability boundary.

For recoverable attempts use the scoped runtime described above. Unscoped
runtimes can still run legacy tasks/revisions, but cannot use `delegate_resume`.

Materialize the `launch.sh` template into an executable launcher: replace `@bash@`
with the absolute Bash path (unquoted, without whitespace, in the shebang), and
shell-quote replacements for `@state@`, `@flock@`, `@node@` and `@runner@` (packaged
`scope.mjs` for recoverable attempts; legacy `run.mjs` otherwise). Set the launcher's absolute path in the runtime. State must be private and user-owned;
executables/templates/runtime configuration must be trusted. No foreground
environment is implicitly copied. Never embed secrets in templates or commands.
Do not load a separate delegate extension alongside the root package. Restart Pi
to pick up a changed environment. No Pueue daemon restart is needed.

Older task manifests lacking a frozen verification command cannot be checked or
revised with this runner; it fails closed instead of inferring a command. Keep the
matching runner/configuration and retained evidence for in-flight older tasks;
never manufacture a manifest or resubmit uncertain work to upgrade it.

## Tests

Run `npm run check` from the package root. Tests use temporary Git repositories,
fake Pi/Claude/check executables, actual stdio MCP protocol exchanges, real kernel locks, and the installed development Pi
1.3.0 loader (optional `PI_TEST_SDK` override). Recovery tests cover user denial,
non-UI/abort/stale-state rejection, independent containment evidence, frozen plans,
foreground fixes and cross-tool/concurrent duplicate claims. Optional
`PI_TEST_SCOPES=1 node --test extensions/delegate/test/recovery.test.mjs` also
exercises the local user systemd manager with a fake worker and no model calls;
ordinary checks skip that explicit live-manager smoke test. No live Pueue daemon, model, real
monorepo build, activation or publication is involved. Snapshot tests cover mixed
staging, inherited additions, deletions/renames, binary/unusual filenames,
symlinks/executable modes, ignored caches, split indexes/linked sources, source
movement, fail-closed unsupported states, worker-only review and source drift. Linux with Git, Bash and
`flock` is required for these tests, matching the current runtime scope.
Cleanup-only fixtures additionally cover removed linked sources, previous custody,
ordinary new finalization identity receipts, clone/alias/replaced-source rejection,
legacy-archive refusal, exact operation/session binding, no custody append,
exclusive claims, interrupted cleanup and stale/denied/non-UI confirmations.
Legacy recovery fixtures cover explicit runtime/mode/selections, truthful missing
historical identity, read-only assessment, preservation of old receipts/builds/
sessions, partial/modern binding rejection, retained terminal/stopped/revision
barriers, denial/stale mode/data/lifecycle/session, concurrent one-shot disposal
and interrupted claims with no retry. They create old-schema fixtures only in
temporary repositories; no production receipts are rewritten.
Finalization/disposal fixtures additionally cover archived reconciled provenance,
second-claim fencing, irreversible selections, mount-inventory/bind-mount rejection,
held-directory symlink replacement, interrupted archives/deletions, concurrent
claims, UI denial/abort/navigation and read-only ownership/allocation inventory.
They do not mutate real task data, mount tables, providers or daemon history.
