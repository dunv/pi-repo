import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Submission = { argv: string[]; cwd: string };
export type DisplayState = Record<string, unknown>;

export function displayState(content: unknown): DisplayState {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
  try {
    const parsed = JSON.parse(text.slice(0, 8192).split("\n", 1)[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* Never echo unrecognized content or diagnostics. */ }
  return {};
}

export function submission(value: unknown): Submission | undefined {
  if (!value || typeof value !== "object") return;
  const { argv, cwd } = value as Partial<Submission>;
  if (Array.isArray(argv) && argv.length && argv.every(arg => typeof arg === "string") && typeof cwd === "string") return { argv, cwd };
}

/** Reuse existing transcript evidence, never persist/enrich job records or query Pueue. */
export function submissionFor(entries: readonly SessionEntry[], nonce: unknown): Submission | undefined {
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce)) return;
  let callId: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "pueue_submit") continue;
    if (displayState(entry.message.content).nonce === nonce) callId = entry.message.toolCallId;
  }
  if (!callId) return;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type === "toolCall" && block.id === callId && block.name === "pueue_submit") return submission(block.arguments);
    }
  }
}

export function statusLabel(state: DisplayState) {
  const id = Number.isSafeInteger(state.id) && Number(state.id) >= 0 ? ` #${state.id}` : "";
  let icon = "?", label = "Status unknown", ink = "warning" as "muted" | "success" | "error" | "warning";
  if (state.phase === "EXITED" && Number.isSafeInteger(state.exitCode)) {
    icon = state.exitCode === 0 ? "✓" : "✗";
    label = `${state.exitCode === 0 ? "Done" : "Failed"} · exit ${state.exitCode}`;
    ink = state.exitCode === 0 ? "success" : "error";
  } else if (state.phase === "KILLED") {
    icon = "■";
    label = "Killed (backend terminal; termination unverified)";
  } else {
    const phases: Record<string, [string, string]> = { QUEUED: ["◷", "Queued"], RUNNING: ["▶", "Running"], PAUSED: ["Ⅱ", "Paused"], STASHED: ["◷", "Stashed"], ADMISSION_UNKNOWN: ["?", "Admission unknown"] };
    const phase = typeof state.phase === "string" && Object.hasOwn(phases, state.phase) ? phases[state.phase] : undefined;
    if (phase) { [icon, label] = phase; if (state.phase !== "ADMISSION_UNKNOWN") ink = "muted"; }
  }
  return { text: `${icon} Pueue${id} · ${label}${state.cancellationRequested === true ? " · cancellation requested" : ""}`, ink };
}

// JSON quoting keeps literal argument boundaries and escapes terminal controls/newlines.
export const displayLiteral = (value: string) => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
const bounded = (text: string, max: number) => text.length > max ? text.slice(0, max) + "… [display truncated]" : text;
export function commandPreview(input: Submission): string {
  return bounded(input.argv.slice(0, 4).map(displayLiteral).join(" ") + (input.argv.length > 4 ? " …" : ""), 160);
}
export function submissionDetails(input: Submission): string[] {
  return [
    `Command (literal argv): ${bounded(input.argv.map(displayLiteral).join(" "), 16384)}`,
    `Working directory: ${bounded(displayLiteral(input.cwd), 4096)}`,
    "Environment: configured Pueue runtime, not the interactive shell; no ambient shell environment inherited.",
    "Execution wrappers/devshell selection, if any, are in the submitted argv above. Runtime environment values are not inspected.",
  ];
}
