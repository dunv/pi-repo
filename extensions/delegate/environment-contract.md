# Delegate environment contract v1

`pi-repo` defines and validates this interface; an operator (NixOS here) supplies
its implementation. The agent selects an approved environment, never its own
launcher, executable PATH or privileges. Verification profiles remain separate.

## Runtime interface

Add `environmentProtocol: 1` and exactly these three entries to the private
`PI_DELEGATE_RUNTIME` JSON:

```json
{
  "environmentProtocol": 1,
  "environments": {
    "source-review": {
      "capabilities": { "source": "read-only", "checks": false },
      "verificationProfiles": [],
      "isolation": {
        "filesystem": "tool-boundary",
        "network": "host",
        "credentials": "host-home"
      },
      "launcher": "/absolute/operator-provided-launcher",
      "path": "/absolute/tool/bin:/another/absolute/bin"
    },
    "implementation": {
      "capabilities": { "source": "writable-worktree", "checks": false },
      "verificationProfiles": [],
      "isolation": { "filesystem": "tool-boundary", "network": "host", "credentials": "host-home" },
      "launcher": "/absolute/operator-provided-launcher",
      "path": "/absolute/tool/bin"
    },
    "implementation-checked": {
      "capabilities": { "source": "writable-worktree", "checks": true },
      "verificationProfiles": ["go", "private"],
      "isolation": { "filesystem": "tool-boundary", "network": "host", "credentials": "host-home" },
      "launcher": "/absolute/operator-provided-launcher",
      "path": "/absolute/tool/bin"
    }
  }
}
```

The checked environment must approve at least one profile. Profile names must
exist as own entries in the operator's existing `profiles` map. Environment
objects have a strict field set and capabilities; unknown versions/fields,
relative executables, empty/relative PATH entries, duplicate/unknown profile names
and unsupported isolation claims are rejected. No discovery call starts a worker
or verifies authentication/toolchain readiness.

## Capability guarantees

| Environment | Agent source tools | Planned checks |
| --- | --- | --- |
| `source-review` | read, grep, find, ls | Forbidden |
| `implementation` | Above plus edit, write | Forbidden |
| `implementation-checked` | Above plus edit, write | Approved profile/indices only |

Both Pi and Claude expose only this tool set, and execution guards reject direct
calls to forbidden tools. Reads are bounded to the worktree and reject external
symlink targets; writes retain existing Git/agent-configuration and symlink guards.
Read-only runs additionally detect source fingerprint changes at completion.
The source is still an isolated Git worktree snapshot, including the parent's
uncommitted baseline. Read-only describes the agent's source tools, not chmod or
an immutable filesystem mount. Do not modify a worker's workspace concurrently.

These are application-level capability restrictions. This version deliberately
accepts only the truthful isolation labels `tool-boundary`, `host`, `host-home`.
It does **not** provide OS-level filesystem/network isolation or model-only secret
access. Model CLIs and trusted checks run as the local user with HOME-based auth;
they can access host files/network and execute repository build code. Source
path guards are not an OS security boundary against malicious concurrent changes.
Do not run untrusted code or assume unrelated HOME credentials are inaccessible.
The existing cgroup/task locks manage liveness, not sandboxing or CPU/memory quotas.

The desired offline/check sandbox and controlled model-connectivity/credential
boundary require a separately implemented and audited contract version. Unsupported
stronger declarations fail rather than pretending that restricting PATH is a sandbox.

## Launcher obligations

A launcher receives `EXECUTABLE [LITERAL_ARG ...]`, not a shell command string.
`pi-repo` invokes it for either model backend and every planned check. It receives
the scrubbed worker environment (HOME, configured PATH, locale/Git controls and
explicit Pi task context); stdin/stdout/stderr and exit/signal outcomes must be
preserved. It must not detach descendants, start persistent services, silently
install tooling, grant extra permissions or retry. Processes must remain in the
existing attempt scope. Literal argv and failure propagation are mandatory.

The NixOS implementation is `common/daniel/pi/delegate-environments.nix`. It
provides immutable store launchers with `env -i`, approved HOME and narrow PATHs,
forwarding only explicit worker identity variables. Launchers accept only Nix
store executables. Source environments omit cloud/deployment CLIs and Nix; the
checked environment adds Nix/basic build utilities. Project SDKs still come from
approved reproducible verification profiles, not ambient shell setup. Dependencies
must be provisioned ahead of time if offline operation is required; existing Nix
checks may still access the daemon/network and are NOT advertised as offline.

## Selection, freezing and compatibility

Discover with `delegate_environments {}`. New `delegate_task` calls require an
explicit `environment`; there is no default or fallback. No-check environments
require `checks: []` and no `profile`. `implementation-checked` requires a profile
approved by its environment, even if its planned check list is empty.

The normalized descriptor (launcher, PATH, capabilities, profiles, isolation) is
frozen into the task and reported on submission/review. Workers, source-tool calls,
checks and follow-ups revalidate it against the current runtime. Drift, removal
or attempts to change environments on follow-up refuse execution. Start a separate
authorized task to change privileges. New tasks/follow-ups require runtime v1.

Existing immutable workers with their old runtime remain unchanged. Legacy tasks
without a descriptor can still be inspected/cleaned; they are not silently assigned
an environment or upgraded for execution under v1. Low-level legacy test/runner
support makes no new guarantee. Publication, pinning, activation and fresh sessions
are explicit deployment steps; installing source never starts or migrates workers.

## Conformance tests

`npm run check` exercises validation, no-fallback selection, frozen descriptors,
Pi/Claude tool exposure and call rejection, read escapes, launcher invocation and
read-only mutation detection. Tests use fake model executables, not paid calls.
NixOS `pueue.test.mjs` imports this validator against every host's evaluated runtime
and executes synthetic commands through the actual generated launcher scripts,
checking environment scrubbing and context preservation. Test unpublished changes
using `PI_TEST_PI_REPO_SOURCE=/absolute/pi-repo`; no publication/activation occurs.
