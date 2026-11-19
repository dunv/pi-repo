# Opt-in delegate environment contract v2

V1 remains the default and keeps its existing tool-boundary semantics. V2 is an
operator-implemented OS filesystem boundary with separate launch purposes. It is
not a claim of kernel isolation, network egress filtering or general certification.

## Interface

The same three names and source/check capabilities apply. Runtime
`environmentProtocol: 2` requires these exact fields for each environment:

```json
{
  "capabilities": { "source": "writable-worktree", "checks": true },
  "verificationProfiles": ["approved-profile"],
  "launcher": "/absolute/worker-launcher",
  "checkLauncher": "/absolute/check-launcher",
  "path": "/absolute/tool/bin",
  "isolation": {
    "filesystem": "operator-allowlist",
    "network": "worker-host/check-none",
    "credentials": "access-lease-or-none"
  },
  "policy": { "path": "/absolute/operator-policy.json", "sha256": "64-lowercase-hex-digits" },
  "routes": {
    "pi": ["approved-provider/model"],
    "claude": ["claude-sonnet-4-6"]
  }
}
```

For `source-review` and `implementation`, `checkLauncher` must be null, profiles
empty and no checks/profile may be requested. `implementation-checked` requires
an explicitly approved profile and a nonempty check plan. Routes name exact native
backend model IDs, not discovery aliases; unsupported authentication routes fail
before task creation. There is no provider, environment or unsandboxed fallback.

The policy seal, routes and purpose launchers are frozen in each task. A policy is
data only: `{version: 1, operator: "implementation-name", settings: {...}}`.
Its exact bytes must match the declared SHA256. The operator validates the
implementation-specific settings; pi-repo never evaluates policy code.

## Launcher invocation

Literal argv, no shell string:

```text
LAUNCHER 2 worker RUNTIME TASK ATTEMPT_OR_- - EXECUTABLE [ARG ...]
CHECK_LAUNCHER 2 check RUNTIME TASK ATTEMPT_OR_- INDEX EXECUTABLE [ARG ...]
```

The context identifies a frozen task/attempt/check, not permission to execute an
arbitrary supplied command. Implementations must independently validate identities,
current attempt, approved route, exact frozen command/argv and policy before exec.
Trusted adapters persist `worker-launch.json` once before worker launch, binding
its task/attempt, backend/model/thinking and exact command/argv. The operator
compares the invocation to that record and mounts it read-only in the worker.
Missing namespaces/tooling, altered policy or incomplete preparation must fail.
They must preserve I/O, exit status and the existing attempt scope, never detach,
bootstrap, retry, refresh credentials or start persistent services.

The worker purpose permits model connectivity on the host network. **Local TCP and
abstract Unix services are not egress-isolated.** Filesystem sockets, real HOME,
unrelated workspaces and credential stores are not mounted. Checks use a separate
network namespace and credential-free HOME, without host service/daemon sockets.
Cgroups/task locks still govern liveness; terminal backend state alone never
permits cleanup while descendants remain.

## Prepared checks

V2 profiles add a seal to the existing trusted command/argument-template plan:

```json
{
  "command": "/absolute/approved-check-identity",
  "args": ["{worktree}", "{outputBase}", "{kind}", "{targets}"],
  "prepared": { "path": "/absolute/approved-manifest.json", "sha256": "64-lowercase-hex-digits" }
}
```

The sealed document has exactly:

```json
{
  "version": 1,
  "repository": "/canonical/main-checkout",
  "policySha256": "same-digest-as-the-environment-policy",
  "sourceInputs": [{"path": "MODULE.bazel", "sha256": "approved-file-digest"}],
  "checks": [{"kind": "test", "targets": ["//package:target"]}],
  "operator": {"type": "implementation-specific-prepared-payload"}
}
```

Protected preparation inputs must be canonical, in-source regular files, with no
traversal, symlink or Git-control components. The exact check kind/ordered targets
must be approved. Normal implementation files may change; protected dependency or
toolchain inputs require explicit re-preparation/re-approval. Repository identity
and policy digests must match. Manifests are immutable approvals, not requests for
workers to provision dependencies. No worker-modified flakes, shell hooks, module
rules or setup programs may execute outside the check sandbox.

The NixOS operator currently supports `bazel-vendor-v1` with exactly `type`,
`environment`, `vendor` and `executable`. Each latter field is `{path, sha256}`:

- `environment`: sealed Nix `print-dev-env --json` data. Exported variables only;
  no shell functions/hooks are executed. Credential-like variable names are refused.
- `vendor`: digest of an approved target-scoped Bazel vendor tree, including
  `_registries`. The generated top-level `bazel-external` link is excluded.
- `executable`: digest of the exact concrete Bazel executable, never a downloader.

The vendor digest matches the prototype algorithm: sorted relative paths, each
Python `json.dumps([relative, lstat.mode, lstat.size])`, followed by symlink target
bytes or regular file bytes, SHA256 over the concatenation. The operator checks
it before and after execution. A task-private vendor root holds generated links;
approved dependency directories/marker files are mounted read-only. No shared
writable SDK/dependency cache is granted. Source and prepared inputs are read-only
inside checks; only task build output and private HOME/temp are writable.
The worker retains a writable bind of task build output even for revisions, so
nested checks can reuse it without exposing earlier reports/control as writable.
Foreign ELF tools use a private immutable nix-ld fallback library view (including
`ld.so` and libc). It also works when Bazel actions remove `NIX_LD*`; no extra
glibc is injected into the global `LD_LIBRARY_PATH` used by Nix-patched tools.

## Authentication and private Git

The NixOS implementation supports explicit no-auth local Pi metadata and Claude
access-only leases. It reads the canonical credential file only in the trusted
outer launcher, verifies sufficient remaining lifetime, and sends only the access
token/expiry through a sealed memfd to private namespace tmpfs. No refresh token,
canonical credential mount, token argv or credential copy in task/session files is
allowed. The bootstrap consumes/removes the payload and supplies the CLI's supported
access-token environment variable. An access lease retains the original token's scopes; it is not an
inference-only scope reduction. Its narrower property is the absence of refresh
credentials and canonical auth storage. Claude MCP auth variables are cleared;
checks receive neither the model HOME nor its environment. Expiry is a blocker requiring
explicit recovery outside the worker, not an automatic retry/login/refresh.

The original Git config, refs, hooks, alternate object databases and other branch
objects are not mounted. A private self-contained Git view exports only the base
and current HEAD commits and their trees/blobs, with a sanitized config/index,
selected branch and shallow boundaries. A read-only `.git` pointer overlay leaves
the real worktree registration unchanged. This supports required status/diff and
source-search operations, not unrestricted repository history. Follow-ups rebuild
the view for the current branch HEAD while retaining the original base tree.

## Deployment and limits

NixOS declares `programs.pi-delegate-sandbox.enable = false` by default. Enabling
requires explicitly prepared checks and a compatible source pin; unsupported hosts
or routes fail rather than downgrade. No provisioner, refresh broker/daemon,
retention policy, publication or activation is installed automatically.

The initial operator is x86_64 Linux/Bubblewrap only and exposes the Nix store
read-only. Store contents must not contain secrets. The trusted adapters retain
write access to their current attempt's reports/check records; untrusted executed
check code sees only build output, not task/control metadata. Kernel/runtime bugs,
resource exhaustion and model-network exfiltration are outside these guarantees.
Test actual hosts, routes and representative targets before enabling a deployment.
