# pi-repo

Source-only [Pi](https://pi.dev) extensions (Node 24+, tested with Pi 1.3.0):

- [`extensions/worktree-panel`](extensions/worktree-panel/README.md): changed-file
  panel and read-only diff viewer.
- [`extensions/pueue`](extensions/pueue/README.md): thin Rust Pueue 4.0.4 adapter
  with session-owned jobs and retained backend evidence.
- [`extensions/repo-snapshot`](extensions/repo-snapshot/README.md): on-demand
  read-only Git status; no fetch, watcher or per-prompt scan.
- [`extensions/delegate`](extensions/delegate/README.md): disposable isolated
  workers, model discovery, result review, explicit follow-ups and one-step cleanup.
- [`skills/delegate-cleanup`](skills/delegate-cleanup/SKILL.md): the agent manual
  for result handoff and safe disposal, plus a read-only disk inventory.

## Delegate workflow

```text
start → wait → collect/review → apply or discard → keep needed summary → cleanup
```

After the main agent has everything it needs, the delegate worktree, build output
and task-local temporary records can go away. **No archive is made.** There is no
separate finalization/disposal/retention workflow. Orphans may be inspected,
continued or discarded without session adoption; current workers/checks and
foreground build users must still be idle before removing their workspace.

The five tools are `delegate_models`, `delegate_task`, `delegate_review`,
`delegate_revise` and `delegate_cleanup`. Neither exit zero nor collecting a report
is acceptance. The main agent reviews all changes and preserves needed work before
cleanup; integration/publication retain the repository's approval requirements.

Anthropic routes use Claude Code; local/OpenAI routes use Pi. No automatic retry,
model fallback, integration, publication, SDK setup or background cleanup occurs.
Shared SDK/cache symlink targets and main/originating sessions are not deleted.
Operational plans/journals and unknown provider-outcome evidence are not disposable
scratch. Existing legacy records are not migrated or deleted by installation.

## Installation

```sh
pi --no-extensions -e /absolute/path/to/pi-repo
# Or persistently:
pi install /absolute/path/to/pi-repo
pi install git:github.com/dunv/pi-repo@REVIEWED_REVISION
```

The root manifest exposes four entry points. Use one package installation, not
separate copies of its child extensions. Pueue and delegation require an operator-
configured backend/runtime; merely loading the package starts no resources.
See the component READMEs for configuration and boundaries.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --dry-run
```

Runtime npm dependencies: **none**. Pi host modules are peers; development host
packages are pinned to 1.3.0. Tests use temporary repositories, fake backends and
worker executables, real kernel locks and Pi's actual loader. They do not contact
models, mutate real task data or activate a system. Linux, Git, Bash and flock are
required for delegate tests. The GitHub workflow runs the root checks.

## Provenance and license

MIT, copyright Daniel Unverricht. Git history retains the original
[`pi-worktree-panel`](https://github.com/dunv/pi-worktree-panel) history through
`7a84ea8e795ffc5fb5dd6073a1495e768aae0df0`. Root packaging supersedes the former
standalone extension installation instructions.
