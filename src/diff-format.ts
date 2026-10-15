import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { display } from "./core.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readableSyntax } from "./surface.ts";

export type DiffLine = {
  kind: "meta" | "hunk" | "added" | "removed" | "context";
  text: string;
  old?: number;
  next?: number;
};

/** Highlight each hunk's old/new code separately, preserving multiline lexer state. */
export function formatDiff(text: string, path: string, theme: Theme,
  highlight = highlightCode): DiffLine[] {
  const lines = text.trimEnd().split("\n").map(line => display(line.replace(/\t/g, "    ")));
  const language = getLanguageFromPath(path) ?? (path.toLowerCase().endsWith(".nix") ? "nix" : undefined);
  const result: DiffLine[] = [];
  const syntax = (code: string[]) => {
    if (!language || !code.length || code.join("\n").length > 200_000) return code;
    const colored = highlight(code.join("\n"), language);
    // Host highlighting may span ANSI colors across literal newlines. Make each
    // line self-contained before old/new rows are interleaved in the diff.
    const normalized = wrapTextWithAnsi(colored.join("\n"), Number.MAX_SAFE_INTEGER);
    return normalized.length === code.length ? normalized.map(line => readableSyntax(line, theme)) : code;
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (!hunk) { result.push({ kind: "meta", text: line }); continue; }
    result.push({ kind: "hunk", text: line });
    let old = Number(hunk[1]), next = Number(hunk[2]);
    const body: DiffLine[] = [];
    while (i < lines.length && /^[ +\\-]/.test(lines[i])) {
      const raw = lines[i++];
      if (raw.startsWith("\\")) { body.push({ kind: "meta", text: raw }); continue; }
      const kind = raw[0] === "+" ? "added" : raw[0] === "-" ? "removed" : "context";
      body.push({ kind, text: raw.slice(1), old: kind === "added" ? undefined : old++,
        next: kind === "removed" ? undefined : next++ });
    }
    const before = syntax(body.filter(row => row.old !== undefined).map(row => row.text));
    const after = syntax(body.filter(row => row.next !== undefined).map(row => row.text));
    let left = 0, right = 0;
    for (const row of body) {
      if (row.old !== undefined) { if (row.kind === "removed") row.text = before[left]; left++; }
      if (row.next !== undefined) row.text = after[right++];
      result.push(row);
    }
  }
  return result;
}
