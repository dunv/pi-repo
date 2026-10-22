import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

export const TARGET_ENTRY = "worktree-panel-target";

export type PanelTarget = { path: string; branch?: string };

/** Read only the active session branch; null resets override any older target. */
export function restorePanelTarget(entries: readonly SessionEntry[]): PanelTarget | undefined {
  let target: PanelTarget | undefined;
  for (const entry of entries) {
    let data: unknown;
    if (entry.type === "custom" && entry.customType === TARGET_ENTRY) data = entry.data;
    // Compatibility: earlier versions recorded the target only in tool results.
    else if (entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "worktree_panel_target" && !entry.message.isError) data = entry.message.details;
    else continue;
    if (!data || typeof data !== "object" || !("path" in data)) continue;
    const path = data.path;
    if (path === null) target = undefined;
    else if (typeof path === "string" && isAbsolute(path)) {
      const branch = "branch" in data && typeof data.branch === "string" ? data.branch : undefined;
      target = { path, ...(branch ? { branch } : {}) };
    }
  }
  return target;
}

/** Legacy path-only accessor. */
export function restoreTarget(entries: readonly SessionEntry[]): string | undefined {
  return restorePanelTarget(entries)?.path;
}
