import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFrom, json, writable, envFor } from "./core.mjs";
import { toolSummary } from "./progress.mjs";

const exec = promisify(execFile);
export default function (pi: ExtensionAPI) {
  const runtimePath = process.env.PI_DELEGATE_RUNTIME, id = process.env.PI_DELEGATE_TASK, attempt = process.env.PI_DELEGATE_ATTEMPT;
  // Print mode only emits the final answer on stdout. Mirror progress on stderr
  // so Pueue/Pui can follow it without changing report.md or exposing thinking.
  const progress = (text: string) => new Promise<void>((resolve, reject) => {
    process.stderr.write(text, error => error ? reject(error) : resolve());
  });
  pi.on("message_update", async event => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") await progress(update.delta);
    if (update.type === "text_end") await progress("\n");
  });
  let nextCall = 0;
  const activeCalls = new Map<string, number>();
  pi.on("tool_execution_start", async event => {
    const call = ++nextCall;
    activeCalls.set(event.toolCallId, call);
    await progress(`\n[delegate] Tool #${call} starting: ${event.toolName} ${toolSummary(event.toolName, event.args)}\n`);
  });
  pi.on("tool_execution_end", async event => {
    const call = activeCalls.get(event.toolCallId) ?? "?";
    activeCalls.delete(event.toolCallId);
    const duration = typeof event.durationMs === "number" ? ` (${Math.round(event.durationMs)}ms)` : "";
    await progress(`[delegate] Tool #${call} finished: ${event.toolName}${duration}${event.isError ? " (error)" : ""}\n`);
  });
  async function context() {
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Missing task identity");
    const runtime = await runtimeFrom(runtimePath);
    return { runtime, task: await json(join(runtime.state, id, "task.json")) };
  }
  pi.on("tool_call", async event => {
    if (["write", "edit"].includes(event.toolName)) {
      const { task } = await context();
      const path = (event.input as { path?: string }).path;
      if (typeof path !== "string") return { block: true, reason: "A source path is required" };
      try { await writable(task, path); } catch (error) { return { block: true, reason: String(error) }; }
    }
  });
  pi.registerTool({
    name: "delegate_check", label: "Run planned verification", executionMode: "sequential",
    description: "Run one orchestrator-planned verification check by zero-based index. All delegated heavy checks share a machine-wide lock. No arbitrary commands, implicit SDK bootstrap, timeout or retry. Check output/evidence stays in task artifacts. Do not loop on failures; report blockers.",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0, maximum: 7 }) }),
    async execute(_id, input) {
      const { runtime, task } = await context();
      if (!task.checks[input.index]) throw new Error("Check not planned");
      const args = [join(runtime.state, "verification.lock"), runtime.node,
        join(dirname(fileURLToPath(import.meta.url)), "check.mjs"), runtimePath!, id!, String(input.index), ...(attempt === undefined ? [] : [attempt])];
      let output: string;
      try { output = (await exec(runtime.flock, args, { cwd: task.worktree, env: envFor(runtime), maxBuffer: 32768 })).stdout; }
      catch (error: any) { throw new Error(`Check failed/incomplete. Inspect task artifacts; do not automatically retry. ${error.stdout ?? ""}`); }
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  });
}
