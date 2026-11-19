# Disposable delegated workers

Delegates are temporary execution workspaces, not a durable recovery/archive
system. The main agent owns design, acceptance and integration.

## Main-agent delegation policy

[`orchestrator-policy.md`](orchestrator-policy.md) defines when delegation is
worthwhile: focused summaries, better model fit, separable parallel work, isolated
task guidance and independent examination. More agents are not inherently better;
coordination and verification costs matter.

It also supplies a provisional model/effort hierarchy: Opus/Sol for substantial
reasoning and unresolved design, Sonnet or a mid-tier coding model for ordinary
features, and validated cheaper/local models for bounded mechanical work.
Capability and effort are separate choices; exact catalogue routes and operator
restrictions take precedence. This is advisory prompt guidance, not a new runtime
router or a claim that benchmarks establish one universally best model. Jev
integration is deferred. Evaluate changes against representative worker tasks,
including review/correction effort and time/cost per accepted result.

The extension loads this file once per extension load and contributes a structured
`delegate_orchestration` system-prompt section before each run where `delegate_task`
is selected and not hidden. Other prompt sections are preserved; disabling/hiding
the tool removes this section. Reload the extension to pick up policy edits.
An explicitly forced full system prompt remains authoritative; this extension does
not replace it. The policy grants no additional permissions or execution modes.
In particular, the current implementation workspace is not an enforced read-only
research/review environment.

[`policy.md`](policy.md) remains the separate worker prompt for both Pi and Claude.
It is unchanged by the main-agent policy and is not replaced by it.

## How to use delegates

1. Define bounded work, decided interfaces, acceptance criteria and needed checks.
2. Discover/select an exact model and reasoning level; start `delegate_task`.
3. Wait for completion. Do not edit/check the workspace while its worker owns it.
4. Collect with `delegate_review`. Read the full tracked patch, every new file,
   relevant context and current check evidence. Report your own verdict; a worker
   report or exit zero is not acceptance. Do not delegate review to the user.
5. If needed, explicitly request a fresh follow-up with `delegate_revise`.
6. Apply useful changes to the parent checkout, reconciling source drift, or
   explicitly discard the result. Keep the needed summary/evidence in the main
   session. Integration/publication retain the repository's approval rules.
7. Call `delegate_cleanup` with the outcome/summary. After one exact confirmation,
   the workspace, ref, build output and task-local temporary records go away.
   **No archive is made. There is no enrollment, expiry or later disposal step.**

Do not put irreplaceable data, real operational plans/approved sets/Trash journals
or unknown provider-outcome evidence in disposable scratch. Preserve those outside
this operation; delegation grants no provider action or unknown-outcome retry.

## Five tools

- `delegate_models {backend?, provider?, query?, offset?, limit?}` discovers routes
  without model/auth calls. Catalogue presence is not worker readiness.
- `delegate_task {repo, brief, model, thinking, profile, checks, backend?}` creates
  an isolated sibling worktree and submits one fresh worker through Pueue.
- `delegate_review {task?, openDiff?}` lists disposable workspaces or collects an
  idle workspace's current result. `openDiff` is optional; review is the main
  agent's responsibility, not an extra mandatory human approval step.
- `delegate_revise {task, expectedNonce, expectedFingerprint, brief, model,
  thinking, backend?}` explicitly starts a new attempt in the SAME idle worktree
  and build directory with its frozen checks/profile. It can follow failed work;
  it is never an automatic retry or Claude `--resume`. Stale nonces/fingerprints
  and current live/uncertain jobs refuse another submission.
- `delegate_cleanup {task, disposition?, summary?}` inspects an idle workspace
  without the optional fields. Supplying `disposition: "used"|"discarded"` and a
  short summary requests one exact removal confirmation. The main agent must
  already have retained everything it needs. A compact outcome is appended to the
  receiving main session; task-local records are disposable.

## Orphans

A disposable workspace is not reserved forever to its original spawning session.
If that agent has gone away, another may inspect it, continue in the foreground,
request a fresh follow-up, or discard it. No adoption, custody transfer, session
ancestry reconstruction or special recovery tool is required. Original owner
metadata is descriptive, not authority over future work.

**Parent death is not worker death.** Current Pueue jobs (including queued and
unknown jobs), scoped worker descendants and a kernel task lock guard operations.
A lost admission reply is not permission to submit again: the adapter privately
extracts UUID references from current job commands so a queued/running worker can
still be found without exposing those commands or reading its owner's transcript.
No absence/KILLED observation is presented as historical completion proof.

A main agent may also have foreground commands or external build servers outside
worker containment. Ensure those users are idle before cleanup. The tool does not
stop processes and does not scan unrelated desktop/container PIDs. Unknown current
worker liveness remains a blocker, not a reason to guess or retry until lucky.

## Execution and source boundaries

- Anthropic selections use Claude Code only. Local/OpenAI selections use Pi only.
  Use an exact catalogue ID; no fuzzy selection or silent model/provider fallback.
- Set thinking explicitly. Claude effort is `low/medium/high/xhigh/max`; Pi supports
  `off/minimal/low/medium/high/xhigh/max`, subject to configured model policy.
- Reserve local GMKtec models for small, well-specified mechanical slices. Choose
  a stronger route explicitly for complex multi-file reasoning/policy alignment.
- Preparation snapshots staged/unstaged source and nonignored new files using a
  private temporary Git index. The parent's branch/index/files are not changed.
  Dirty baselines are internal snapshot commits, not commits on the parent branch.
  Ignored caches are not copied; tracked ignored additions are preserved.
- Review compares against that baseline, so inherited parent changes do not become
  worker work. Foreground continuation commits are included in review/fingerprints.
  Conflicts, sparse/assume-unchanged entries, submodules and oversized snapshots
  fail rather than silently omitting source (10,000 paths / 64 MiB source bound).
- Pi workers have read/search/edit/write and planned-check tools, not shell, Git,
  publication, Pueue or delegation tools. Three cumulative unavailable-tool calls
  stop a Pi attempt and retain its partial result for inspection. No retry follows.
- Claude runs a restricted fresh CLI with a private stdio MCP exposing equivalent
  source/check operations. Hooks, other tools/MCP and session persistence are off;
  no extra HOME transcript is retained. Output/report/checks live in task scratch.
- Source write guards reject traversal, Git/agent configuration and external
  symlinks. Check commands are explicitly configured, frozen and invoked as literal
  argv. No model-selected shell or implicit SDK bootstrap is provided. The deployed
  Bazel profiles use `--batch` so checks do not leave persistent servers holding
  task output directories or worker scopes alive.
- These are capability boundaries, **not an OS sandbox**. Trusted check commands
  and HOME-based worker authentication still run as the local user. Do not escape
  the scope or enlist external mutable services without independent lifecycle care.

## Current-state cleanup, not historical lifecycle proofs

Each disposable task binds its private state directory, registered worktree,
branch and canonical local Git repository. A clone, alias, changed repository,
locked/reused ref, mount crossing or unsupported entry is not silently accepted.

Workers/checks hold shared kernel task locks; main-agent task mutations and cleanup
hold the exclusive lock. Workers wait for submission metadata to finish; cleanup
fails promptly if busy. Small zero-content lock files live outside task directories
so deleting a workspace cannot replace its lock underneath a competing caller.

Dedicated cgroup-v2 scopes cover worker/check descendants. Current empty/removed
scopes permit handoff; a genuine later boot does not make old workers survive, but
any current same-name populated scope still blocks. No original terminal review,
old Pueue numeric identity, custody receipt or global PID snapshot is required.

Cleanup rechecks current liveness/source/repository after confirmation, removes
only the registered worktree and unchanged ref, then deletes task-local contents
through held directory descriptors. Symlinks are unlinked, never traversed into
shared SDK/cache targets. Main/originating sessions remain outside this scope.
There is no archive-size limit because nothing is copied into an archive.

Interrupted cleanup retains the current manifest with a closing flag until the
final removal step. Cooperating writers reject a closing workspace. Inspect a failure;
an explicitly requested cleanup can finish remaining paths through the same API.
There is no permanent one-shot disposal claim, automatic retry, provider action,
background retention runner or global task-directory sweep.

## Storage and deployment

Source: `<repo>.worktrees/delegate-<initiator-label>-<UUID>`.
Scratch: `<runtime.state>/<UUID>` with current v2 `task.json`, per-attempt brief,
result/report/check/log/session files and `build-output/`. Follow-ups keep their
separate attempt files under `revisions/` until the whole workspace is cleaned.
Main/originating external sessions and Pueue's own backend history are not deleted.

The operator supplies `PI_DELEGATE_RUNTIME`: absolute trusted `git`, `node`, `pi`,
`flock`, `ssh`, `home`, `state`, `launcher`, an explicit absolute-component `path`,
`revisionProtocol: 1`, `containmentProtocol: 1`, `disposableProtocol: 1`,
`systemdRun`, optional `claude`, and named verification `profiles`.
Profiles contain an absolute `command` and literal `args` with one standalone
`{targets}` and optional `{worktree}`, `{outputBase}`, `{kind}` placeholders.
`piModelPolicy` optionally maps exact Pi provider/model IDs to allowed thinking
levels; configured empty provider maps disable those providers. Claude catalogue
entries use exact native `claude-*` models and `backend: "claude"`.

Materialize `launch.sh` with the trusted Bash/state/flock/node paths and runner
`scope.mjs`. Six shared worker slots and one heavy-check lock bound cooperating
execution; Pueue session groups separately have three slots. No extra daemon or
watcher is started by loading this extension. Explicit publication/activation and
fresh Pi sessions are required to deploy changes.

Installing this version does not rewrite or delete historical v1 manifests,
claims, archives, sessions or existing enrollment records. Old immutable workers
keep their original code/runtime. The new cleanup deliberately does not reinterpret
legacy lifecycle data as v2 disposable scratch. Inspect/reuse legacy source
through ordinary foreground tools; separately approved legacy cache cleanup must
preserve protected records and shared targets. No backwards-compatibility lifecycle
framework is retained in this package.

## Verification

Run `npm run check` at the package root (Node 24+, Linux/Git/Bash/flock). Tests use
synthetic repositories, fake worker/backend executables, kernel locks and Pi's
actual loader. They cover dirty snapshots, model routing, frozen checks, streaming,
orphan use, active/uncertain writers, one-step removal, shared-target/session
preservation, stale confirmation and interrupted cleanup. No real model, daemon,
retained task deletion, SDK bootstrap or system activation is involved.
