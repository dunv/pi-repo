# pi-repo

Source-only [Pi](https://pi.dev) extension package (Node 24+, tested with Pi 1.3.0).

- [`extensions/worktree-panel`](extensions/worktree-panel/README.md): changed-files panel and read-only diff viewer for linked worktrees and branches.
- [`extensions/pueue`](extensions/pueue/README.md): thin adapter for **Rust Pueue 4.0.4 CLI + pueued**, with session-owned jobs and retained evidence.
- [`extensions/repo-snapshot`](extensions/repo-snapshot/README.md): on-demand, read-only Git snapshot. No watcher, fetch, or per-prompt scan.
- [`extensions/delegate`](extensions/delegate/README.md): optional retained-worktree workers over Pueue: Anthropic via Claude Code, local/OpenAI via Pi, a shared exact-route catalogue, session-labelled worktrees, explicit check plans, review/revision evidence, explicitly confirmed stopped-attempt recovery, opt-in foreground-only cross-session reconciliation, retained caller feedback, recoverable task finalization (including separately confirmed reconciled originals), opt-in permanent disposal of selected finalized build/recovery payloads, and separately confirmed cleanup-only historical operations without custody transfer (requiring independent local repository identity by default, with a separately opted-in recovery-only legacy exception).
- [`skills/delegate-cleanup`](skills/delegate-cleanup/SKILL.md): read-only ownership/allocation inventory and explicit cleanup guidance; no age-based purge or deletion authority.

## Installation

Try the root package for one invocation:

```sh
pi --no-extensions -e /absolute/path/to/pi-repo
```

Or install it persistently:

```sh
pi install /absolute/path/to/pi-repo
# Alternatively, use a reviewed Git revision:
pi install git:github.com/dunv/pi-repo@REVISION
```

The root manifest exposes four entry points. Choose one installation route; do
not also install its children or the former standalone worktree-panel/delegate
extensions. Pi's actual loader tests discovery through an extension-directory
symlink and checks that each tool is registered once.

Pueue requires an externally configured matching backend and the explicit paths
described in its README. Delegation additionally requires `PI_DELEGATE_RUNTIME`,
including operator-defined verification commands. Loading the package does not
start workers, install software, manage services, or change Pi settings.

Ordinary Pueue submissions use session-specific groups with three slots, not a
global machine cap. Delegate workers additionally share six worker locks and one
heavy-check lock. There is no automatic retry, integration, publication, merge,
or cleanup. After authorized integration/discard, `delegate_finalize` explicitly
archives and removes a task worktree/branch with fresh confirmation and stopped-worker
proof, retaining diagnostic evidence and build state. Separately confirmed
`delegate_dispose` can permanently remove selected finalized build/recovery payloads;
it never purges task identities, sessions or audit evidence. Opt-in `delegate_cleanup`
assesses and separately confirms those lifecycle operations across sessions or
when a linked source checkout disappeared, without adopting custody or enabling
workers. Historical finalized archives lacking durable repository identity stay
blocked by default; matching commits or a clone are not sufficient. A separately
enabled `legacyRecoveryDisposalProtocol: 1` permits explicitly confirmed loss of
only finalized legacy recovery copies, recording historical identity as unverified
rather than fabricating it. It retains terminal/stopped-worker gates, audit records
and Mailhub unknown-outcome barriers; it does not enable source/worktree or build
deletion. Reports and exit zero are evidence, not acceptance. See the component
READMEs for configuration, authorization boundaries and limitations.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --dry-run
```

Runtime npm dependencies: **none**. Pi host modules are peers, not bundled copies.
Dev-only host packages are pinned to 1.3.0. Tests use fake backends/executables,
temporary Git repositories, real kernel locks and Pi's actual extension loader;
no live daemon, model call or remote mutation. Delegate tests require Linux,
Bash, Git and `flock`. The GitHub workflow runs the root checks.

## Provenance and license

MIT, copyright Daniel Unverricht. Git history retains the original
[`pi-worktree-panel`](https://github.com/dunv/pi-worktree-panel) history through
`7a84ea8e795ffc5fb5dd6073a1495e768aae0df0`. Root packaging supersedes the original
standalone package installation instructions.
