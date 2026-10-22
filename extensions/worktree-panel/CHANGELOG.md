# Changelog

## Unreleased

- Add `/worktree-branch` and optional `branch` on `worktree_panel_target` for persisted read-only local/remote branch diffs without creating or checking out a worktree. Show committed changes only, disable file editing, and pin selected comparisons to commit IDs.

- Support master-only repositories by falling back to master/origin/master when develop/origin/develop is absent; keep develop preferred and show the selected ref in comparisons.

- Truncate long worktree root paths from the left, keeping the worktree name and trailing directories readable.

- Make the diff popup fill terminal height with a one-row gap above and below; keep short diffs top-aligned and the footer at the bottom, including after resizing.

- Default to side-by-side diffs in viewers at least 87 columns wide, with old/new line numbers, syntax highlighting and independent added/removed cell backgrounds.
- Add `s` to toggle unified/side-by-side layouts; fall back to unified on narrow terminals and preserve the preference across resizing.
- Pair replacement blocks, align independently wrapped lines, and retain full-width metadata and binary/conflict summaries.

## 0.5.0

- Add filename-based syntax highlighting to diff hunks, highlighting old/new source independently with multiline color state preserved.
- Show old/new line numbers, colored change markers and subtle added/removed row tints without replacing syntax colors.
- Give both panels opaque dark backgrounds, contrasting title/section bands, visible borders and a distinct focused selection.
- Keep syntax readable with light Pi themes, preserve backgrounds across ANSI resets, and support 256-color terminals.
- Cache highlighting separately from wrapping/scrolling, retain plain-text fallbacks, and pin host development dependencies for runtime import tests.

## 0.4.2

- Add Alt+W to focus the panel from Pi's editor in regular or fullscreen mode; Alt+W/Esc returns focus to Pi.
- Cap sidebar height at one-third of the terminal, including borders; compact metadata on short terminals while retaining both diff areas.
- Keep the diff viewer's larger viewport and existing commands unchanged.

## 0.4.1

- Save the tool-selected worktree per session branch and restore it on reload/resume/restart and tree navigation, without changing Pi's cwd.
- Recover successful target tool results from older versions when upgrading.
- Persist explicit resets and manual previews; report unavailable targets rather than silently falling back to Pi's cwd.
- Cover opening from the main checkout, reload/resume, legacy sessions, reset, tree navigation and removed worktrees with regression tests.

## 0.4.0

- Split the existing panel into committed-vs-develop and uncommitted areas, each with its own file list and paging.
- Compare committed changes from the merge base to HEAD, independently of staged/unstaged/untracked changes.
- Prefer local develop, fall back to origin/develop, and show unavailable comparisons without hiding worktree edits.
- Tab switches areas; Enter views the selected area's diff using existing commands only.
- Keep committed comparisons pinned to the displayed commit IDs and preserve selection by area and path.

## 0.3.1

- Integrate file selection and diff viewing into the existing sidebar using `/worktree-open` or `/worktree-panel`; remove the separate diff command/picker.
- Add ↑/↓ selection, Enter for diff, e for editor, and Esc to release focus.
- Return from diffs to the panel, preserve selected paths during refresh, and allow explicit focus on narrower terminals.

## 0.3.0

- Widen the default changed-files panel from 44 to 64 columns.
- Add `/worktree-diff` with a read-only, scrollable in-Pi viewer.
- Show staged/unstaged patches separately, including renames, deletions, conflicts, untracked files and binary summaries.
- Wrap long diff lines and escape terminal controls; disable external diff/textconv execution.

## 0.2.0

- Add the model-callable `worktree_panel_target` tool for feature-worktree workflows.
- Validate and normalize linked-worktree targets; clear with `path: null`.
- Keep Pi's cwd and tool paths unchanged, with session-local panel/file-picker targeting.
- Reset the override when starting a session.

## 0.1.0

- Worktree-only, non-capturing right-side Pi overlay.
- Branch, path, and staged/unstaged/untracked file status.
- Responsive visibility, cached layout, adjustable width, and pagination.
- Changed-file picker with optional Herdr tabs and Alacritty fallback.
- Debounced asynchronous Git refreshes and bounded background polling.
- Explicit worktree preview for testing.
