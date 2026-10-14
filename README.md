# pi-worktree-panel

A lightweight right-side changed-files overlay for [Pi](https://pi.dev).

Automatically appears when Pi starts inside a **linked Git worktree**, including its subdirectories. Hidden in the main checkout and outside Git. The panel uses Pi's supported overlay API, does not capture keyboard focus, and requires no Herdr installation to display.

```text
╭──────────────────────────────────────────╮
│ Worktree · fix-checkout                   │
│ fix/checkout                             │
│ /home/me/worktrees/fix-checkout           │
├──────────────────────────────────────────┤
│ 3 changed files                          │
│  M src/checkout.ts                        │
│ A  tests/checkout.test.ts                 │
│ ?? notes.md                              │
│ /worktree-open · /worktree-panel hide     │
╰──────────────────────────────────────────╯
```

## Install

From a local checkout:

```sh
pi install /absolute/path/to/pi-worktree-panel
```

Run `/reload` in existing Pi sessions. Local installations reference the checkout directly: keep it at that path, and reload after source changes. Do not also copy or symlink it into `~/.pi/agent/extensions`, which would load it twice.

From the public GitHub repository, pinned to the current release:

```sh
pi install git:github.com/dunv/pi-worktree-panel@v0.2.0
```

Choose one installation route; don't combine a Pi-managed install with the Nix route below. There is no npm publication yet.

### Nix / Home Manager

The package has no runtime npm dependencies, so a pinned source checkout is sufficient.
The example below pins the original v0.1.0 release; for the agent target tool, pin
v0.2.0 or its immutable commit and update the source hash accordingly:

```nix
home.file.".pi/agent/extensions/pi-worktree-panel".source = pkgs.fetchFromGitHub {
  owner = "dunv";
  repo = "pi-worktree-panel";
  rev = "13b10d86ac480e02fb0c8e92c2cd6d995327dea7"; # v0.1.0
  hash = "sha256-DvfoOCZoUqAaTv+k3k9XxbghoAfhAKEnDwWxT4qYquQ=";
};
```

Remove any existing `pi install` entry for this package before activating Home Manager, then run `/reload`. Pi automatically discovers the package's manifest in the linked directory. Nix-managed resources do not appear in `pi list`, which only reports packages recorded in Pi's settings.

## Commands

| Command | Action |
| --- | --- |
| `/worktree-open` | Choose a changed file and open it in your editor |
| `/worktree-panel hide` | Temporarily hide the overlay |
| `/worktree-panel show` | Show the overlay again |
| `/worktree-panel width 52` | Set width to 30–80 columns; default 44 |
| `/worktree-panel next` / `prev` | Page through long file lists |
| `/worktree-refresh` | Refresh Git status immediately |
| `/worktree-preview /absolute/path` | Display another linked worktree for testing |
| `/worktree-preview off` | Return to the session's working directory |

Preview changes **only the displayed worktree and file-picker target**, not Pi's working directory or the agent's tools. It is explicitly labeled `[preview]`. Panel settings and preview are session-local and reset on reload/restart.

## Agent workflow integration

The model-callable `worktree_panel_target` tool accepts `{ "path": "/absolute/worktree" }`
to target a linked worktree (subdirectories are normalized to its root), or
`{ "path": null }` to restore the session directory. Relative paths, main checkouts,
and non-worktrees are rejected without changing the existing target.

Call it after creating/resuming a feature worktree and clear it before cleanup.
It shares the `/worktree-preview` override and `[preview]` label: only the panel
and file picker change, **not Pi's cwd or tool paths**. Continue using absolute
worktree paths for edits and shell commands. Reapply after reload/restart.
In non-TUI modes it records the target but does not display a panel.

## Status and editor

Status retains Git's two porcelain columns: the first describes staged/index changes, the second describes unstaged/working-tree changes. `??` means untracked. Conflicts are highlighted; deleted files stay visible but are omitted from the file picker. The picker lists every openable file even when the overlay is paginated.

The opener uses `$EDITOR`, falling back to `$VISUAL`. Quoted command arguments are supported; shell pipelines, variable expansion and other shell expressions are not.

- **Inside Herdr:** create an editor tab in the inherited workspace and focus it. This integration is optional and used only on explicit file opening.
- **Otherwise:** launch an Alacritty window with the worktree as its working directory. Git, Alacritty, and the configured editor must be available on `PATH`.

No editor configured, missing files or launch failures produce a notification. Herdr integration has been tested with `nvim`; Alacritty launching has not yet been interactively tested.

## Layout and performance

This is an **overlay**, not a reserved sidebar: it covers the right edge of the conversation without reflowing it. Use `/worktree-panel hide` when reviewing long lines.

The panel hides below 110 terminal columns, when its width would leave fewer than 64 columns to the left, or below 16 terminal rows. Long lists are paginated to the available height.

- Cached layout by content, width, height and page.
- Debounced asynchronous refreshes after tool activity.
- Three-second status polling only while a linked worktree is being displayed; unchanged snapshots do not repaint.
- Git subprocesses have time/output limits and disable optional index writes.
- No runtime npm dependencies, private Pi patches, replacement tools, extra model calls, system-prompt changes or session-file rewrites.

Tested with Pi 1.0.2 and Node 24. Repository-root paths containing newlines are unsupported; changed filenames containing spaces/newlines are parsed safely and terminal controls are escaped. Extremely large Git status outputs are bounded at 8 MiB and cause the panel to hide with a diagnostic.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack
```

Node 24+ is required for the TypeScript-based tests. Pi loads `src/index.ts` directly; no generated build is needed. Pi and TUI libraries are peer dependencies, with pinned development copies for type checking. The tarball contains only source, README, changelog and license.

## Uninstall

```sh
pi remove /absolute/path/to/pi-worktree-panel
```

Then `/reload` or restart Pi. For a GitHub install, remove the same `git:` source used to install it. For a Nix installation, remove the Home Manager declaration and activate the updated configuration instead.

## License

MIT.
