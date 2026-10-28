# pi-repo

Source-only [Pi](https://pi.dev) extension package (Node 24+, tested with Pi 1.3.0).

- [`extensions/worktree-panel`](extensions/worktree-panel/README.md): changed-files panel and read-only diff viewer for linked worktrees and branches.
- [`extensions/pueue`](extensions/pueue/README.md): thin adapter for **Rust Pueue 4.0.4 CLI + pueued**, with session-owned jobs and retained evidence.
- [`extensions/repo-snapshot`](extensions/repo-snapshot/README.md): on-demand, read-only Git snapshot. No watcher, fetch, or per-prompt scan.
- [`extensions/delegate`](extensions/delegate/README.md): optional retained-worktree implementation workers over Pueue, with explicit check plans and review/revision evidence.

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

Ordinary Pueue submissions use session-specific groups with two slots, not a
global machine cap. Delegate workers additionally share two worker locks and one
heavy-check lock. There is no automatic retry, integration, publication, merge,
or cleanup. Reports and exit zero are evidence, not acceptance. See the component
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
