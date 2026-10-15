import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";

const exec = promisify(execFile);
export type ChangedFile = { status: string; path: string; from?: string };
export type Snapshot = { root: string; branch: string; files: ChangedFile[] };

export async function git(cwd: string, args: string[], diffExit = false): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  try {
    const result = await exec("git", ["-C", cwd, ...args], { env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; killed?: boolean };
    // --no-index reports differences with exit 1, not an execution failure.
    if (diffExit && failure.code === 1 && !failure.killed && typeof failure.stdout === "string") return failure.stdout;
    throw error;
  }
}

export function parseStatus(text: string): ChangedFile[] {
  const records = text.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status record");
    const status = record.slice(0, 2);
    const file: ChangedFile = { status, path: record.slice(3) };
    if (/[RC]/.test(status)) {
      const from = records[++i];
      if (!from) throw new Error("Missing rename source");
      file.from = from;
    }
    files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Only linked worktrees: a submodule's .git file alone is NOT sufficient.
export async function linkedRoot(cwd: string): Promise<string | undefined> {
  try {
    const dirs = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).trimEnd().split("\n");
    if (dirs.length !== 2 || resolve(dirs[0]) === resolve(dirs[1])) return undefined;
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trimEnd();
  } catch { return undefined; }
}

export async function readSnapshot(root: string): Promise<Snapshot> {
  const [status, branch] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  let name = branch.trim();
  if (name === "HEAD") name = `detached ${(await git(root, ["rev-parse", "--short", "HEAD"])).trim()}`;
  return { root, branch: name, files: parseStatus(status) };
}

export async function readDiff(root: string, file: ChangedFile): Promise<string> {
  const target = fileTarget(root, file.path);
  const options = ["--no-ext-diff", "--no-textconv", "--color=never", "--no-exit-code"];
  if (file.status === "??") {
    const patch = await git(root, ["diff", ...options, "--no-index", "--", "/dev/null", target], true);
    return `Untracked\n${patch || "Empty untracked file"}`;
  }
  const paths = [file.path, ...(file.from ? [file.from] : [])];
  paths.forEach(path => fileTarget(root, path));
  const pathspecs = paths.map(path => `:(literal)${path}`);
  const [staged, unstaged] = await Promise.all([
    git(root, ["diff", ...options, "--cached", "--", ...pathspecs]),
    git(root, ["diff", ...options, "--", ...pathspecs]),
  ]);
  return [staged && `Staged\n${staged}`, unstaged && `Unstaged\n${unstaged}`].filter(Boolean).join("\n")
    || "No textual diff (file may have changed since selection).";
}

// Prevent malicious filenames/branch names from emitting terminal control codes.
export function display(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
export function shellQuote(text: string): string { return "'" + text.replace(/'/g, "'\\''") + "'"; }

// $EDITOR is a command with optional quoted arguments, NOT executable shell code.
export function editorArgs(command: string): string[] {
  const args: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      if (++i === command.length) throw new Error("Trailing backslash in $EDITOR");
      word += command[i]; started = true;
    } else if (quote) {
      if (ch === quote) quote = ""; else word += ch;
    } else if (ch === "'" || ch === '"') { quote = ch; started = true;
    } else if (/\s/.test(ch)) {
      if (started) { args.push(word); word = ""; started = false; }
    } else { word += ch; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in $EDITOR");
  if (started) args.push(word);
  if (!args[0]) throw new Error("Set $EDITOR or $VISUAL first");
  return args;
}

export function fileTarget(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("File is outside the worktree");
  return target;
}
