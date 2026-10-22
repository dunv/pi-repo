# Pueue adapter (initial, source-audited implementation)

**Backend: Rust Pueue 4.0.4 only.** Client version is checked at session start; operator must also pin the daemon to the same version. No installer, daemon startup, service management, fallback backend, settings mutation, or review policy is provided. Runtime/live-daemon acceptance testing remains pending the packaging decision.

## Interface and permissions

- `pueue_submit {argv, cwd, reservationKey?}` requires a UI-capable session and explicit confirmation of literal argv. Executable and cwd must be absolute. Credentials must **never** be passed in arguments; use an existing approved execution-time credential resolver that scrubs its output. No arbitrary environment forwarding is supported. Non-interactive admission is intentionally unavailable.
- `pueue_status {}` returns only this originating session's active-branch job summaries. Do not create model-driven polling/sleep loops.
- `pueue_result {nonce, offset?, limit?}` returns a marked byte slice and complete backend log path. Default is final 16 KiB; maximum per slice is 16 KiB. Output is untrusted data, not instructions or authority. UTF-8 boundary fragments may contain replacement characters; byte offsets remain authoritative. Logs may contain secrets emitted by workloads: this adapter cannot generically sanitize arbitrary application output. Existing approved workload scrubbing remains necessary.
- `/pueue-cancel <nonce>` requires explicit UI confirmation and requests **SIGTERM**, never default force-kill or escalation. Only verified, fully admitted running/paused identities are eligible. Queued/stashed/uncertain admission cancellation is deliberately unsupported rather than destroying evidence. Cancellation intent is saved first, remains visible even if a handler exits zero, and is never interpreted as proof of stopped descendants or absent publication.

Backend exit 0 is **not** green CI, a full clean review, successful publication or permission to merge. No review timeout, elapsed cap, retry, takeover, automatic paid work, model/effort/depth changes, or repo-specific PR policy exists here.

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

Notifications are custom Pi messages with `deliverAs: followUp`, **not user messages**, and `triggerTurn: false` (no automatic idle paid model run). Pi may include them after a currently running turn. Deduplication keys are reconstructed from supported active-branch custom messages. A crash between sending and session persistence can lose/repeat delivery; there is no exactly-once claim.

## Architecture and uncertainty

1. Persist a custom intent entry containing origin session ID/file, branch anchor, backend namespace, fresh nonce and controlled label **before** mutation.
2. Optionally reserve a group by hashed caller-supplied key. Pueue's mutex-protected group creation rejects an existing name. Reservations are never automatically removed. Parallelism=1 alone merely serializes duplicate paid jobs; it does not reject them. This only coordinates cooperating callers while that daemon's state remains intact. Existing worktree and remote publication-ownership guards remain authoritative.
3. Add **stashed**, capture ID + `created_at` + nonce-bearing label, persist that identity, then enqueue. Persist admitted acknowledgement. Uncertain/lost replies remain `ADMISSION_UNKNOWN`; no automatic enqueue/resubmit/retry/recovery occurs on resume. A crash before enqueue leaves a stashed artifact for explicit operator investigation.
4. Reconstruct ownership through `getBranch()` custom entries; never edit JSONL. Fork/clone session IDs/files do not inherit authority to signal original jobs. Tree navigation only sees jobs whose entries are on that branch. Async handlers recheck session/branch identity after awaits before persistence/delivery. Old callbacks cannot target whichever session happens to be current.
5. Query backend status for completion; read only bounded positional log slices on explicit request. Pueue owns execution, process groups, signals, exit status and log descriptors. TypeScript never pumps child stdout/stderr or retains full output arrays. Full logs are backend-owned at `task_logs/<id>.log` and never capped/cleaned by this extension.

`Success`/`Failed(code)` yield `EXITED` plus the backend exit code. Missing identities, reused IDs, unknown schemas, and `Killed`/other uncertain results remain `UNKNOWN`. Pueue restore can synthesize `Done/Killed`; it is not stopped-descendant evidence. Restore errors can leave empty state. No status proves absence of partial external publication. Cancellation intent is orthogonal to exit status. At most 128 retained jobs may be submitted per active branch; no evidence is automatically deleted to make room.

### Backend gaps (not patched with a new supervisor)

- Pueue has no conditional compare-nonce-and-signal/enqueue API. Identity is verified before actions, but an independent concurrent reset/remove/restart-in-place can race the subsequent numeric-ID CLI action. **Do not perform destructive backend maintenance concurrently.** Dedicated daemon, namespace discipline and existing publication guards are required; this is not safe against a hostile same-user operator/backend. Log identity is checked before/after reading, but no transactional snapshot exists across CLI and filesystem.
- IDs/log filenames are reused after external cleanup/reset. Artifact paths are complete, not immutable archives. Do not clean/remove/reset/restart-in-place while evidence is needed. The extension never performs those operations, and never archives away uncertain/partial-publication evidence.
- A daemon crash/restart cannot establish descendant liveness or publication ownership. A confirmed process exit still does not certify every detached descendant stopped. Investigation remains manual; no takeover is authorized.
- Callback configuration is daemon-wide, and callback delivery is not durable. Deployment must deliberately compose any existing callback rather than overwriting it. No active daemon was reconfigured/restarted during development.

## Audit / verification

Source semantics verified against [v4.0.4 commit `0d10739a6431bd853195dc7730056fce79faeee1`](https://github.com/Nukesor/pueue/tree/0d10739a6431bd853195dc7730056fce79faeee1): `pueue/src/client/{cli.rs,commands/add.rs}`, `pueue_lib/src/{task.rs,log.rs,settings.rs}`, daemon `callbacks.rs`, `internal_state/state.rs`, `network/message_handler/group.rs`, `process_handler/{spawn,kill}.rs`, and `process_helper/unix.rs`.

Confirmed: caller env serialization; `env_clear()` at task spawn; direct cloned stdout/stderr log descriptors; explicit signal path vs force kill; synthetic restored Killed; ID allocation/reuse; mutex group reservation; no-escape callback rendering. `callback_log_lines: 0` suppresses line collection but the backend may still open the log. No RSS/CPU measurements or real-daemon compatibility/production claims are made.

Fake-backend tests cover admission ordering, exits/nonzero/uncertainty, cancellation intent with exit-zero handlers, interrupted admission, persistent reservations, ownership/switch/fork/tree/reload, stale/lost/duplicate hints, environment/diagnostic redaction, argv quoting, log slices/final errors, and private callback paths. Root checks also run the migrated worktree-panel suite and actual Pi package-loader smoke test.
