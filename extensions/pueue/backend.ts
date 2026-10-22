import { execFile } from "node:child_process";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Config = {
  binary: string; config: string; data: string; namespace: string;
  home: string; path: string; hints?: string;
};
export type Task = { id: number; created: string; label: string; phase: string; exitCode?: number };
export type Run = (args: string[]) => Promise<string>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function configuration(env: NodeJS.ProcessEnv): Config | undefined {
  if (!env.PI_PUEUE_BINARY) return undefined;
  const c = {
    binary: env.PI_PUEUE_BINARY, config: env.PI_PUEUE_CONFIG ?? "", data: env.PI_PUEUE_DATA ?? "",
    namespace: env.PI_PUEUE_NAMESPACE ?? "", home: env.HOME ?? "",
    path: env.PI_PUEUE_PATH ?? "", hints: env.PI_PUEUE_HINTS,
  };
  if (![c.binary, c.config, c.data, c.home].every(isAbsolute) || !uuid.test(c.namespace)
    || !c.path || c.path.split(":").some(p => !isAbsolute(p)) || (c.hints && !isAbsolute(c.hints))) {
    throw new Error("Invalid Pueue configuration; see extensions/pueue/README.md");
  }
  return c;
}
/** The ONLY inherited values: explicitly selected non-secret paths and fixed locale.
 * Pueue add serializes this environment. Never spread process.env here. */
export function minimalEnvironment(c: Config): NodeJS.ProcessEnv {
  return { HOME: c.home, PATH: c.path, LANG: "C.UTF-8" };
}
export function runner(c: Config): Run {
  return args => new Promise((resolve, reject) => {
    execFile(c.binary, ["--config", c.config, "--color", "never", ...args], {
      env: minimalEnvironment(c), maxBuffer: 4 * 1024 * 1024,
      // No operation signal or execution timeout: cancelling Pi never cancels an admitted job.
    }, (error, stdout) => {
      // execFile errors embed argv/stdout/stderr, potentially including credentials from other tasks.
      if (error) reject(new Error("Pueue CLI failed; admission/signal outcome may be UNKNOWN. Do not retry automatically."));
      else resolve(stdout);
    });
  });
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Project immediately; no raw task, command, envs or backend diagnostics escape this boundary. */
export function project(text: string): Task[] {
  let state: unknown;
  try { state = JSON.parse(text); } catch { throw new Error("Invalid Pueue status response"); }
  if (!object(state) || !object(state.tasks)) throw new Error("Invalid Pueue state schema");
  const tasks: Task[] = [];
  for (const raw of Object.values(state.tasks)) {
    if (!object(raw) || !Number.isSafeInteger(raw.id) || Number(raw.id) < 0
      || typeof raw.created_at !== "string" || !Number.isFinite(Date.parse(raw.created_at))
      || typeof raw.label !== "string" || !object(raw.status)) continue;
    let phase = "UNKNOWN", exitCode: number | undefined;
    for (const key of ["Stashed", "Queued", "Running", "Paused", "Locked"]) {
      if (object(raw.status[key])) phase = key.toUpperCase();
    }
    if (object(raw.status.Done)) {
      const result = raw.status.Done.result;
      if (result === "Success") { phase = "EXITED"; exitCode = 0; }
      else if (object(result) && Number.isSafeInteger(result.Failed)) {
        phase = "EXITED"; exitCode = Number(result.Failed);
      }
      // Killed may be synthetic restore state. Other failures do not establish process termination.
    }
    tasks.push({ id: Number(raw.id), created: raw.created_at, label: raw.label, phase, ...(exitCode === undefined ? {} : { exitCode }) });
  }
  return tasks;
}
export function quote(text: string): string {
  if (text.includes("\0")) throw new Error("NUL is not a valid argument");
  return "'" + text.replace(/'/g, "'\\''") + "'";
}
export function command(argv: string[]): string {
  if (!argv.length || !isAbsolute(argv[0]) || argv.length > 256
    || argv.some(a => a.length > 8192) || argv.join("").length > 32768) throw new Error("Use bounded literal argv with an absolute executable");
  return argv.map(quote).join(" ");
}
export class Backend {
  readonly config: Config;
  readonly run: Run;
  constructor(config: Config, run: Run = runner(config)) { this.config = config; this.run = run; }
  async check() {
    if ((await this.run(["--version"])).trim() !== "pueue 4.0.4") throw new Error("Only Pueue 4.0.4 is supported; no automatic install/start/upgrade");
  }
  async tasks(): Promise<Task[]> { return project(await this.run(["status", "--json"])); }
  async reserve(group: string) {
    const reply = await this.run(["group", "add", "--parallel", "1", group]);
    if (reply.trim() !== `New group "${group}" has been created`) throw new Error("Reservation refused or uncertain; no automatic retry or takeover");
  }
  async add(argv: string[], cwd: string, label: string, group?: string): Promise<number> {
    if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
    const output = await this.run(["add", "--stashed", "--print-task-id", "--working-directory", cwd,
      "--label", label, ...(group ? ["--group", group] : []), "--", command(argv)]);
    if (!/^\d+\s*$/.test(output) || !Number.isSafeInteger(Number(output))) throw new Error("Admission UNKNOWN; reconcile the saved nonce, do not resubmit");
    return Number(output);
  }
  async enqueue(id: number) { await this.run(["enqueue", String(id)]); }
  async term(id: number) { await this.run(["kill", "--signal", "SIGTERM", String(id)]); }
  logPath(id: number) { return join(this.config.data, "task_logs", `${id}.log`); }
}
export async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error("Pueue hints directory must be owned by this user, non-symlink and mode 0700");
  }
}
/** Positional, asynchronous byte slices. Full backend-owned logs are never capped or deleted. */
export async function sliceLog(path: string, offset?: number, limit = 16384) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384
    || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))) throw new Error("Invalid log slice");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Not a regular backend log");
    const start = offset ?? Math.max(0, info.size - limit);
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, info.size - start)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return { path, start, end: start + bytesRead, size: info.size,
      omittedBefore: start > 0, omittedAfter: start + bytesRead < info.size,
      text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally { await file.close(); }
}
