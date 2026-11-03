# Thin delegated workers (v1)

Optional orchestration over this package's Pueue adapter and worktree panel.
No new daemon, scheduler, watcher, polling, automatic retry, merge or cleanup.
Loading this entry registers tools but starts no processes. Execution requires an
explicit `PI_DELEGATE_RUNTIME`; an unconfigured installation fails before preparation.

## Current scope

Source checkouts must be clean Git repositories. Verification uses explicit,
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
  selected checkout's exact committed HEAD in a fresh sibling worktree. Supply
  an exact shared catalogue entry ID and requested thinking. Pi uses its thinking
  levels; Claude Code uses CLI effort (`low`, `medium`, `high`, `xhigh`, `max`).
  Explicit backend/native-model selection is also supported within policy. Fuzzy
  aliases such as `sonnet` and unsupported effort levels fail before preparation;
  model/effort support is ultimately determined by the installed Claude CLI/API.
  Supply a self-contained bounded brief with
  scope/paths/acceptance criteria and review assessment, and only necessary
  `{kind: "test"|"build", targets: ["package:test"]}` checks (`[]` is allowed).
- `delegate_review {}` lists active-branch owned tasks without querying the backend.
  `delegate_review {task, openDiff?: false}` requires authoritative Pueue EXITED,
  collects cumulative tracked diff, new-file list, untrusted report and current
  check evidence. Optional panel targeting does not change the agent's cwd.
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
No automatic pruning, artifact deletion or worktree cleanup.

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

The brief goes over stdin, not argv. `claude-mcp.json`, raw `claude-result.json`,
`worker.log` and final `report.md` are retained per attempt; Claude's own transcript
is retained in its normal HOME-based session storage. The bridge emits bounded
tool start/end previews on MCP stderr, which Claude may capture rather than
forward to Pueue. CLI stderr is mirrored live; final JSON appears when Claude
exits (assistant deltas are not streamed). Invalid/error result envelopes fail
even if the CLI exits zero.
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
Claude remains nonstreaming: only final CLI aggregate API time, turns and usage
are surfaced when available; missing fields show `n/a`, never invented zeros.

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

Materialize the `launch.sh` template into an executable launcher: replace `@bash@`
with the absolute Bash path (unquoted, without whitespace, in the shebang), and
shell-quote replacements for `@state@`, `@flock@`, `@node@` and `@runner@` (packaged
`run.mjs`). Set the launcher's absolute path in the runtime. State must be private and user-owned;
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
1.3.0 loader (optional `PI_TEST_SDK` override). No live daemon, model, real
monorepo build, activation or publication is involved. Linux with Git, Bash and
`flock` is required for these tests, matching the current runtime scope.
