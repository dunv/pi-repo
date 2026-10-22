/** UI only: never change authoritative state, model content or notification routing. */
export function noticeText(content: unknown, expanded = false): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
  let state: Record<string, unknown> = {};
  try {
    const first = text.slice(0, 8192).split("\n", 1)[0];
    const parsed = JSON.parse(first);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
  } catch { /* Old/malformed entries are displayed neutrally, never as raw instructions. */ }
  const id = Number.isSafeInteger(state.id) && Number(state.id) >= 0 ? ` #${state.id}` : "";
  let status = "state unknown";
  if (state.phase === "EXITED" && Number.isSafeInteger(state.exitCode)) status = `finished · exit ${state.exitCode}`;
  else if (state.phase === "ADMISSION_UNKNOWN") status = "admission unknown";
  const cancel = state.cancellationRequested === true ? " · cancellation requested" : "";
  const line = `Pueue job${id} ${status}${cancel}`;
  if (!expanded) return line;
  const nonce = typeof state.nonce === "string" && /^[a-f0-9-]{36}$/.test(state.nonce) ? `\nJob nonce: ${state.nonce}` : "";
  return line + nonce + "\nBackend result only; publication and descendant termination remain unverified.";
}
