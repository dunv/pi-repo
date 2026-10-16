import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { display } from "./core.ts";
import { formatDiff, pairDiffLines, type DiffLine } from "./diff-format.ts";
import { darkSurface, type SurfaceTone } from "./surface.ts";

/** Read-only, focused interaction; the passive sidebar never owns input. */
export class DiffViewer {
  private offset = 0;
  private pageSize = 1;
  private width = 0;
  private layout: "auto" | "unified" | "split" = "auto";
  private split = false;
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
    if (data === "s") {
      this.layout = this.split ? "unified" : "split";
      this.width = 0;
      this.offset = 0;
      this.requestRender();
      return;
    }
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

  private splitRows(inner: number, digits: number): { text: string; tone: SurfaceTone }[] {
    const surface = darkSurface(this.theme);
    const leftWidth = Math.floor((inner - 3) / 2), rightWidth = inner - 3 - leftWidth;
    const cell = (line: DiffLine | undefined, width: number, side: "old" | "next") => {
      const tone: SurfaceTone = line?.kind === "added" ? "added" : line?.kind === "removed" ? "removed" : "body";
      if (!line) return [surface.fill(" ".repeat(width))];
      const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
      const ink = line.kind === "added" ? "success" : line.kind === "removed" ? "error" : "dim";
      return wrapTextWithAnsi(line.text, Math.max(1, width - digits - 3)).map((part, index) => {
        const number = String(index ? "" : line[side] ?? "").padStart(digits);
        const text = surface.fg("dim", `${number} `) + surface.fg(ink, `${sign} `) + part;
        return surface.fill(text + " ".repeat(Math.max(0, width - visibleWidth(text))), tone);
      });
    };
    return pairDiffLines(this.formatted!).flatMap(pair => {
      if (pair.full) {
        const tone: SurfaceTone = pair.full.kind === "hunk" || /^(Staged|Unstaged|Untracked|Committed vs)/.test(pair.full.text) ? "header" : "body";
        return wrapTextWithAnsi(pair.full.text, inner).map(text => ({ text: surface.fg(tone === "header" ? "accent" : "muted", text), tone }));
      }
      const left = cell(pair.left, leftWidth, "old"), right = cell(pair.right, rightWidth, "next");
      return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => ({
        text: (left[i] ?? surface.fill(" ".repeat(leftWidth))) + surface.fg("border", " │ ")
          + (right[i] ?? surface.fill(" ".repeat(rightWidth))),
        tone: "body" as const,
      }));
    });
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.pageSize = Math.max(1, this.rows() - 5);
    const surface = darkSurface(this.theme);
    if (this.width !== width) {
      this.formatted ??= formatDiff(this.text, this.path, this.theme);
      const maxLine = this.formatted.reduce((max, line) => Math.max(max, line.old ?? 0, line.next ?? 0), 0);
      const digits = Math.max(3, String(maxLine).length);
      // Keep at least 40 columns per side; an explicit split preference survives resizing.
      this.split = this.layout !== "unified" && inner >= 83;
      this.wrapped = this.split ? this.splitRows(inner, digits) : this.formatted.flatMap(line => {
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
    return [frame("╭", "╮"), row(surface.fg("accent", `Diff · ${display(this.title)} · ${this.split ? "Old │ New" : "Unified"}`, true), "header"), frame("├", "┤"),
      ...this.wrapped.slice(this.offset, this.offset + this.pageSize).map(line => row(line.text, line.tone)),
      row(surface.fg("dim", `${this.offset + 1}–${Math.min(this.wrapped.length, this.offset + this.pageSize)}/${this.wrapped.length} · ↑↓ PgUp/PgDn · s layout · Esc/q close`), "header"), frame("╰", "╯")];
  }
}
