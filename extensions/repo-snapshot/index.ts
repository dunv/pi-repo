import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectSnapshot, formatSnapshot } from "./snapshot.ts";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const check = Type.Object({ ok: Type.Boolean(), output: Type.String() });
export const outputSchema = Type.Object({
  root: Type.String(), collectedAt: Type.String(), durationMs: Type.Number(),
  head: nullableString, branch: nullableString, detached: Type.Boolean(), unborn: Type.Boolean(),
  upstream: nullableString, ahead: nullableNumber, behind: nullableNumber,
  aheadBehindRequested: Type.Boolean(), clean: Type.Boolean(),
  counts: Type.Object({ staged: Type.Number(), unstaged: Type.Number(), untracked: Type.Number(), conflicts: Type.Number() }),
  totalChanges: Type.Number(),
  changes: Type.Array(Type.Object({
    path: Type.String(), index: Type.String(), worktree: Type.String(),
    kind: Type.Union([Type.Literal("ordinary"), Type.Literal("rename"), Type.Literal("unmerged"), Type.Literal("untracked")]),
    submodule: Type.Optional(Type.String()), originalPath: Type.Optional(Type.String()), score: Type.Optional(Type.String()),
  })),
  worktrees: Type.Optional(Type.Array(Type.Object({
    path: Type.String(), head: nullableString, branch: nullableString, detached: Type.Boolean(), bare: Type.Boolean(),
    locked: nullableString, prunable: nullableString,
  }))),
  whitespace: Type.Optional(Type.Object({ staged: check, unstaged: check })),
  capped: Type.Boolean(), artifact: Type.Optional(Type.String()), notes: Type.Array(Type.String()),
});

export default function repoSnapshot(pi: ExtensionAPI) {
  pi.registerTool({
    name: "repo_snapshot",
    label: "Repository snapshot",
    description: "Read local Git branch/HEAD/upstream, ahead/behind and staged/unstaged/untracked/conflicted paths in one on-demand snapshot. No fetch or repository writes. Untracked directories are collapsed. Optional worktree listing and whitespace checks; no diff contents. Output is bounded with a private full-snapshot artifact when capped. Ten-second overall deadline; oversized Git output fails rather than returning partial counts.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory, absolute or relative to session cwd; defaults to session cwd." })),
      fast: Type.Optional(Type.Boolean({ description: "Skip ahead/behind graph traversal (counts unavailable)." })),
      worktrees: Type.Optional(Type.Boolean({ description: "Also list linked worktrees." })),
      whitespaceCheck: Type.Optional(Type.Boolean({ description: "Check staged and unstaged diffs for whitespace errors." })),
    }),
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    executionMode: "parallel",
    promptSnippet: "Get an on-demand local Git repository snapshot.",
    promptGuidelines: [
      "Prefer repo_snapshot for routine repository orientation and combined Git status checks; request full diffs separately only when needed.",
      "Snapshots use local refs without fetching, are not atomic, and never authorize commit, push, or merge. Recheck state after changes; do not infer freshness from an earlier snapshot.",
    ],
    async execute(_id, params, signal, _onUpdate, ctx) {
      const snapshot = await collectSnapshot(ctx.cwd, params, signal);
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }], details: snapshot, structuredContent: snapshot };
    },
  });
}
