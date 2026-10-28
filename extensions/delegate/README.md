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

## Tools

- `delegate_task {repo, brief, model, thinking, profile, checks}` starts from the
  selected checkout's exact committed HEAD in a fresh sibling worktree. Supply
  exact provider/model, requested thinking, a self-contained bounded brief with
  scope/paths/acceptance criteria and review assessment, and only necessary
  `{kind: "test"|"build", targets: ["package:test"]}` checks (`[]` is allowed).
- `delegate_review {}` lists active-branch owned tasks without querying the backend.
  `delegate_review {task, openDiff?: false}` requires authoritative Pueue EXITED,
  collects cumulative tracked diff, new-file list, untrusted report and current
  check evidence. Optional panel targeting does not change the agent's cwd.
- `delegate_revise {task, expectedNonce, expectedFingerprint, brief, model, thinking}`
  starts one explicitly authorized revision in the **same** worktree/output base.
  Get identities from the latest review. The previous attempt must be confirmed
  EXITED/0 without cancellation or integrity error. Supply a fresh self-contained
  brief; original profile/check plan are inherited. Permanent per-parent claims
  prevent duplicate revisions, including after uncertain admission or navigation.

Use the existing `pueue_status`, `pueue_result` and confirmed cancellation tools.
Missing/uncertain evidence never permits automatic retry. Branch ownership and
session identity are preserved; a fork does not gain another session's authority.
Preparation/admission failures retain artifacts for manual reconciliation.

## Review and evidence

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
output base. No automatic pruning, artifact deletion or worktree cleanup.

## Execution boundary and visibility

Workers use fresh persistent Pi print-mode sessions with explicit model/thinking,
no auto-loaded extensions/skills/templates/MCP or project Pi settings. They can
read/search/edit/write and invoke planned checks by index, not shell, Git,
publication, Pueue or delegation. Write hooks reject outside-worktree and protected
Git/agent configuration paths, including symlink escapes. This is **not an OS
sandbox**: verification commands execute as the user and HOME credentials remain
accessible. See [worker policy](policy.md).

Only explicit HOME/PATH/LANG and noninteractive Git settings enter the runtime;
foreground tokens and agent sockets are not forwarded. Pi resolves subscription
credentials from existing HOME configuration. Keep briefs/artifacts/logs private;
never place secrets in argv.

Two cooperating workers and one heavy check per machine are bounded by kernel
`flock`, not a second scheduler. Unrelated Pueue work is not globally limited.
Slot waiting can cause head-of-line blocking. Keep worktrees/output bases through
review/revision; external tool caches can remain shared. Cache hits are not
guaranteed and no persistent build lane is created.

Transcript calls show exact model/requested thinking and submission status;
Pueue owns authoritative completion. Live output includes assistant text and
numbered tool start/end markers with bounded allowlisted previews, not thinking,
file/replacement bodies or tool result bodies. Paths/patterns and assistant text
may still be sensitive. Reports and worker logs retain full output. Actual model
usage stays in the child transcript, not the parent's token totals.

## Deployment

The operator supplies executable paths, a private state directory, noninteractive
credentials, the external backend and runtime JSON. This package does not manage
services or install a runtime. `PI_DELEGATE_RUNTIME` names an absolute JSON file
with absolute `git`, `node`, `pi`, `flock`, `ssh`, `home`, `state`, `launcher`, an
absolute-component `path`, `revisionProtocol: 1`, and a `profiles` map.

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
fake Pi/check executables, real kernel locks, and the installed development Pi
1.3.0 loader (optional `PI_TEST_SDK` override). No live daemon, model, real
monorepo build, activation or publication is involved. Linux with Git, Bash and
`flock` is required for these tests, matching the current runtime scope.
