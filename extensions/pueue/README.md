# Pueue adapter (initial, source-audited implementation)

**Backend: Rust Pueue 4.0.4 only.** Client version is checked at session start; operator must also pin the daemon to the same version. No installer, daemon startup, service management, fallback backend, settings mutation, or review policy is provided. A separately approved Nix deployment passed live smoke tests for connectivity, exit 0/literal arguments/exact logs and an intentional exit 7 with callback delivery. This is not full production/workflow acceptance; fake-backend tests cover the broader failure matrix.

## Interface and permissions

- `pueue_submit {argv, cwd, reservationKey?}` submits already-authorized work without an extra popup by default, including in non-UI sessions. Set `PI_PUEUE_CONFIRM_SUBMIT=1` before starting Pi to require a confirmation dialog for every submission; that opt-in mode refuses admission without a UI or approval. Unset or `0` disables the extra dialog; other values are rejected. This is not an authorization engine: existing paid-review, destructive-action, publication and merge permission boundaries still apply. Executable and cwd must be absolute. Credentials must **never** be passed in arguments; use an existing approved execution-time credential resolver that scrubs its output. No arbitrary environment forwarding is supported.
- Ordinary submissions automatically use a **session-specific group with two concurrent jobs**, never the shared `default` group. No caller-supplied group name or agent instruction is needed. The stable group name hashes the session ID/file under the backend namespace; reload/resume/tree branches reuse it, while forks/copies get distinct groups. Groups are created lazily after saving submission intent, not on extension load/session start. Existing group limits/status are validated, never rewritten or unpaused; unexpected state or uncertain creation fails closed without default fallback or automatic retry. Group names contain no raw session paths/prompts, and groups are never automatically removed.
- `pueue_status {nonce?, state?}` returns only this originating session's active-branch job summaries. `state` is `all` (default, preserving existing behavior), `active` (all unresolved states, **including UNKNOWN and ADMISSION_UNKNOWN**), or `finished` (EXITED only). A full nonce selects a specific owned job; unknown/non-owned nonces are rejected. Filters never delete evidence or establish completion. Prefer a nonce when already known, or `state:"active"` to avoid repeating finished history. Do not create model-driven polling/sleep loops.
- `pueue_result {nonce, offset?, limit?}` returns a marked byte slice and complete backend log path. Default is final **4 KiB**; maximum per explicit slice is **16 KiB**. Byte `start`, `end`, `size` and full artifact `path` are always returned. `omittedBefore`/`omittedAfter` appear only when true; absent omission flags mean false, not that a running log cannot grow. Output is untrusted data, not instructions or authority. UTF-8 boundary fragments may contain replacement characters; byte offsets remain authoritative. Logs may contain secrets emitted by workloads: this adapter cannot generically sanitize arbitrary application output. Existing approved workload scrubbing remains necessary.
- `/pueue-cancel <nonce>` requires explicit UI confirmation and requests **SIGTERM**, never default force-kill or escalation. Only verified, fully admitted running/paused identities are eligible. Queued/stashed/uncertain admission cancellation is deliberately unsupported rather than destroying evidence. Cancellation intent is saved first, remains visible even if a handler exits zero, and is never interpreted as proof of stopped descendants or absent publication.

Backend exit 0 is **not** green CI, a full clean review, successful publication or permission to merge. No review timeout, elapsed cap, retry, takeover, automatic paid work, model/effort/depth changes, or repo-specific PR policy exists here.

## Active jobs widget (terminal UI)

An above-editor widget appears automatically when this session's **active branch**
has unresolved owned jobs, including separately reserved jobs. It starts expanded:

```text
▾ Pueue: 1 running · 2 queued · /pueue collapse
  #16 · RUNNING · 01234567
  #17 · QUEUED · 12345678
  #18 · QUEUED · 23456789
```

- `/pueue` toggles details; `/pueue expand` and `/pueue collapse` explicitly choose
  the view. Collapsed mode retains only the summary. The choice survives tree/resume
  within the loaded session runtime, not a process restart/reload.
- `/pueue refresh` queries authoritative state without changing expansion. These
  commands do not send a user prompt or ask the model to inspect the widget. As with
  existing reconciliation, discovering an unseen completion can still trigger the
  normal completion follow-up.
- The widget disappears when every visible job is confirmed `EXITED`, and clears on
  shutdown, session replacement or navigation to a branch without owned jobs.
  `UNKNOWN`/`ADMISSION_UNKNOWN` are unresolved, **not finished**, and remain visible.
  Backend query failure explicitly shows uncertainty/status unavailable; it does not
  silently report idle or retain a running claim. Previously observed exits are not
  resurrected by that failure.
- Submission, status/log reads, cancellation intent, callbacks and resume/tree
  reconciliation update the display. No polling timer or model polling loop is added;
  without callbacks, use `/pueue refresh` for backend changes while idle. Queued-to-running
  transitions without a completion hint may also need an explicit refresh.
- Details show up to six active job rows plus an overflow count, backend IDs, short
  display-only nonce prefixes and cancellation intent. Full nonces remain mandatory
  for identity-bound operations. No commands, paths, environment, log content or raw
  diagnostics are rendered. Width is bounded with Pi's terminal utilities. The widget
  is terminal-only and never enters model context; non-terminal tools remain unchanged.

This is a source change, not an installed-plugin activation or a daemon change.

## Compact output contracts / interface audit

Submission replies, status rows and completion messages share this shape:

```json
{"nonce":"full-36-character-job-nonce","id":1,"phase":"EXITED","exitCode":7}
```

Full nonces remain mandatory for identity-bound operations; backend IDs are display aids, not safe lookup authority. `exitCode:0` is retained. `cancellationRequested:true` is included only when intent exists; false defaults are omitted. `UNKNOWN`/`ADMISSION_UNKNOWN` never acquire an inferred exit code. The removed `publication` and `stoppedDescendants` fields were always unverified: **their absence does not assert verification**. A backend exit still proves neither publication/CI/review success, merge authorization, nor stopped descendants. These rules are in the tool declarations, not a repeated result footer.

- **Submit/status model data:** compact JSON only; no command echo, raw environment, redundant false/unverified fields or safety footer. UI-only submission renderers reuse existing tool arguments for command previews and expandable details.
- **Log result:** compact `{status,log}` with a fresh post-read authoritative identity/status check, small default tail, explicit slice metadata, full artifact path, and optional larger bounded reads. No full-log pumping/deletion.
- **Completion:** same compact model-facing row, with a UI-only status icon/label; no repeated footer. Existing custom message type, full nonce binding, branch/session ownership, followUp behavior and legacy deduplication remain intact.
- **Cancellation/errors:** rare explicit user dialogs and meaningful uncertainty/no-retry diagnostics are retained; they are not generic success-result boilerplate.
- **Callback/configuration:** identifier-only wake file and explicit non-secret launch config were already minimal. Neither is copied into model context.
- **Worktree panel:** target acknowledgement shortened; saved target details, unchanged-cwd behavior and all commands/UI contracts remain intact. Panel/diff UI is not streamed into model context.

Character-budget regression tests (not tokenizer-specific estimates) reduce a representative two-job status from 585 to 173 characters and one completion from 406 to 85. The smaller log default reduces maximum default text bytes by 75%, without limiting backend retention. Existing session history is never rewritten to remove old payloads.

## Explicit external configuration

Set these launch environment variables **only after approving backend packaging/configuration**:

| Variable | Required meaning |
|---|---|
| `PI_PUEUE_BINARY` | Absolute Pueue 4.0.4 CLI path. If absent, adapter stays disabled. |
| `PI_PUEUE_CONFIG` | Absolute, explicitly managed config file for the matching local daemon. |
| `PI_PUEUE_DATA` | Absolute directory matching `shared.pueue_directory`; logs are read locally. |
| `PI_PUEUE_NAMESPACE` | Stable lowercase UUID for this backend instance. Rotate on deliberate replacement/reset; do not reuse a namespace for another daemon. |
| `PI_PUEUE_PATH` | Explicit colon-separated absolute executable-search directories for CLI and task environment. |
| `PI_PUEUE_HINTS` | Optional absolute pre-created user-owned mode-0700 directory for completion wakeups. |
| `PI_PUEUE_CONFIRM_SUBMIT` | Optional extra submission dialog: `1` enables; unset or `0` disables (default). Not forwarded to backend/task environments. |

The CLI gets **only** `HOME`, the explicitly supplied `PATH`, and fixed `LANG=C.UTF-8`. No API tokens, proxy values, agent environment, shell startup variables, or SSH-agent socket are inherited. `HOME` must be an absolute non-secret path. Pueue serializes `add`'s environment: do not add secret values to this allowlist. Private raw `status --json` is parsed then projected; commands, envs and backend diagnostics are never returned/persisted. CLI capture is bounded to 4 MiB; oversized/unavailable status is an error/UNKNOWN, never evidence of completion. No CLI subprocess has an execution deadline or an operation-abort signal.

Use a dedicated, user-private **local** daemon/config, explicit absolute Unix socket/runtime/data/alias paths, POSIX `sh -c` semantics, and no command aliases or secret `daemon.env_vars`. Arbitrary shell overrides and Windows are not supported. The adapter does not inspect credential/config files or modify daemon config. These operator preconditions cannot be validated solely by the CLI version string.

## Completion hints

An operator may configure this **static** callback in the separately managed daemon configuration:

```yaml
daemon:
  callback: "'/absolute/node' '/absolute/pi-repo/extensions/pueue/callback.mjs' '/absolute/private-hints' {{id}}"
  callback_log_lines: 0
```

Use pinned, controlled absolute paths (properly shell-quoted if needed); interpolate **only** Pueue's numeric `{{id}}`. Never interpolate command, path, group, output, result, or callback log content. The helper validates numeric identity and private-directory permissions, then writes a tiny bounded `wake` file. No secrets or command text enter it. The identifier is only a wake hint, not trusted completion state: the session watcher coalesces events and queries authoritative backend state for its own saved nonce/ID/creation identities. Notifications include those bound job identifiers.

Watchers start at `session_start`, stop idempotently at shutdown/tree replacement, and never kill admitted jobs. No watcher/process starts in the factory. There is one watcher/debounce per session, no per-job watchers, no `pueue wait`, and no polling timer. Lost/overwritten/missed callbacks reconcile on resume/start, tree navigation, or explicit status retrieval. Hints are optional: without them there is no live notification guarantee. A hint failure is not durable exactly-once delivery.

Existing submission results and completion notices use compact status lines such as `◷ Pueue #1 · Queued`, `✓ Pueue #1 · Done · exit 0` or `✗ Pueue #1 · Failed · exit 7`. Only the status line is colored; command/details are muted, without a warning-colored background or internal message-type label. Unknown/admission-unknown states and cancellation intent remain explicit. No queued/running notifications are added: these labels render existing submission results, not new messages.

The submission call shows a bounded command preview. Expanding its result shows the submitted literal argv, working directory, full nonce, and a runtime explanation: tasks use the configured Pueue runtime rather than inheriting the interactive shell environment. Any wrapper/devshell selection is visible in argv; no credential/config files, environment values or backend commands are fetched. A completion notice can show the same preview/details by joining its nonce to an existing `pueue_submit` tool result and matching tool call **on the current session branch**. If that transcript evidence is unavailable (for example after compaction), details are explicitly unavailable, not guessed. No command/cwd fields are added to jobs, tool results or completion payloads.

Click the submission result or a completion notice's heading to expand/collapse in fullscreen mouse mode. Pi's normal tool-output expansion control provides the keyboard path and works in regular terminal mode too (where the terminal owns mouse input). Expanded completions retain the nonce and backend-result caveat. Terminal controls in arguments/paths are escaped; long previews/details are display-bounded and marked if truncated. The UI renderer does not alter authoritative state, persistence or routing. New model-facing completion payloads contain only the compact job row; static safety rules live in the tool descriptions rather than being repeated in every result/message. Legacy notices still render correctly, and their deduplication keys are preserved across upgrades.

Notifications are custom Pi messages with `deliverAs: followUp`, **not user messages**. Previously unseen confirmed `EXITED` states (zero or nonzero exits) set `triggerTurn: true`: an idle originating session starts a model turn, or a busy session queues a follow-up, to inspect results and continue already-authorized work. This consumes model quota/tokens and may lead to further authorized tool use; it grants no new publication, merge, retry, or paid-review permission. `UNKNOWN`/`ADMISSION_UNKNOWN` notices stay passive (`triggerTurn: false`). Resume/tree reconciliation can also trigger a turn for an unseen completion; closed Pi sessions are not launched by the callback. Multiple completions can queue follow-ups. Later cancellation-intent/result changes for an already noticed completion are passive, not another paid wake. Before calling Pi's void `sendMessage()`, reconciliation appends a non-context `pi-repo.pueue.receipt.v1` entry. Deduplication reconstructs these receipts and legacy custom-message keys from the active branch, including older passive notices (these are not replayed). Pi may queue a message through startup/streaming before persisting it: queued messages alone are **not** delivery receipts. Reload, repeated hints and trigger-turn feedback must not pay for another turn for a receipted result. A crash after the receipt but before message delivery can lose that notification; explicit `pueue_status`/`pueue_result` still recover the result, without re-execution or automatic replay of the wake. There is no exactly-once claim. Do not open the same session file concurrently in multiple Pi processes.

## Architecture and uncertainty

1. Persist a custom intent entry containing origin session ID/file, branch anchor, backend namespace, fresh nonce and controlled label **before** mutation.
2. Ensure the ordinary session group exists with parallelism 2, or optionally reserve a separate one-shot group with parallelism 1 by hashed caller-supplied key. Pueue's mutex-protected group creation rejects an existing name. Reservations are never automatically removed. Parallelism=1 alone merely serializes duplicate paid jobs; it does not reject them. This only coordinates cooperating callers while that daemon's state remains intact. Existing worktree and remote publication-ownership guards remain authoritative.
3. Add **stashed**, capture ID + `created_at` + nonce-bearing label, persist that identity, then enqueue. Persist admitted acknowledgement. Uncertain/lost replies remain `ADMISSION_UNKNOWN`; no automatic enqueue/resubmit/retry/recovery occurs on resume. A crash before enqueue leaves a stashed artifact for explicit operator investigation.
4. Reconstruct ownership through `getBranch()` custom entries; never edit JSONL. Fork/clone session IDs/files do not inherit authority to signal original jobs. Tree navigation only sees jobs whose entries are on that branch. Async handlers recheck session/branch identity after awaits before persistence/delivery. Old callbacks cannot target whichever session happens to be current.
5. Query backend status for completion, persist a branch-local receipt before triggering a turn; read only bounded positional log slices on explicit request. Pueue owns execution, process groups, signals, exit status and log descriptors. TypeScript never pumps child stdout/stderr or retains full output arrays. Full logs are backend-owned at `task_logs/<id>.log` and never capped/cleaned by this extension.

`Success`/`Failed(code)` yield `EXITED` plus the backend exit code. Missing identities, reused IDs, unknown schemas, and `Killed`/other uncertain results remain `UNKNOWN`. Pueue restore can synthesize `Done/Killed`; it is not stopped-descendant evidence. Restore errors can leave empty state. No status proves absence of partial external publication. Cancellation intent is orthogonal to exit status. At most 128 retained jobs may be submitted per active branch; no evidence is automatically deleted to make room.

### Backend gaps (not patched with a new supervisor)

- Pueue has no conditional compare-nonce-and-signal/enqueue API. Identity is verified before actions, but an independent concurrent reset/remove/restart-in-place can race the subsequent numeric-ID CLI action. **Do not perform destructive backend maintenance concurrently.** Dedicated daemon, namespace discipline and existing publication guards are required; this is not safe against a hostile same-user operator/backend. Log identity is checked before/after reading, but no transactional snapshot exists across CLI and filesystem.
- IDs/log filenames are reused after external cleanup/reset. Artifact paths are complete, not immutable archives. Do not clean/remove/reset/restart-in-place while evidence is needed. The extension never performs those operations, and never archives away uncertain/partial-publication evidence.
- A daemon crash/restart cannot establish descendant liveness or publication ownership. A confirmed process exit still does not certify every detached descendant stopped. Investigation remains manual; no takeover is authorized.
- Callback configuration is daemon-wide, and callback delivery is not durable. Deployment must deliberately compose any existing callback rather than overwriting it. No active daemon was reconfigured/restarted during development.

## Agent scheduling guidance

Use `pueue_submit` normally: session grouping and its two slots are automatic.
Do **not** use `reservationKey` merely to obtain a group or increase concurrency;
reservations remain permanent, cross-session duplicate-admission guards for one
specific authorized operation, not reusable session queues or PR locks. Reserved
jobs use their separate one-slot group and do not consume the ordinary session's
two slots. Neither mechanism establishes PR-wide ownership or merge permission.

The two-slot limit is **per group, not global**. Several sessions can run heavy
Bazel/Nix jobs at once; those tools already parallelize internally. Serialize jobs
that mutate the same checkout/build state, retain isolated worktrees/output bases
where appropriate, and never overlap reviewers on the same PR. Do not launch a
duplicate simply because a job is queued or UNKNOWN. Preserve the existing
nonce/status/log, credential, approval and cancellation boundaries.

This changes **new submissions only after loading the updated adapter**. Existing
jobs, reservations, limits and the daemon's `default` group remain untouched.
Do not migrate/requeue/cancel pending jobs, restart the daemon or edit session
history to adopt this change. Publication, source-pin update and activation are
separate steps; local tests do not change the installed adapter.

## Queued local workflows and credentials

The owning Nix module (`/etc/nixos/common/daniel/pi/pueue.nix`) supplies a deliberately small runtime: shell/core utilities, find/sed/grep, Git, Node, Nix, OpenSSH and Azure CLI with its DevOps extension. Project compilers/Bazel/JDKs still come from `nix develop --no-write-lock-file CHECKOUT --command ...`; do not depend on foreground PATH/JAVA_HOME. No extension profile API or new backend is needed.

Its optional explicit `pi-pueue-exec CHECKOUT EXPECTED_FULL_HEAD ABSOLUTE_COMMAND [ARG ...]` launcher is exec-only. Submit the immutable absolute launcher path as `argv[0]` and set `cwd` to that retained checkout root. At execution it checks cwd/root, full HEAD and tracked cleanliness, prepares PATH/non-interactive Git and then execs the command with literal argv. A missing/moved/dirty checkout or stale revision fails rather than running against another revision. Keep the checkout/worktree until terminal status and evidence retrieval; this is a start-time guard, **not a lease or snapshot**, and cannot protect concurrent edits/removal after the check. Untracked files are not certified. Existing review checkout/isolation/publishing guards still apply. Direct submissions without this launcher retain their existing behavior; they are not implicitly revision-guarded.

The launcher's Git SSH command uses the existing OpenSSH config/identity files with `BatchMode=yes`, `IdentityAgent=none`, `ForwardAgent=no`. It does not change host-key policy or add keys. Disabling agent use is deliberate: GnuPG SSH signing can invoke pinentry even with SSH BatchMode. Missing/encrypted keys fail without prompting. No ambient socket is copied or saved. SSH file authentication worked in the local probe below; hosts needing a locked key/agent need a separately approved non-interactive mechanism, not a silent identity fallback.

ADO reads use the existing human HOME-based Azure cache; dynamic extension installation is disabled. The launcher never calls login or copies a PAT into Pueue's persisted admission environment. Missing/expired auth fails at the CLI. This does **not** establish reviewer-account configuration or grant posting permission. No approved reviewer credential-file provisioning was found in the owning local configuration; that part remains unconfigured, rather than silently borrowing the human identity. Existing reviewer credential resolver, subprocess scrubbing and isolated `AZURE_CONFIG_DIR` remain the workload's responsibility. Do not wrap isolated reviewer/model subprocesses in a helper that restores scrubbed credentials.

### Verification and remaining limits (2026-10-22)

- Deterministic tests now model delayed message persistence (the former fake persisted synchronously), receipt-before-trigger ordering, feedback/reload, repeated/lost callbacks, active branches/forks and real Pi SessionManager reopen/branch APIs. The owning Nix tests cover runtime preparation, literal args/cwd, stale/dirty revisions and non-interactive auth policy.
- Confirmed source defect: previously deduplication only consulted persisted custom messages, leaving a gap while Pi queued delivery. This defect is reproduced and fixed; the precise cause of the parent's repeated ID 10/11 notices is **not proven**. Their originating transcript was not available in this session; backend callback repetition, reload/tree reconstruction and feedback are distinct possibilities. No histories or backend evidence were edited.
- Real installed-plugin local job **15**, nonce `0a7e8a17-9bc5-4faa-a3e3-8cb85560585f`, used the locally built Nix launcher against clean goMonorepo HEAD `10c1adc9b35ad448abc10f37cd3f8ec8282bb9bc`: all **26** Bazel targets passed; read-only `git ls-remote origin HEAD` and `ado threads 15124 --active` succeeded. Authoritative result: **EXITED/0**, retrieved through `pueue_result` (3376-byte full log, retained by Pueue). ADO success is human-read access only. Bazel reported shared-server startup-option contention; use a dedicated output base for future concurrent verification. No cancellation, paid review or remote mutation was exercised.
- That live run used the currently installed adapter plus the newly built runtime, **not an activated extension update**. Completion fixes are regression-tested, not yet live-deployment accepted. Full unattended reviewer readiness is not claimed.
- Publish/update the extension source pin only with separate approval, then activate the Nix wrapper/runtime and start a new Pi process (or explicitly load the source for a controlled test). **Do not restart the existing Pueue daemon**: keep-old means its existing admission PATH stays old; the explicit launcher supplies the new execution PATH without a restart. Callback format is unchanged. No source pin with an unpublished revision is installed by this change.

## Audit / verification

Source semantics verified against [v4.0.4 commit `0d10739a6431bd853195dc7730056fce79faeee1`](https://github.com/Nukesor/pueue/tree/0d10739a6431bd853195dc7730056fce79faeee1): `pueue/src/client/{cli.rs,commands/add.rs}`, `pueue_lib/src/{task.rs,log.rs,settings.rs}`, daemon `callbacks.rs`, `internal_state/state.rs`, `network/message_handler/group.rs`, `process_handler/{spawn,kill}.rs`, and `process_helper/unix.rs`.

Confirmed: caller env serialization; `env_clear()` at task spawn; direct cloned stdout/stderr log descriptors; explicit signal path vs force kill; synthetic restored Killed; ID allocation/reuse; mutex group reservation; no-escape callback rendering. `callback_log_lines: 0` suppresses line collection but the backend may still open the log. No RSS/CPU measurements or real-daemon compatibility/production claims are made.

Fake-backend tests cover admission ordering, exits/nonzero/uncertainty, cancellation intent with exit-zero handlers, interrupted admission, persistent reservations, ownership/switch/fork/tree/reload, stale/lost/duplicate hints, environment/diagnostic redaction, argv quoting, log slices/final errors, and private callback paths. Root checks also run the migrated worktree-panel suite and actual Pi package-loader smoke test.
