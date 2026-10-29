import { terminal, type JobView } from "./state.ts";

export const WIDGET = "pi-repo.pueue.jobs";

/** UI only: no commands, arguments, paths, logs or backend diagnostics. */
export function widgetLines(rows: JobView[], expanded: boolean, unavailable = false): string[] | undefined {
  const active = rows.filter(row => !terminal(row.phase));
  if (!active.length) return undefined;
  const counts = new Map<string, number>();
  for (const row of active) counts.set(row.phase, (counts.get(row.phase) ?? 0) + 1);
  const summary = [...counts].map(([phase, count]) => `${count} ${phase.toLowerCase().replaceAll("_", " ")}`).join(" · ");
  const lines = [`${expanded ? "▾" : "▸"} Pueue: ${summary}${unavailable ? " · status unavailable" : ""} · /pueue ${expanded ? "collapse" : "expand"}`];
  if (expanded) {
    for (const row of active.slice(0, 6)) {
      lines.push(`  ${row.id === undefined ? "pending" : `#${row.id}`} · ${row.phase}${row.cancellationRequested ? " · SIGTERM requested" : ""} · ${row.nonce.slice(0, 8)}`);
    }
    if (active.length > 6) lines.push(`  … ${active.length - 6} more active jobs`);
  }
  return lines;
}
