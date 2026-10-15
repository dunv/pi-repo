import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { display } from "./core.ts";

/** Read-only, focused interaction; the passive sidebar never owns input. */
export class DiffViewer {
  private offset = 0;
  private pageSize = 1;
  private width = 0;
  private wrapped: string[] = [];
  private lines: string[];

  private title: string;
  private theme: Theme;
  private rows: () => number;
  private requestRender: () => void;
  private done: () => void;

  constructor(title: string, text: string, theme: Theme,
    rows: () => number, requestRender: () => void, done: () => void) {
    this.title = title;
    this.theme = theme;
    this.rows = rows;
    this.requestRender = requestRender;
    this.done = done;
    this.lines = text.trimEnd().split("\n").map(line => display(line.replace(/\t/g, "    ")));
  }

  invalidate() { this.width = 0; }

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
    const th = this.theme;
    if (this.width !== width) {
      this.wrapped = this.lines.flatMap(line => {
        const color = line.startsWith("+") ? "success" : line.startsWith("-") ? "error"
          : line.startsWith("@@") || /^(Staged|Unstaged|Untracked)$/.test(line) ? "accent" : "text";
        return wrapTextWithAnsi(line, inner).map(part => th.fg(color, part));
      });
      this.width = width;
    }
    this.clamp();
    const border = (text: string) => th.fg("border", text);
    const row = (text: string) => {
      const short = truncateToWidth(text, inner);
      return th.bg("customMessageBg", border("│ ") + short + " ".repeat(Math.max(0, inner - visibleWidth(short))) + border(" │"));
    };
    const frame = (left: string, right: string) => th.bg("customMessageBg", border(left + "─".repeat(Math.max(0, width - 2)) + right));
    return [frame("╭", "╮"), row(th.fg("accent", `Diff · ${display(this.title)}`)), frame("├", "┤"),
      ...this.wrapped.slice(this.offset, this.offset + this.pageSize).map(row),
      row(th.fg("dim", `${this.offset + 1}–${Math.min(this.wrapped.length, this.offset + this.pageSize)}/${this.wrapped.length} · ↑↓ PgUp/PgDn · Esc/q close`)), frame("╰", "╯")];
  }
}
