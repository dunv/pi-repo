import type { Theme } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { display, type Snapshot } from "./core.ts";

export type Layout = {
  truncate(text: string, width: number): string;
  measure(text: string): number;
};

// Layout only. No Git, timers, model calls, or terminal focus handling here.
export class WorktreePanel {
  private data: Snapshot;
  private preview: boolean;
  private theme: Theme;
  private layout: Layout;
  private rows: () => number;
  private page = 0;
  private pageSize = 1;
  private cacheKey = "";
  private cached: string[] = [];

  constructor(data: Snapshot, preview: boolean, theme: Theme, layout: Layout, rows: () => number) {
    this.data = data;
    this.preview = preview;
    this.theme = theme;
    this.layout = layout;
    this.rows = rows;
  }
  update(data: Snapshot, preview: boolean) {
    this.data = data;
    this.preview = preview;
    this.invalidate();
  }
  movePage(direction: number) {
    const pages = Math.max(1, Math.ceil(this.data.files.length / this.pageSize));
    this.page = Math.max(0, Math.min(pages - 1, this.page + direction));
    this.invalidate();
  }
  invalidate() { this.cacheKey = ""; }

  render(width: number): string[] {
    const height = Math.max(9, this.rows());
    const inner = Math.max(1, width - 4);
    this.pageSize = Math.max(1, height - 9);
    const pages = Math.max(1, Math.ceil(this.data.files.length / this.pageSize));
    this.page = Math.min(this.page, pages - 1);
    const key = `${width}:${height}:${this.page}`;
    if (key === this.cacheKey) return this.cached;
    const th = this.theme;
    const pad = (text: string) => {
      const short = this.layout.truncate(text, inner);
      return short + " ".repeat(Math.max(0, inner - this.layout.measure(short)));
    };
    const border = (text: string) => th.fg("border", text);
    const line = (text: string) => th.bg("customMessageBg", border("│ ") + pad(text) + border(" │"));
    const frame = (left: string, right: string) => th.bg("customMessageBg", border(left + "─".repeat(Math.max(1, width - 2)) + right));
    const result = [frame("╭", "╮"),
      line(th.fg("accent", `${this.preview ? "[preview] " : ""}Worktree · ${display(basename(this.data.root))}`)),
      line(th.fg("text", display(this.data.branch))),
      line(th.fg("dim", display(this.data.root))),
      frame("├", "┤"),
      line(th.fg(this.data.files.length ? "muted" : "success", this.data.files.length ? `${this.data.files.length} changed files` : "✓ Clean"))];
    const start = this.page * this.pageSize;
    for (const file of this.data.files.slice(start, start + this.pageSize)) {
      const conflict = /U/.test(file.status) || file.status === "AA" || file.status === "DD";
      const color = conflict ? "error" : file.status === "??" ? "muted" : "text";
      result.push(line(th.fg(color, `${file.status} ${display(file.path)}`)));
    }
    if (pages > 1) result.push(line(th.fg("dim", `${start + 1}–${Math.min(this.data.files.length, start + this.pageSize)} · /worktree-panel next|prev`)));
    result.push(line(th.fg("dim", "/worktree-open · /worktree-panel hide")), frame("╰", "╯"));
    this.cacheKey = key;
    this.cached = result;
    return result;
  }
}
