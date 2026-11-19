import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { displayLiteral } from "./presentation.ts";

export type ToolDisplay = { heading: string; lines?: string[]; ink?: "muted" | "success" | "warning" | "error" };
// Escape data before applying theme colors. This also protects resumed results.
export const literal = (value: unknown) => displayLiteral(String(value));

/** Presentation only: never enrich, persist or mutate a tool's evidence. */
export function toolPresentation(title: string, describe: (data: any, expanded: boolean) => ToolDisplay): ToolRenderers {
  return {
    renderShell: "default",
    renderCall(_args, theme) {
      return new Text(theme.fg("muted", title), 0, 0);
    },
    renderResult(reply, options, theme, context) {
      const raw = reply.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      let display: ToolDisplay;
      if (context.isError) display = { heading: `${title} · Failed`, ink: "warning", lines: [displayLiteral(raw)] };
      else if (options.isPartial) display = { heading: `${title} · Working…` };
      else {
        try { display = describe(JSON.parse(raw), options.expanded); }
        catch { display = { heading: `${title} · Display unavailable`, ink: "warning", lines: [displayLiteral(raw)] }; }
      }
      return new Text(theme.fg(display.ink ?? "muted", options.expanded ? "▾ " : "▸ ")
        + theme.bold(theme.fg("toolTitle", display.heading))
        + (display.lines?.length ? `\n${theme.fg("muted", display.lines.join("\n"))}` : ""), 0, 0);
    },
  };
}
