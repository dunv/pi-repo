---
name: delegate-cleanup
description: Use disposable delegates through result handoff and one-step cleanup included in authorized delegation. Inspect or continue orphan workspaces without adoption; never delete active work or shared targets.
---

# Using disposable delegates

Read [the workspace contract](../../extensions/delegate/README.md).

## Normal flow

1. The main agent decides the bounded scope, interfaces, model/effort and checks.
   Discover with `delegate_environments` and explicitly select `source-review`,
   `implementation` or `implementation-checked`. Only the last accepts a verification
   profile/check plan; the others need empty checks and no profile. Read the stated
   isolation limits: host network/HOME access remain, not an OS sandbox. Start
   `delegate_task`; no implicit SDK setup or automatic model/environment fallback.
2. Wait for the worker/checks to finish. Do not edit or build concurrently in its
   workspace. Missing/unknown admission is not permission to submit again.
3. Collect with `delegate_review`. Personally inspect the full tracked patch,
   every new file, relevant context and current checks. Report your own verdict;
   the worker's report/exit zero is not acceptance and user diff review is not
   mandatory just because the work was delegated.
4. If needed, explicitly use `delegate_revise` for a fresh follow-up in the same
   idle worktree/build directory with the frozen environment/checks. Use the latest
   nonce/fingerprint from review. Legacy tasks without an environment descriptor
   are not silently upgraded for new worker execution.
   This can follow failed work; it is not automatic recovery or CLI `--resume`.
5. Apply useful changes to the parent, reconciling drift, or deliberately discard
   the result. Keep the needed outcome/check evidence in the main agent session.
   Integration/publication still need the owning repository's authorization.
6. Use `delegate_cleanup {task}` for inspection. Once the main agent has everything
   it needs, use `{task, disposition: "used"|"discarded", summary}` to remove the
   worktree/ref, build outputs and task-local records. Normal authorized delegation
   includes this final cleanup: no separate user confirmation or UI is required.
   **No archive, enrollment, expiry policy or later disposal step exists.**

Do not leave completed disposable workspaces indefinitely. Cleanup is the final
step of using a delegate, not a separate archival project. It is never triggered
merely by worker exit or before the main agent has actually used/discarded the work.

## Orphans

If the spawning agent is gone, its disposable workspace can be inspected, continued
or discarded by another agent. Original owner metadata is descriptive, not a custody
restriction. No adoption, original-session ancestry or terminal-history reconstruction
is required. Use normal foreground tools or the same review/follow-up/cleanup tools.

Parent death does not mean worker death. Current queued/running/unknown backend
jobs, worker/check scopes and task locks still block concurrent use or removal.
Do not stop processes, retry provider actions or guess that uncertain writers are
gone. Ensure spawning/orphan sessions and foreground/external build users are idle
before requesting removal. Unrelated desktop/container PID churn is not task state.

## Scope and failures

Only the exact registered task worktree/ref and its dedicated private task directory
are disposable. Never remove the main/originating session, shared SDK/cache targets,
unrelated repositories, or real operational plans/approved sets/Trash journals and
unknown-outcome provider evidence. Such data does not belong in disposable scratch;
if found, preserve it separately before cleanup. No provider action is authorized.

Symlink entries may be removed, never their external targets. Mounts, foreign-owned
entries, changed repository/ref/source, active/uncertain workers and unsafe paths
block rather than expanding removal scope. Removal permanently deletes all
task-local files, including ignored files; keep needed data first. Separate explicit
authorization is still required for legacy/manual cleanup or anything outside the
exact disposable workspace.

An interrupted cleanup leaves a closing flag in its current manifest while data remains.
Inspect the outcome before explicitly requesting the same cleanup again. There is
no automatic retry, permanent one-shot claim, custody grant or background sweeper.

Installing this policy does not alter old v1 manifests/claims/enrollments or restart
old workers. The new API does not reinterpret historical lifecycle records as v2
scratch. Legacy source can be inspected/reused directly; legacy cache removal needs
its separately approved exact scope and quiescence, preserving protected records.

## Optional disk inventory (read-only)

`scripts/inventory.mjs` uses the installed `PI_DELEGATE_RUNTIME` to report local
ownership/registration and allocated blocks. It never starts a model/build/server
or deletes data. By default it measures task state, not recursive worktree contents;
`--worktrees` opts into the more expensive worktree scan. Missing measurements are
unavailable, not zero. Results are unassessed—not a deletion manifest or proof that
workers/build servers are idle. Paths are private; do not publish them.

```sh
# Use the absolute node path recorded in PI_DELEGATE_RUNTIME:
NODE /absolute/skill/scripts/inventory.mjs
NODE /absolute/skill/scripts/inventory.mjs --worktrees
```

Direct paths and installed skill-directory symlinks are supported. `--help` needs
no runtime. Allocation is not guaranteed reclaimed space: open files, sharing,
snapshots and concurrent activity can retain blocks.
