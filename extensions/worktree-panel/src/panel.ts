import type { Theme } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { display, type Snapshot, type ChangedFile, type DiffSource } from "./core.ts";
import { matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import { darkSurface, type SurfaceTone } from "./surface.ts";

export type Layout = {
  truncate(text: string, width: number): string;
  measure(text: string): number;
};

export type PanelActions = {
  diff(root: string, file: ChangedFile, source: DiffSource): void;
  edit(root: string, file: ChangedFile): void;
  close(): void;
  render(): void;
};
type Section = { title: string; files: ChangedFile[]; source?: DiffSource; error?: string };

// No Git, timers or model calls here. Both areas remain visible while paging.
export class WorktreePanel {
  active = false;
  private selected = 0;
  private actions?: PanelActions;
  private data: Snapshot;
  private preview: boolean;
  private theme: Theme;
  private layout: Layout;
  private rows: () => number;
  private pages = [0, 0];
  private sizes = [1, 1];
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
  private sections(): Section[] {
    const committed = this.data.committed;
    return [
      { title: `Committed vs ${committed?.ref ?? "develop"}`, files: committed?.files ?? [],
        source: committed?.source, error: committed?.error },
      { title: "Uncommitted", files: this.data.files, source: { kind: "uncommitted" } },
    ];
  }
  private entries() {
    return this.sections().flatMap((section, group) => section.files.map(file => ({ file, source: section.source, group })));
  }
  update(data: Snapshot, preview: boolean) {
    const before = this.entries()[this.selected];
    this.data = data;
    const entries = this.entries();
    const index = entries.findIndex(entry => entry.group === before?.group && entry.file.path === before.file.path);
    this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selected, entries.length - 1));
    this.preview = preview;
    this.invalidate();
  }
  movePage(direction: number) {
    const sections = this.sections();
    const selected = this.entries()[this.selected];
    sections.forEach((section, group) => {
      if (this.active && selected && selected.group !== group) return;
      const pages = Math.max(1, Math.ceil(section.files.length / this.sizes[group]));
      this.pages[group] = Math.max(0, Math.min(pages - 1, this.pages[group] + direction));
      if (this.active && selected?.group === group) {
        this.selected = (group ? sections[0].files.length : 0) + this.pages[group] * this.sizes[group];
      }
    });
    this.invalidate();
  }
  setActive(active: boolean) { this.active = active; this.invalidate(); }
  handleInput(data: string) {
    if (!this.active || !this.actions) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "alt+w") || data === "q") {
      this.actions.close(); return;
    }
    const entries = this.entries();
    const entry = entries[this.selected];
    if (matchesKey(data, "return")) {
      if (entry?.source) this.actions.diff(this.data.root, entry.file, entry.source);
      return;
    }
    if (data === "e") { if (entry) this.actions.edit(this.data.root, entry.file); return; }
    const pageSize = this.sizes[entry?.group ?? 0];
    if (matchesKey(data, "up") || data === "k") this.selected--;
    else if (matchesKey(data, "down") || data === "j") this.selected++;
    else if (matchesKey(data, "pageUp")) this.selected -= pageSize;
    else if (matchesKey(data, "pageDown")) this.selected += pageSize;
    else if (matchesKey(data, "home")) this.selected = 0;
    else if (matchesKey(data, "end")) this.selected = entries.length - 1;
    else if (matchesKey(data, "tab")) {
      const count = this.sections()[0].files.length;
      this.selected = entry?.group === 0 && this.data.files.length ? count : 0;
    } else return;
    this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
    this.invalidate();
    this.actions.render();
  }
  invalidate() { this.cacheKey = ""; }

  render(width: number): string[] {
    const height = Math.max(8, this.rows());
    const compact = height < 12;
    const inner = Math.max(1, width - 4);
    const sections = this.sections();
    // Collapse metadata on short terminals, keeping both areas and controls.
    const slots = height - (compact ? 6 : 8);
    const counts = sections.map(section => Math.max(1, section.files.length));
    this.sizes[0] = Math.min(counts[0], Math.max(1, Math.floor(slots / 2)));
    this.sizes[1] = Math.min(counts[1], slots - this.sizes[0]);
    let left = slots - this.sizes[0] - this.sizes[1];
    for (let group = 0; group < 2; group++) {
      const extra = Math.min(left, counts[group] - this.sizes[group]);
      this.sizes[group] += extra;
      left -= extra;
    }
    const selected = this.entries()[this.selected];
    sections.forEach((section, group) => {
      const count = Math.max(1, Math.ceil(section.files.length / this.sizes[group]));
      this.pages[group] = Math.min(this.pages[group], count - 1);
      if (this.active && selected?.group === group) {
        const offset = group ? sections[0].files.length : 0;
        this.pages[group] = Math.floor((this.selected - offset) / this.sizes[group]);
      }
    });
    const key = `${width}:${height}:${this.pages}:${this.active}:${this.selected}`;
    if (key === this.cacheKey) return this.cached;
    const surface = darkSurface(this.theme);
    const pad = (text: string) => {
      const short = this.layout.truncate(text, inner);
      return short + " ".repeat(Math.max(0, inner - this.layout.measure(short)));
    };
    const border = (text: string) => surface.fg(this.active ? "borderAccent" : "border", text);
    const line = (text: string, tone: SurfaceTone = "body") => surface.fill(border("│ ") + pad(text) + border(" │"), tone);
    const frame = (left: string, right: string) => surface.fill(border(left + "─".repeat(Math.max(1, width - 2)) + right));
    const title = `${this.preview ? "[preview] " : ""}Worktree · ${display(basename(this.data.root))}${compact ? ` · ${display(this.data.branch)}` : ""}`;
    const result = [frame("╭", "╮"), line(surface.fg("accent", title, true), "header")];
    if (!compact) {
      const path = display(this.data.root);
      const pathWidth = this.layout.measure(path);
      const shortPath = pathWidth > inner
        ? "…" + sliceByColumn(path, pathWidth - (inner - 1), inner - 1, true)
        : path;
      result.push(line(surface.fg("text", display(this.data.branch))), line(surface.fg("dim", shortPath)));
    }
    sections.forEach((section, group) => {
      const start = this.pages[group] * this.sizes[group];
      const end = Math.min(section.files.length, start + this.sizes[group]);
      const count = section.files.length > this.sizes[group] ? `${start + 1}–${end}/${section.files.length}` : String(section.files.length);
      result.push(line(surface.fg("accent", `── ${display(section.title)} · ${section.error ? "unavailable" : count}`), "header"));
      if (section.error) result.push(line(surface.fg("warning", display(section.error))));
      else if (!section.files.length) result.push(line(surface.fg("success", group ? "✓ Clean" : "No committed changes")));
      for (const file of section.files.slice(start, end)) {
        const conflict = /U/.test(file.status) || file.status === "AA" || file.status === "DD";
        const color = conflict ? "error" : file.status === "??" ? "muted" : "text";
        const marked = this.active && selected?.group === group && selected.file === file;
        result.push(line(surface.fg(marked ? "accent" : color, `${marked ? "› " : this.active ? "  " : ""}${file.status} ${display(file.path)}`), marked ? "selected" : "body"));
      }
    });
    result.push(line(surface.fg("dim", this.active ? "↑↓/Tab select · Enter diff · e edit · Alt+W/Esc back" : "Alt+W focus · /worktree-panel hide"), "header"), frame("╰", "╯"));
    this.cacheKey = key;
    this.cached = result;
    return result;
  }
}
