---
name: delegate-cleanup
description: Inventory retained Pi delegate worktrees/build data and perform separately authorized finalization or permanent payload disposal. Use after integration/discard or when investigating delegate disk growth; never purge by age, reset Pueue, or delete task directories manually.
---

# Retained delegate cleanup

Read [the lifecycle contract](../../extensions/delegate/README.md#explicit-finalization).
Use only tools actually installed in the current Pi process and enabled by its
runtime. This skill does not deploy code, grant custody, authorize deletion, or
make older tasks recoverable. Missing tools/evidence are blockers, not permission
to emulate them with shell deletion or a different task ID.

## Inventory first (read-only)

`scripts/inventory.mjs` reports task ownership, repository/worktree/branch
registration and allocated blocks by build/archive/log/evidence category. It uses
the existing `PI_DELEGATE_RUNTIME`, never starts a model/build/server, and labels
all candidates **unassessed**. Its output contains private local paths; keep any
saved report private. It is not a deletion manifest or a liveness check.

Fish-compatible invocation, with no shell initialization or credential copying:

```fish
set -l delegate_node (jq -r .node "$PI_DELEGATE_RUNTIME")
"$delegate_node" /absolute/path/to/pi-repo/skills/delegate-cleanup/scripts/inventory.mjs
```

Resolve the script relative to this skill when using agent tools. Inspect the
original manifest/submission, all revision attempts, current backend identity,
current independent containment proof, current review/checks and intended
integration/discard. Distinguish active, unknown, unreviewed, unmerged, missing
repository and genuinely disposable state. Age, branch names, a merge, absent
Pueue history or `result.json` alone never establish safe disposal. Inventory
file sizes do not prove actual reclaimable space. Legacy `bazel-output` is reported
separately; the current disposal tool does not remove it or make legacy uncontained
attempts eligible.

## Two different operations

1. **Archive-and-remove:** after main-agent review and feedback, authorized
   integration or an explicit discard decision, call `delegate_finalize` with
   the latest nonce/current reviewed fingerprint and disposition. It requires a
   fresh interactive confirmation and fresh terminal/stopped evidence for every
   attempt. It removes only the owned worktree/unchanged delegate ref, retaining
   recovery archives, build outputs and diagnostics. `discarded` is a work
   disposition, **not permanent deletion**. A Git merge does not dispose of local
   data. Integrating changes never automatically authorizes disposal.
2. **Permanent payload disposal:** only after successful finalization, and after
   explicit approval of the exact task and payload groups, use `delegate_dispose`.
   Task plus latest nonce assesses read-only and returns `expectedFinalization`.
   Supply that digest and explicit `selections`: `build-output`, `recovery`, or
   both, for a separate fresh UI confirmation. `recovery` irreversibly removes
   `source.bundle` and `local-files.json`; it creates no replacement archive.
   `build-output` removes only the per-task output tree, never shared symlink
   targets. One permanent disposal claim is allowed per task: select the complete
   approved group set together. There is no automatic second pass or retry.

Confirm foreground users/build servers are idle before either operation. Worker
cgroup evidence cannot fence unrelated foreground activity or an external Bazel
server. Do not stop processes without the applicable authorization. Denial, no UI,
stale evidence, reused refs, interrupted claims or partial failures block cleanup;
retain the records and investigate, never clear claims or retry automatically.

## Ownership across sessions

Prefer the original session/branch. A handoff restores context, not ownership.
`delegate_reconcile` supports one foreground-custody transfer of an original
scoped attempt using bound original terminal evidence and fresh stopped proof.
Reattach in the same receiving session when its append was lost. Another session
cannot gain authority from the UUID. Revisions, legacy containment, changed boots,
missing/contradictory evidence and pending claims stay blocked.

Reconciliation itself permits no deletion. Updated finalization can separately
confirm cleanup of that reconciled original; it preserves the reconciliation
claim and acquires a second exclusive finalization claim. Its terminal evidence
stays `RECONCILED_EXITED` with `backendAuthority: false`. It never fabricates a live
Pueue record. Revision/recovery remain disabled. Finalized historical tasks cannot
be adopted into a new session through the original-attempt reconciliation tool;
use their owning session, or report the unsupported case rather than bypass it.

## Protected records and truthful retention

Never delete entire task directories, originating Pi/Claude sessions, unrelated
repositories, shared SDK/cache targets, real-mail plans/approved sets or Trash
journals. Inspect payload scope for protected operational data before approving
any selection; if present, stop and arrange a separately reviewed preservation
plan. In particular, an unknown-outcome Mailhub batch requires its original
plan/set and journal for metadata-only status investigation, not another POST,
provider retry or journal deletion. This lifecycle tool grants no mail/provider
operation or unknown-outcome override.

Required lifecycle records remain: task/attempt/submission identity, permanent
claims, reconciliation provenance, results, containment, finalization
intent/ready/receipt, disposal intent/receipt and review/check evidence. This
version conservatively also retains briefs, reports, feedback, logs and session
artifacts; there is no age limit, automatic pruning, log/session purge, or generic
permanent deletion tool. Large unselected data can therefore remain.

Report exact tasks/payload groups actually removed and reasons others remain
blocked. `unlinkedAllocatedBytes` excludes multiply-linked files, but is not a
filesystem free-space guarantee: open files, snapshots and concurrent activity
can retain blocks. Compare private before/after inventories and free space with
those limitations; never describe archived bytes as reclaimed space. Finalization
or passing CI is not proof the parent feature is complete.
