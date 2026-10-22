# pi-repo

Source-only Pi extension package (Node 24+, tested with Pi 1.3.0).

- [`extensions/worktree-panel`](extensions/worktree-panel/README.md): migrated Git worktree overlay, unchanged implementation and regression tests.
- [`extensions/pueue`](extensions/pueue/README.md): thin adapter for **Rust Pueue 4.0.4 CLI + pueued**. No supervisor, installer, automatic retry, paid review, publication, or merge policy.

## Installation

The root `package.json` explicitly exposes exactly two entry points. For an isolated one-invocation test:

```sh
pi --no-extensions -e /absolute/path/to/pi-repo
```

For a persistent local install, after separately authorizing replacement of the old installation:

```sh
pi install /absolute/path/to/pi-repo
```

Choose **one** root-package route: Pi-managed package **or** a Nix-managed directory at `~/.pi/agent/extensions/pi-repo`. Do not also load its children or the old worktree-panel package. Root manifest discovery through a Nix-style symlink is tested with Pi's actual loader. No live settings or extension symlinks were changed during development.

Pueue stays unconfigured until explicitly supplied the external paths described in its README. Loading the package does not install/start a daemon. GitHub destination: [dunv/pi-repo](https://github.com/dunv/pi-repo), created by Daniel as a public repository. Daniel approved a dedicated Nix-managed Pueue 4.0.4 backend; see [Nix integration notes](docs/nix-integration.md). Submission confirmation is optional and off by default (`PI_PUEUE_CONFIRM_SUBMIT=1` enables it). Completion notices use compact neutral styling.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --dry-run
```

Runtime npm dependencies: **none**. Pi host modules are peers, not bundled copies. Dev-only host packages are pinned to 1.3.0. Tests use a deterministic fake Pueue backend, never a real review or remote mutation. The inherited GitHub workflow runs these root checks.

## Provenance and license

MIT, copyright Daniel Unverricht. This Git history contains the complete reachable history of `git@github.com:dunv/pi-worktree-panel.git` through `7a84ea8e795ffc5fb5dd6073a1495e768aae0df0`, fetched locally from the clean original checkout. Commit `9348679` only moved its tracked package files under `extensions/worktree-panel/`. Its README, changelog, manifest, lockfile, license and tests are retained; historical install instructions there describe the original independent package. New root packaging supersedes those install instructions. The original repository/checkout and installed extension remain untouched. Daniel subsequently confirmed `git@github.com:dunv/pi-repo.git` as the new destination; its public visibility was verified read-only before publication.
