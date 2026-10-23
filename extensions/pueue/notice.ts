import { commandPreview, displayState, statusLabel, submissionDetails, type Submission } from "./presentation.ts";

/** UI only: never change authoritative state, model content or notification routing. */
export function noticeText(content: unknown, expanded = false, input?: Submission): string {
  const state = displayState(content);
  const line = statusLabel(state).text;
  const preview = input ? `\n  ${commandPreview(input)}` : "";
  if (!expanded) return line + preview;
  const nonce = typeof state.nonce === "string" && /^[a-f0-9-]{36}$/.test(state.nonce) ? `\nJob nonce: ${state.nonce}` : "";
  const details = input ? `\n${submissionDetails(input).join("\n")}` : "\nSubmission details unavailable in this session branch.";
  return line + details + nonce + "\nBackend result only; publication and descendant termination remain unverified.";
}
