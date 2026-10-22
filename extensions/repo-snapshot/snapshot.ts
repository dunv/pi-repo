import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export type Change = {
  path: string;
  index: string;
  worktree: string;
  kind: "ordinary" | "rename" | "unmerged" | "untracked";
  submodule?: string;
  originalPath?: string;
  score?: string;
};
export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
};
export type Snapshot = {
  root: string;
  collectedAt: string;
  durationMs: number;
  head: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  aheadBehindRequested: boolean;
  clean: boolean;
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number };
  totalChanges: number;
  changes: Change[];
  worktrees?: Worktree[];
  whitespace?: { staged: { ok: boolean; output: string }; unstaged: { ok: boolean; output: string } };
  capped: boolean;
  artifact?: string;
  notes: string[];
};
export interface SnapshotOptions {
  path?: string;
  fast?: boolean;
  worktrees?: boolean;
  whitespaceCheck?: boolean;
}
const MAX_GIT_BYTES = 16 * 1024 * 1024;
const DEADLINE_MS = 10_000;
const MAX_CHANGES = 100;
const MAX_PRESENTATION_BYTES = 16 * 1024;

// Never inherit caller Git routing/index overrides: path is the repository selector.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function git(cwd: string, args: string[], signal: AbortSignal, allowWhitespaceExit = false): Promise<{ text: string; code: number }> {
  return new Promise((accept, reject) => {
    execFile("git", ["--no-pager", "--no-optional-locks", "-c", "color.ui=false", ...args], {
      cwd, env: gitEnvironment(), signal, encoding: "buffer", maxBuffer: MAX_GIT_BYTES,
    }, (error, stdout, stderr) => {
      const code = error ? (error as unknown as { code?: string | number }).code : 0;
      try {
        if (error && !(allowWhitespaceExit && code === 2 && stderr.length === 0)) {
          if (signal.aborted) throw new Error("Repository snapshot cancelled or exceeded its 10-second deadline.");
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Git output exceeded 16 MiB; no partial snapshot returned.");
          throw new Error(`git ${args[0]} failed: ${stderr.toString("utf8").trim().slice(0, 1500) || error.message}`);
        }
        // Reject unsupported filenames rather than silently corrupting paths.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
        accept({ text, code: Number(code) });
      } catch (failure) { reject(failure); }
    });
  });
}

function fields(record: string, count: number): { prefix: string[]; path: string } {
  const prefix: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(" ", start);
    if (end < 0) throw new Error("Malformed Git porcelain record.");
    prefix.push(record.slice(start, end));
    start = end + 1;
  }
  return { prefix, path: record.slice(start) };
}

export function parseStatus(text: string): Pick<Snapshot, "head" | "branch" | "detached" | "unborn" | "upstream" | "ahead" | "behind" | "changes" | "clean" | "counts" | "totalChanges"> {
  const result = {
    head: null as string | null, branch: null as string | null, detached: false, unborn: false,
    upstream: null as string | null, ahead: null as number | null, behind: null as number | null,
    changes: [] as Change[], clean: true,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, totalChanges: 0,
  };
  const records = text.split("\0");
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice(13);
      result.unborn = value === "(initial)";
      result.head = result.unborn ? null : value;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice(14);
      result.detached = value === "(detached)";
      result.branch = result.detached ? null : value;
    } else if (line.startsWith("# branch.upstream ")) result.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+|\?) -(\d+|\?)$/.exec(line);
      if (!match) throw new Error("Malformed Git ahead/behind header.");
      result.ahead = match[1] === "?" ? null : Number(match[1]);
      result.behind = match[2] === "?" ? null : Number(match[2]);
    } else if (line.startsWith("# ")) continue;
    else if (line.startsWith("? ")) {
      result.changes.push({ path: line.slice(2), index: "?", worktree: "?", kind: "untracked" });
      result.counts.untracked++;
    } else if (/^[12u] /.test(line)) {
      const kind = line[0];
      const { prefix, path } = fields(line, kind === "1" ? 8 : kind === "2" ? 9 : 10);
      const xy = prefix[1];
      if (xy.length !== 2 || !path) throw new Error("Malformed Git change record.");
      const change: Change = {
        path, index: xy[0], worktree: xy[1], submodule: prefix[2],
        kind: kind === "1" ? "ordinary" : kind === "2" ? "rename" : "unmerged",
      };
      if (kind === "2") {
        change.originalPath = records[++i]; change.score = prefix[8];
        if (!change.originalPath) throw new Error("Missing original Git rename path.");
      }
      if (kind === "u") result.counts.conflicts++;
      else {
        if (xy[0] !== ".") result.counts.staged++;
        if (xy[1] !== ".") result.counts.unstaged++;
      }
      result.changes.push(change);
    } else throw new Error("Unexpected Git porcelain record.");
  }
  result.totalChanges = result.changes.length;
  result.clean = result.totalChanges === 0;
  return result;
}

export function parseWorktrees(text: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const record of text.split("\0")) {
    if (!record) continue;
    if (record.startsWith("worktree ")) {
      current = { path: record.slice(9), head: null, branch: null, detached: false, bare: false, locked: null, prunable: null };
      trees.push(current);
    } else if (current) {
      if (record.startsWith("HEAD ")) current.head = record.slice(5);
      else if (record.startsWith("branch ")) current.branch = record.slice(7);
      else if (record === "detached") current.detached = true;
      else if (record === "bare") current.bare = true;
      else if (record === "locked" || record.startsWith("locked ")) current.locked = record.slice(7);
      else if (record === "prunable" || record.startsWith("prunable ")) current.prunable = record.slice(9);
    }
  }
  return trees;
}

export async function collectSnapshot(cwd: string, options: SnapshotOptions = {}, callerSignal?: AbortSignal): Promise<Snapshot> {
  const started = performance.now();
  const collectedAt = new Date().toISOString();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const selected = resolve(cwd, options.path ?? ".");
  const location = await git(selected, ["rev-parse", "--path-format=absolute", "--show-toplevel"], signal);
  // Remove exactly Git's final LF, preserving newlines in the directory name.
  const root = location.text.replace(/\n$/, "");
  const status = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=none",
    ...(options.fast ? ["--no-ahead-behind"] : [])], signal);
  const snapshot: Snapshot = {
    root, collectedAt, durationMs: 0, ...parseStatus(status.text), aheadBehindRequested: !options.fast,
    capped: false,
    notes: ["Local tracking refs only; no fetch. Untracked directories may be collapsed; counts are entries, not files.",
      "Observation, not an atomic transaction or commit/push/merge authorization. Optional checks may observe later changes."],
  };
  // Fast-mode '+? -?' headers are represented by null counts, never invented zeros.
  if (options.worktrees) snapshot.worktrees = parseWorktrees((await git(root, ["worktree", "list", "--porcelain", "-z"], signal)).text);
  if (options.whitespaceCheck) {
    const [staged, unstaged] = await Promise.all([
      git(root, ["diff", "--no-ext-diff", "--no-textconv", "--check", "--cached", "--"], signal, true),
      git(root, ["diff", "--no-ext-diff", "--no-textconv", "--check", "--"], signal, true),
    ]);
    snapshot.whitespace = { staged: { ok: staged.code === 0, output: staged.text }, unstaged: { ok: unstaged.code === 0, output: unstaged.text } };
  }
  snapshot.durationMs = Math.round(performance.now() - started);
  const full = JSON.stringify(snapshot, null, 2);
  if (snapshot.changes.length > MAX_CHANGES || Buffer.byteLength(full) > MAX_PRESENTATION_BYTES) {
    const directory = await mkdtemp(join(tmpdir(), "pi-repo-snapshot-"));
    const artifact = join(directory, "snapshot.json");
    await writeFile(artifact, full + "\n", { mode: 0o600 });
    snapshot.capped = true; snapshot.artifact = artifact;
    snapshot.changes = snapshot.changes.slice(0, MAX_CHANGES);
    // Entire optional sections remain available in the artifact; do not mislabel partial checks as complete.
    if (snapshot.whitespace) snapshot.whitespace = {
      staged: { ok: snapshot.whitespace.staged.ok, output: snapshot.whitespace.staged.output.slice(0, 2000) },
      unstaged: { ok: snapshot.whitespace.unstaged.ok, output: snapshot.whitespace.unstaged.output.slice(0, 2000) },
    };
    snapshot.notes.push("Presentation capped; complete collected data is in the private artifact. Temporary artifacts require manual cleanup.");
    while (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PRESENTATION_BYTES) {
      if (snapshot.changes.length) snapshot.changes.pop();
      else if (snapshot.worktrees?.length) snapshot.worktrees.pop();
      else { delete snapshot.whitespace; break; }
    }
  }
  return snapshot;
}

export function formatSnapshot(s: Snapshot): string {
  const lines = [
    `Worktree: ${JSON.stringify(s.root)}`,
    `Branch: ${JSON.stringify(s.branch)}${s.detached ? " (detached)" : s.unborn ? " (unborn)" : ""}; HEAD: ${s.head ?? "none"}`,
    `Upstream: ${JSON.stringify(s.upstream)}; ahead/behind: ${s.ahead ?? "unknown"}/${s.behind ?? "unknown"}${s.aheadBehindRequested ? "" : " (not requested)"}`,
    `${s.clean ? "Clean" : "Dirty"}; staged ${s.counts.staged}, unstaged ${s.counts.unstaged}, untracked entries ${s.counts.untracked}, conflicts ${s.counts.conflicts}`,
    ...s.changes.map(c => `${c.index}${c.worktree} ${JSON.stringify(c.path)}${c.originalPath === undefined ? "" : ` <- ${JSON.stringify(c.originalPath)}`}${c.submodule && c.submodule !== "N..." ? ` [${c.submodule}]` : ""}`),
  ];
  if (s.worktrees) lines.push(`Worktrees: ${JSON.stringify(s.worktrees)}`);
  if (s.whitespace) lines.push(`Whitespace: ${JSON.stringify(s.whitespace)}`);
  if (s.capped) lines.push(`Capped: showing ${s.changes.length}/${s.totalChanges} change entries. Full snapshot: ${s.artifact}`);
  lines.push(...s.notes, `Collected ${s.collectedAt}; ${s.durationMs} ms.`);
  return lines.join("\n");
}
