import type { Theme } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { display, type Snapshot, type ChangedFile } from "./core.ts";
import { matchesKey } from "@earendil-works/pi-tui";

export type Layout = {
  truncate(text: string, width: number): string;
  measure(text: string): number;
};

export type PanelActions = {
  diff(root: string, file: ChangedFile): void;
  edit(root: string, file: ChangedFile): void;
  close(): void;
  render(): void;
};

// No Git, timers or model calls here. The host owns focus and file actions.
export class WorktreePanel {
  active = false;
  private selected = 0;
  private actions?: PanelActions;
  private data: Snapshot;
  private preview: boolean;
  private theme: Theme;
  private layout: Layout;
  private rows: () => number;
  private page = 0;
  private pageSize = 1;
  private cacheKey = "";
  private cached: string[] = [];

  constructor(data: Snapshot, preview: boolean, theme: Theme, layout: Layout, rows: () => number, actions?: PanelActions) {
    this.actions = actions;
    this.data = data;
    this.preview = preview;
    this.theme = theme;
    this.layout = layout;
    this.rows = rows;
  }
  update(data: Snapshot, preview: boolean) {
    const path = this.data.files[this.selected]?.path;
    const index = data.files.findIndex(file => file.path === path);
    this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selected, data.files.length - 1));
    this.data = data;
    this.preview = preview;
    this.invalidate();
  }
  movePage(direction: number) {
    const pages = Math.max(1, Math.ceil(this.data.files.length / this.pageSize));
    this.page = Math.max(0, Math.min(pages - 1, this.page + direction));
    this.selected = this.page * this.pageSize;
    this.invalidate();
  }
  setActive(active: boolean) {
    this.active = active;
    this.invalidate();
  }
  handleInput(data: string) {
    if (!this.active || !this.actions) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.actions.close(); return;
    }
    const file = this.data.files[this.selected];
    if (matchesKey(data, "return")) { if (file) this.actions.diff(this.data.root, file); return; }
    if (data === "e") { if (file) this.actions.edit(this.data.root, file); return; }
    if (matchesKey(data, "up") || data === "k") this.selected--;
    else if (matchesKey(data, "down") || data === "j") this.selected++;
    else if (matchesKey(data, "pageUp")) this.selected -= this.pageSize;
    else if (matchesKey(data, "pageDown")) this.selected += this.pageSize;
    else if (matchesKey(data, "home")) this.selected = 0;
    else if (matchesKey(data, "end")) this.selected = this.data.files.length - 1;
    else return;
    this.selected = Math.max(0, Math.min(this.selected, this.data.files.length - 1));
    this.page = Math.floor(this.selected / this.pageSize);
    this.invalidate();
    this.actions.render();
  }
  invalidate() { this.cacheKey = ""; }

  render(width: number): string[] {
    const height = Math.max(9, this.rows());
    const inner = Math.max(1, width - 4);
    this.pageSize = Math.max(1, height - 9);
    const pages = Math.max(1, Math.ceil(this.data.files.length / this.pageSize));
    this.page = this.active ? Math.floor(this.selected / this.pageSize) : Math.min(this.page, pages - 1);
    const key = `${width}:${height}:${this.page}:${this.active}:${this.selected}`;
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
      const selected = this.active && file === this.data.files[this.selected];
      result.push(line(th.fg(selected ? "accent" : color, `${selected ? "› " : this.active ? "  " : ""}${file.status} ${display(file.path)}`)));
    }
    if (pages > 1) result.push(line(th.fg("dim", `${start + 1}–${Math.min(this.data.files.length, start + this.pageSize)} · /worktree-panel next|prev`)));
    result.push(line(th.fg("dim", this.active ? "↑↓ select · Enter diff · e edit · Esc back" : "/worktree-open · /worktree-panel hide")), frame("╰", "╯"));
    this.cacheKey = key;
    this.cached = result;
    return result;
  }
}
