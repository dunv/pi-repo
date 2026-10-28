# On-demand repository snapshot

`repo_snapshot` replaces routine bundles of Git orientation commands with one
bounded response. It runs only when called: no startup hook, prompt injection,
watcher, network request, settings mutation, or background service.

```text
repo_snapshot({})
repo_snapshot({ path: "/path/to/worktree", fast: true })
repo_snapshot({ worktrees: true, whitespaceCheck: true })
```

The default performs two asynchronous, shell-free Git invocations: resolve the
worktree root with `rev-parse`, then collect `status --porcelain=v2 --branch -z`.
Paths in changes are relative to that root, including when called from a subfolder.
Index/worktree status, rename source paths, submodule flags and conflicts remain
separate. Counts are change entries, not line counts; a path changed in both the
index and worktree counts in both categories. Conflicts have their own count.
Untracked directories are collapsed; ignored entries are not included. Unborn and
detached HEAD and unavailable tracking counts are explicit. Local tracking refs
may be stale: this tool never fetches. Fast mode skips ahead/behind traversal.

Optional worktree listing costs one additional invocation. Whitespace checking
costs two (staged and unstaged), run in parallel. It disables external diff and
textconv; it is not a replacement for a project's formatter, tests or merge gates.
No diff contents, line statistics, history, or stash inspection are collected.

## Boundaries

- Uses installed Git, not another implementation or custom daemon. No new runtime
  npm dependencies; Pi provides TypeBox and its extension API.
- Disables optional Git index refresh writes, terminal prompts and inherited
  `GIT_*` routing overrides. Git still respects ordinary repository/user config,
  including ignore rules and configured fsmonitor. This is not a sandbox for
  untrusted repository config.
- Ten-second overall Git deadline and caller cancellation. Each Git response has
  a 16 MiB safety ceiling; overflow fails instead of reporting partial counts.
- UTF-8 paths (including spaces, tabs, newlines and leading dashes) are preserved
  via NUL-delimited parsing. Invalid UTF-8 fails rather than returning altered
  filenames. Text presentation quotes paths to escape terminal controls.
- At most 100 change entries and approximately 16 KiB of structured presentation.
  Larger results retain complete counts and save the full collected snapshot to
  a private temporary directory (0700), file (0600). `capped`/`artifact` apply to
  the entire presentation, including optional sections. These artifacts are local,
  potentially sensitive and manually cleaned up; no automatic deletion process.
- No durable status cache: concurrent agents and outside edits make it unsafe to
  reuse earlier mutable state. A snapshot is an observation, not an atomic
  transaction; optional commands may observe different instants. Recheck before
  acting. No snapshot grants commit/push/merge permission.

The tool declares an output schema and returns `structuredContent` for codemode
callers as well as compact model-facing text. Collection/parsing is separate from
Pi registration so it can be exercised without loading Pi.

## Installation and tests

The root package manifest registers this extension alongside the worktree panel,
Pueue adapter and delegate tools. Install the root package once; do not separately
install this subdirectory. Reload/restart Pi after updating the installed source.

From the package root with Node >=24:

```sh
npm run check
node --test extensions/repo-snapshot/test/*.test.mjs
```

Tests include Pi registration and TypeBox structured-output validation. The root
package suite checks actual Pi discovery through an extension-directory symlink.
The extension is strictly type-checked against Pi 1.3.0. Test timings are not an
end-to-end agent speedup or a cold-cache/large-repository guarantee.

Tests use private temporary Git repositories; no user repository commits,
fetches or configuration changes. Production collection never fetches; the
upstream fixture fetches only from its own temporary local bare repository.
