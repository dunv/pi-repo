# pi-worktree-panel

A lightweight right-side changed-files overlay for [Pi](https://pi.dev).

Automatically appears when Pi starts inside a **linked Git worktree**, including its subdirectories. Hidden in the main checkout and outside Git. The panel uses Pi's supported overlay API, stays passive until explicitly focused, and requires no Herdr installation to display.

```text
╭──────────────────────────────────────────╮
│ Worktree · fix-checkout                   │
│ fix/checkout                             │
│ /home/me/worktrees/fix-checkout           │
│ ── Committed vs develop · 2              │
│ M  src/checkout.ts                        │
│ A  tests/checkout.test.ts                 │
│ ── Uncommitted · 2                       │
│  M src/checkout.ts                        │
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
pi install git:github.com/dunv/pi-worktree-panel@v0.5.0
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

**Alt+W** focuses the panel directly from Pi's editor, including in regular
(non-fullscreen) mode. Press Alt+W again in the panel to return to Pi, or use
Esc/q. Your draft stays in the editor. The shortcut appears in `/hotkeys`.

| Command | Action |
| --- | --- |
| `/worktree-open` | Focus the existing panel; ↑/↓ select, Enter shows diff, e opens editor |
| `/worktree-panel` | Focus the same panel |
| `/worktree-panel hide` | Temporarily hide the overlay |
| `/worktree-panel show` | Show the overlay again |
| `/worktree-panel width 52` | Set width to 30–80 columns; default 64 |
| `/worktree-panel next` / `prev` | Page through long file lists |
| `/worktree-refresh` | Refresh Git status immediately |
| `/worktree-preview /absolute/path` | Display another linked worktree for testing |
| `/worktree-preview off` | Return to the session's working directory |

Preview changes **only the displayed worktree and diff/editor target**, not Pi's working directory or the agent's tools. It is explicitly labeled `[preview]`. Width/visibility reset on reload/restart. The target is saved per session branch and restored automatically.

## Agent workflow integration

The model-callable `worktree_panel_target` tool accepts `{ "path": "/absolute/worktree" }`
to target a linked worktree (subdirectories are normalized to its root), or
`{ "path": null }` to restore the session directory. Relative paths, main checkouts,
and non-worktrees are rejected without changing the existing target.

Call it after creating/resuming a feature worktree and clear it before cleanup.
It shares the `/worktree-preview` override and `[preview]` label: only the panel
and diff/editor target change, **not Pi's cwd or tool paths**. Continue using absolute
worktree paths for edits and shell commands. `/worktree-open` and `/worktree-panel`
always use this selected target, even when Pi stays in the main checkout.

The target is saved through Pi's session-entry API and restored on reload, resume,
restart, fork, or tree navigation from the active session branch. Successful target
tool results from older versions are also recovered, so upgrading does not require
another tool call. Explicit `path: null` or `/worktree-preview off` clears the saved
override. New sessions do not inherit another session's target. Removed worktrees
produce an explicit unavailable-target message rather than silently switching repos.
In non-TUI modes it records the target but does not display a panel.

## Two diff areas

The panel always shows two independently paginated areas:

- **Committed vs develop** (or **master**): files changed from the merge base with
  the selected base branch to the displayed branch's HEAD (e.g. `git diff develop...HEAD`).
  This excludes changes made only on the base branch after divergence and all staged/unstaged edits.
  The viewer uses the displayed commit IDs, so a later commit cannot change an
  already selected comparison.
- **Uncommitted:** staged, unstaged, and untracked changes in the worktree. Its
  viewer keeps staged and unstaged patches separate; untracked files are additions.

A file can appear in both areas with different diffs. A clean worktree does not
hide committed branch changes. Base refs are tried in this order: `develop`,
`origin/develop`, `master`, `origin/master`. Thus develop remains the default,
while master-only repositories work automatically. The heading and diff viewer
show the selected ref. Nothing is fetched automatically. If none of these refs
exists or the selected ref has no common ancestor, the committed area says
unavailable; the uncommitted area continues working. An existing develop ref
without a common ancestor does not silently fall back to master.

Use Tab to switch areas, or ↑/↓ to move through all files. Paging never hides
either area's heading. `/worktree-panel next|prev` pages both areas while passive,
or the selected area while focused.

## Status and editor

In the uncommitted area, status retains Git's two porcelain columns: the first describes staged/index changes, the second describes unstaged/working-tree changes. `??` means untracked. Conflicts are highlighted; deleted files remain selectable for diffs. While the panel is focused, press e to open the selected file in your editor; missing/deleted files produce a notification rather than being recreated. Selection automatically pages through the full list and is preserved by area and filename across refreshes. Committed files show their change type (A/M/D/R/etc.) rather than index/worktree status.

The opener uses `$EDITOR`, falling back to `$VISUAL`. Quoted command arguments are supported; shell pipelines, variable expansion and other shell expressions are not.

- **Inside Herdr:** create an editor tab in the inherited workspace and focus it. This integration is optional and used only on explicit file opening.
- **Otherwise:** launch an Alacritty window with the worktree as its working directory. Git, Alacritty, and the configured editor must be available on `PATH`.

No editor configured, missing files or launch failures produce a notification. Herdr integration has been tested with `nvim`; Alacritty launching has not yet been interactively tested.

## Show diff

Press **Alt+W**, or run `/worktree-open` (or `/worktree-panel`), to focus the **existing sidebar**.
Use ↑/↓ or j/k to select a file, PgUp/PgDn or Home/End to navigate, and Enter to
show its diff, including deleted files. Press e for the editor, or Esc/q/Ctrl+C
to return focus to Pi. There is no separate file picker or diff command.

The read-only viewer shows the comparison for the selected area. In the
uncommitted area it shows staged and unstaged patches separately and untracked
files as additions. Code hunks use filename-based syntax highlighting (including
Nix), old/new line-number gutters, and green/red markers with subtle row tints.
At viewer widths of **87 columns or more**, diffs default to **side-by-side**:
old code on the left, new code on the right, with independent line numbers and
red/green cell backgrounds. Replacement blocks are paired by line position;
insertions/deletions have a blank opposite side. Each side wraps independently.
Press **s** to toggle unified/side-by-side layouts. Narrower viewers always use
unified layout; the chosen preference survives resizing until the viewer closes.
Old and new code are highlighted separately so multiline syntax survives edits.
Unknown languages, binary summaries and combined conflict diffs remain readable
as plain text. Syntax is cached outside the scroll path; very large hunks fall
back to plain text. Renames, conflicts and binary-file summaries use Git's diff
output. Long lines wrap; use ↑/↓ (or j/k), PgUp/PgDn, Space, and
Home/End (or g/G) to navigate. Esc, q, or Ctrl+C closes the viewer and returns
focus to the file panel. No editor, Alacritty or Herdr is required.

Diffs are fetched only on request, respect the preview/agent target, disable
external diff/textconv commands, and are bounded by the Git timeout/output limits.
The viewer is a snapshot; refresh the panel and reopen it to see subsequent edits or commits.

## Layout and performance

Both the sidebar and diff viewer have opaque dark backgrounds, contrasting
blue-gray title/section bands, and visible borders. Focus brightens the sidebar
border and highlights the selected row. Syntax colors are lifted when necessary
for readability on the dark surface, including when Pi uses a light theme.
Truecolor and 256-color terminals are supported; Pi's global theme is unchanged.

This is an **overlay**, not a reserved sidebar: it covers the right edge of the conversation without reflowing it. Use `/worktree-panel hide` when reviewing long lines.

The panel hides below 110 terminal columns, when its width would leave fewer than 64 columns to the left (128 columns at the default width of 64), or below 24 terminal rows. Explicitly focusing the panel relaxes the left-side space requirement: it only needs its own width plus two columns.

The sidebar is capped at **one-third of the terminal height**, including borders.
On shorter terminals its branch is folded into the title and the full root-path
row is omitted, keeping both diff areas visible. When shown, long root paths are
shortened from the left (`…/worktrees/feature-name`), preserving the path ending. Long lists paginate within that
limit; all files remain accessible. The separate diff viewer fills the terminal
height with a one-row gap above and below and retains its 90% width. Short diffs
stay top-aligned, with empty rows below and the navigation footer at the bottom.

- Cached layout by content, width, height and page.
- Debounced asynchronous refreshes after tool activity.
- Three-second status polling only while a linked worktree is being displayed; unchanged snapshots do not repaint.
- Git subprocesses have time/output limits and disable optional index writes.
- No runtime npm dependencies, private Pi patches, replacement tools, extra model calls, system-prompt changes or direct session-file rewrites (target state uses Pi's append-only session API).

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
