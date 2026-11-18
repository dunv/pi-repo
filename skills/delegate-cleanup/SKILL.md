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
registration and task-state allocated blocks by build/archive/log/evidence category.
By default it validates worktree root paths but does not recursively scan their
contents. Add `--worktrees` only when worktree allocation is needed; that scan can
be expensive. Task-state scans
still traverse build outputs and can be large. The JSON flag
`worktreeAllocationRequested` identifies the scope; omitted `worktreeAllocatedBytes`
means unmeasured/unavailable, never zero. A failed optional worktree scan adds a
blocker without hiding the task-state accounting or registration results. It uses
the existing `PI_DELEGATE_RUNTIME`, never starts a model/build/server, and labels
all candidates **unassessed**. Its output contains private local paths; keep any
saved report private. It is not a deletion manifest or a liveness check.

Fish-compatible invocation, with no shell initialization or credential copying:

```fish
set -l delegate_node (jq -r .node "$PI_DELEGATE_RUNTIME")
"$delegate_node" "$HOME/.agents/skills/delegate-cleanup/scripts/inventory.mjs"
# Optional, potentially expensive worktree allocation scan:
"$delegate_node" "$HOME/.agents/skills/delegate-cleanup/scripts/inventory.mjs" --worktrees
```

The installed skill-directory symlink and a direct checkout path are both supported.
For another skill location, substitute its absolute script path. `--help` describes
the scan modes without requiring a runtime; unknown or positional arguments fail.
Resolve the script relative to this skill when using agent tools. Inspect the
original manifest/submission, all revision attempts, current backend identity,
current independent containment proof, current review/checks and intended
integration/discard. Distinguish active, unknown, unreviewed, unmerged, missing
repository and genuinely disposable state. Age, branch names, a merge, absent
Pueue history or `result.json` alone never establish safe disposal. Inventory
file sizes do not prove actual reclaimable space. Legacy `bazel-output` is reported
separately; the current disposal tool does not remove it or make legacy uncontained
attempts eligible.

## Separate operator-attested retirement exception

For an explicitly obsolete draft whose historical containment/terminal-review
requirements cannot be satisfied, a **separate reviewed deployment** may enable
`retirementProtocol: 1` and `delegate_retire`. Do not emulate this tool using shell
removal or change a runtime to enable it implicitly. Existing cleanup/finalization/
recovery/disposal gates remain unchanged. Retirement means abandoning a draft,
not proving it integrated, completed or stopped.

- Assess with `{task, repository: CANONICAL_MAIN, reason}` and no expected fields.
  Complete admitted original/revision chains and exact private original owning
  session/job identities are required. Read the full retained draft, every new/
  local/ignored file, existing feedback and every attempt. Never infer obsolescence
  solely from a parent merge or a branch name.
- Review the current complete backend observations and process-reference scan.
  Active/UNKNOWN/contradictory jobs, unresolved admissions/claims, prior lifecycle
  operations, protected operational evidence or unsupported/oversized archives
  block. Rebooted/uncontained attempts can be assessed without manufacturing a
  stopped proof. Absence and KILLED stay observations, never terminal/stopped proof.
- `/proc` can expose positive cwd/open-file/task-UUID references, but cannot prove
  unreferenced or escaped workers are absent. Investigate listed permission-limited
  PIDs independently. If the human cannot establish that all original/custodian/
  foreground/old-client/build users and workers/descendants are idle, stop.
- Obtain explicit exact-task discard authorization and the independent human
  idleness declaration, then supply the same reason and both returned
  `expectedEvidence`/`expectedFingerprint` fields in this receiving session for
  fresh UI confirmation. Denial/non-UI/stale evidence grants nothing.
- The tool archives source/local/ignored files and symlink targets (without
  dereferencing them) before removing the worktree/unchanged ref. Permanent
  latest-continuation and retirement claims fence updated cooperating clients;
  old clients must stay idle. Never clear a claim or retry partial retirement.
- Report `operator-attested-retirement`, `discarded`, `terminalVerified: false`,
  `stoppedProof: false`, `backendAuthority: false`. Preserve original history,
  results, containment, claims, feedback, logs, build outputs and recovery copies.
  Potential Mailhub plans/approved sets/Trash journals and unknown-outcome state
  stay protected; the exception grants no provider operation.

The receipt is `retired.json`, not ordinary finalization. This archive-only
operation does **not** enable `delegate_dispose`/`delegate_prune` or permanently
remove retained build/recovery payloads. A further disposal protocol requires
separate reviewed implementation/deployment and explicit approval. See the
lifecycle contract's operator-attested-retirement section for limits.

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
be adopted into a new session through the original-attempt reconciliation tool.
The separately enabled cleanup-only path below grants no custody and has its own
repository/evidence gates; otherwise use the owning session or report the blocker.

## Historical cleanup without custody transfer

When installed and explicitly enabled with `cleanupProtocol: 1`,
`delegate_cleanup` supports original scoped attempts across sessions and after a
linked source checkout was removed. This is **not** onward foreground custody,
worker recovery, an ownership reset, or permission to dispose of a task.

1. Provide the exact task UUID, `repository` (the existing canonical **main**
   checkout, never inferred from cwd), and `action: "finalize"` with an explicit
   `disposition`, or `action: "dispose"` with the intended payload `selections`.
   Omit all `expected*` fields for read-only assessment. Before finalization,
   independently inspect the retained draft and existing review/feedback. A
   corrected parent merge does not make an unchanged defective draft integrated.
2. Review the returned repository identity, task, archive/payload scope and expected
   fields. Reassess with different selections if necessary: the assessment binds
   the **exact** operation and receiving session. No custody reference is appended
   to that session. Ordinary review/feedback can still require the prior owner;
   cleanup does not grant edit/check/retry authority or waive missing feedback.
3. Only after explicit approval, supply `expectedNonce`, `expectedEvidence` and
   `expectedFingerprint` (finalize) or `expectedFinalization` (dispose), retaining
   the exact disposition/selections. Each actual operation requires its own fresh
   interactive confirmation, including confirmation that originating/custodian
   sessions and foreground/external build users are idle. Finalization preserves
   recovery/build data; disposal is separately assessed and confirmed.

The main checkout and retained worker must resolve to the **same local Git common
directory**, with canonical user-owned paths and recorded device/inode identities.
A clone, origin URL, matching commit or bundle is not repository identity. New
finalizations durably bind the main checkout/common-directory identity into their
authorization, ready record and receipt so later disposal need not depend on the
removed linked source path. Historical finalized archives **without this binding
stay blocked by default**. A separately enabled, explicitly confirmed recovery-only
exception is described below; do not recreate source paths, rewrite receipts or
substitute a matching clone to fabricate historical identity.

Every cleanup gate revalidates the original private terminal tool record, exact
backend admission identity, unchanged result/reconciliation provenance and fresh
same-boot stopped proof. Status remains archived (`RECONCILED_EXITED`,
`backendAuthority: false`, `authority: "cleanup-only"`), never invented Pueue
ownership. Revisions, pending/interrupted claims, changed boots, missing records
and contradictory backend observations remain blockers. Existing permanent
continuation/reconciliation/finalization/disposal claims are preserved. No claim
is cleared and no new worker or generic transfer is enabled. Existing destructive
operations retain their exclusive claims, bounded archives and path/symlink/mount
checks. Denial creates no lifecycle records; interrupted claimed operations remain
blocked rather than permitting a second cleanup attempt.

This feature needs separate reviewed deployment/runtime enablement and a fresh Pi
session; changing source or reading this skill does not enable it. It does not
retroactively make legacy archives safe or authorize any real-mail/provider action.

## Later retained-artifact pruning

When a reviewed deployment explicitly enables `retentionProtocol: 1` alongside the
cleanup/disposal/reconciliation/finalization/containment protocols, `delegate_prune`
offers a **separate** later operation. It is never a replacement for
`delegate_dispose`: it applies only after a coherent completed `disposal-claim.json`
and `disposed.json`, and interrupted/partial/mismatched ordinary claims remain blocked.
Use the exact historical task UUID and an explicit canonical main `repository`.

First call with explicit retained `selections` and no expected fields. The assessment is
read-only and returns nonce, finalization, evidence and exact inventory fields. Inventory
pages default to 50 rows (`inventoryOffset`, `inventoryLimit` up to 1,000). Follow
`nextInventoryOffset` until null, verifying an unchanged `expectedInventory` digest
across pages; changed evidence requires a fresh assessment, not combining snapshots.
Confirm all original/custodian/foreground/external build users are idle, inspect protected
operational contents, then supply all returned fields in the same receiving session for
a fresh UI confirmation. Every operation rechecks independent repository identity,
original archived terminal evidence/backend consistency and same-boot stopped proof.
There is no custody transfer, worker/provider/process action, task-root deletion, retry
or claim clearing.

Only currently retained `build-output`, recovery's `finalization/source.bundle` and
`finalization/local-files.json`, and an exact package-produced diagnostics allowlist are
candidates: root `brief.md`, `report.md`, `worker.log`, `metrics.jsonl`, `tracked.diff`,
`claude-result.json`, package check logs named `check-<0..7>-<UUID>.log`, and regular private unshared
Pi transcript files named `<timestamp>_<UUID>.jsonl` directly in task-local `sessions/`.
Unknown/nested session entries block rather than being recursively purged. Check
intent/result summaries, feedback records, worker result/containment, invalid-tool
records, lifecycle identities, finalization/disposal evidence and repository bindings
stay retained. External initiating/custodian Pi/Claude sessions always stay retained;
`task.owner.file` is required for future `archived()` validation and is never pruned,
including through a symlink/hardlink alias. Diagnostic content is read through held
no-follow FDs and content hashes bind confirmation. Stop on detectable Mailhub/real-mail
plans, approved sets, Trash journals or unknown-outcome evidence. Recovery archive
paths/content receive a bounded check, but operator inspection of arbitrary build/archive
content remains mandatory: classification cannot prove arbitrary data is safe.

Each successful later operation appends a permanent receipt chained to the completed
predecessor. Missing receipts, dangling claims, duplicate predecessors or unknown
records block all future operations rather than allowing a retry. `compactDisposalClaim:
true` is an empty-selection, separately confirmed audit compaction: it replaces only
the completed disposal claim with a held-root fsync/rename durable tombstone retaining
its same original operation ID/authorization fields, all non-file proof fields, original
byte SHA-256 and inventory digest/count/allocation summary. The assessment names exact
old claim metadata/allocation and irreversible loss of per-file paths/stamps/kinds/
targets/allocation details. Hardlinked claims cannot be replaced. A crash leaves the new
claim pending and blocking; a tombstone alone does not declare completion. Complete-chain
receipts and tombstone hashes are revalidated. Only the original disposal inventory is
compactable; later prune claims retain their own selected-file inventories.
Compaction is not archival or a free-space guarantee. Report candidate/retained groups,
before/after allocated blocks and filesystem free-space observations with durable-record,
open-file, snapshot and concurrency limitations.

## Explicit legacy recovery disposal

Older completed finalizations can lack independent historical repository identity.
That missing binding need not make recovery copies undeletable forever, but it
must not silently become verified identity. Only after separately reviewed
publication/deployment, enable `legacyRecoveryDisposalProtocol: 1` alongside all
cleanup/disposal/scoped protocols and start a fresh Pi session. No installed
runtime is changed by reading this skill.

Use `delegate_cleanup` with the exact task UUID, an explicitly selected canonical
main `repository`, `action: "dispose"`, `selections: ["recovery"]` and
`legacyRecovery: true`. Omit expected fields for read-only assessment. The current
repository is path/ownership checked and checked for reused delegate refs; it is
**operator-selected, not proven to be the historical repository**. An existing
original source path must still agree. A matching bundle/commit/clone is not a
replacement identity proof.

This mode is allowed only when the receipt, authorization, intent and ready record
entirely lack repository bindings. Partial/null/conflicting or modern bindings
are not legacy exceptions. Never edit production records to downgrade them.
Successful finalization must already be complete and coherent; original private
terminal review, exact backend identity/consistency, fresh same-boot stopped proof,
absent worker checkout/ref and existing one-shot claim gates still apply.
Revisions, unknown outcomes, rebooted/legacy-uncontained attempts, incomplete or
interrupted finalization/disposal remain blocked. This is not a general legacy
worker/worktree cleanup route or a cache-deletion option.

Independently inspect the exact archive payloads and existing review first.
Preserve protected operational evidence. Obtain approval for irreversible loss of
those recovery copies despite the missing historical binding, then supply the
assessment's `expectedNonce`, `expectedEvidence`, `expectedFinalization` and the
same exact selections and `legacyRecovery: true`. Each task gets a fresh UI
confirmation naming the exception and requiring idle originating/custodian,
foreground and external build users. Denial/non-UI/stale state grants nothing.

Only `finalization/source.bundle` and `finalization/local-files.json` are deleted,
with held-directory traversal and the ordinary exclusive permanent disposal claim.
No replacement archive is created. Old records are never rewritten or backfilled;
the new claim/receipt explicitly record `legacyRecovery: true` and
`repositoryBinding: "operator-selected; historical identity unverified"`.
Identity, sessions, logs, previous claims and audit evidence remain. Report exact
removed/skipped tasks, observed allocation and free-space changes. This exception
never authorizes build-output deletion, finalization, source/worktree/branch
removal, provider actions, journal removal or retry of uncertain operations.

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
intent/ready/receipt, disposal intent/receipt and review/check evidence. Ordinary
finalization/disposal conservatively retain briefs, reports, feedback, logs
and session artifacts. The separately enabled later `delegate_prune` operation has no
age policy and can remove only its documented task-local diagnostics, including exact
allowlisted task-local worker transcript files and check-log/review content. It never
purges external initiating/custodian sessions, feedback/check summaries, unknown files
or arbitrary logs. Large unselected data can therefore remain.

Report exact tasks/payload groups actually removed and reasons others remain
blocked. `unlinkedAllocatedBytes` excludes multiply-linked files, but is not a
filesystem free-space guarantee: open files, snapshots and concurrent activity
can retain blocks. Compare private before/after inventories and free space with
those limitations; never describe archived bytes as reclaimed space. Finalization
or passing CI is not proof the parent feature is complete.
