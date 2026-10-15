# Changelog

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
