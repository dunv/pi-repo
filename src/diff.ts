import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { display } from "./core.ts";
import { formatDiff, type DiffLine } from "./diff-format.ts";
import { darkSurface, type SurfaceTone } from "./surface.ts";

/** Read-only, focused interaction; the passive sidebar never owns input. */
export class DiffViewer {
  private offset = 0;
  private pageSize = 1;
  private width = 0;
  private wrapped: { text: string; tone: SurfaceTone }[] = [];
  private formatted?: DiffLine[];
  private title: string;
  private text: string;
  private path: string;
  private theme: Theme;
  private rows: () => number;
  private requestRender: () => void;
  private done: () => void;

  constructor(title: string, text: string, theme: Theme,
    rows: () => number, requestRender: () => void, done: () => void, path = title) {
    this.title = title;
    this.text = text;
    this.path = path;
    this.theme = theme;
    this.rows = rows;
    this.requestRender = requestRender;
    this.done = done;
  }

  invalidate() { this.width = 0; this.formatted = undefined; }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.done(); return; }
    if (matchesKey(data, "up") || data === "k") this.offset--;
    else if (matchesKey(data, "down") || data === "j") this.offset++;
    else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    else if (matchesKey(data, "pageDown") || data === " ") this.offset += this.pageSize;
    else if (matchesKey(data, "home") || data === "g") this.offset = 0;
    else if (matchesKey(data, "end") || data === "G") this.offset = this.wrapped.length;
    else return;
    this.clamp();
    this.requestRender();
  }

  private clamp() { this.offset = Math.max(0, Math.min(this.offset, this.wrapped.length - this.pageSize)); }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.pageSize = Math.max(1, this.rows() - 5);
    const surface = darkSurface(this.theme);
    if (this.width !== width) {
      this.formatted ??= formatDiff(this.text, this.path, this.theme);
      const maxLine = this.formatted.reduce((max, line) => Math.max(max, line.old ?? 0, line.next ?? 0), 0);
      const digits = Math.max(3, String(maxLine).length);
      this.wrapped = this.formatted.flatMap(line => {
        const code = line.kind === "added" || line.kind === "removed" || line.kind === "context";
        const tone: SurfaceTone = line.kind === "added" ? "added" : line.kind === "removed" ? "removed"
          : line.kind === "hunk" || /^(Staged|Unstaged|Untracked|Committed vs)/.test(line.text) ? "header" : "body";
        if (!code) {
          const ink = tone === "header" ? "accent" : "muted";
          return wrapTextWithAnsi(line.text, inner).map(text => ({ text: surface.fg(ink, text), tone }));
        }
        const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
        const ink = line.kind === "added" ? "success" : line.kind === "removed" ? "error" : "dim";
        const numbered = inner >= digits * 2 + 7;
        const gutterWidth = numbered ? digits * 2 + 4 : Math.min(2, Math.max(0, inner - 1));
        return wrapTextWithAnsi(line.text, Math.max(1, inner - gutterWidth)).map((part, index) => {
          const number = (value?: number) => String(index ? "" : value ?? "").padStart(digits);
          const gutter = numbered
            ? surface.fg("dim", `${number(line.old)} ${number(line.next)} `) + surface.fg(ink, `${sign} `)
            : surface.fg(ink, `${sign} `.slice(0, gutterWidth));
          return { text: gutter + part, tone };
        });
      });
      this.width = width;
    }
    this.clamp();
    const border = (text: string) => surface.fg("borderAccent", text);
    const row = (text: string, tone: SurfaceTone = "body") => {
      const short = truncateToWidth(text, inner);
      return surface.fill(border("│ ") + short + " ".repeat(Math.max(0, inner - visibleWidth(short))) + border(" │"), tone);
    };
    const frame = (left: string, right: string) => surface.fill(border(left + "─".repeat(Math.max(0, width - 2)) + right));
    return [frame("╭", "╮"), row(surface.fg("accent", `Diff · ${display(this.title)}`, true), "header"), frame("├", "┤"),
      ...this.wrapped.slice(this.offset, this.offset + this.pageSize).map(line => row(line.text, line.tone)),
      row(surface.fg("dim", `${this.offset + 1}–${Math.min(this.wrapped.length, this.offset + this.pageSize)}/${this.wrapped.length} · ↑↓ PgUp/PgDn · Esc/q close`), "header"), frame("╰", "╯")];
  }
}
