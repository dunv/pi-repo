# Changelog

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
