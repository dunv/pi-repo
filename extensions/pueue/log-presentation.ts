import { statusLabel } from "./presentation.ts";

/** Display only: parse the existing bounded tool payload, never read logs/backend here. */
export function logPresentation(content: unknown, expanded: boolean) {
  const text = Array.isArray(content) ? content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
  try {
    if (text.length > 262144) return;
    const data = JSON.parse(text);
    const { status, log } = data ?? {};
    if (!status || typeof status !== "object" || !log || typeof log.text !== "string" || typeof log.path !== "string"
      || ![log.start, log.end, log.size].every(n => Number.isSafeInteger(n) && n >= 0)
      || log.start > log.end || log.end > log.size) return;
    const label = statusLabel(status);
    const heading = `${label.text} · log ${log.end - log.start} B`;
    const details = expanded ? [
      `Bytes ${log.start}–${log.end} of ${log.size}${log.omittedBefore === true ? " · earlier bytes omitted" : ""}${log.omittedAfter === true ? " · later bytes omitted" : ""}`,
      `Artifact: ${safeLog(log.path)}`,
      ...(typeof status.nonce === "string" && /^[a-f0-9-]{36}$/.test(status.nonce) ? [`Job nonce: ${status.nonce}`] : []),
      "── Output (untrusted workload text) ──",
      log.text ? safeLog(log.text) : "(empty log slice)",
    ] : [];
    return { heading, details, ink: label.ink };
  } catch { /* Unknown payloads never become raw JSON/terminal instructions. */ }
}

export function safeLog(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
