import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { randomUUID, createHash } from "node:crypto";
import type { Task } from "./backend.ts";

export const ENTRY = "pi-repo.pueue.job.v1";
export const NOTICE = "pi-repo.pueue.notice.v1";
export const RECEIPT = "pi-repo.pueue.receipt.v1";
export type Owner = { session: string; file: string; anchor: string | null };
export type Job = Owner & {
  namespace: string; nonce: string; label: string; id?: number; created?: string;
  admitted?: boolean; cancellationRequested?: boolean;
};
export function intent(owner: Owner, namespace: string): Job {
  const nonce = randomUUID();
  return { ...owner, namespace, nonce, label: `pi:${namespace}:${nonce}` };
}
/** Stable across reload/tree navigation, distinct for forks and session-file copies.
 * No paths, prompts or caller-controlled group names reach the backend. */
export function sessionGroup(namespace: string, owner: Owner): string {
  const key = JSON.stringify([owner.session, owner.file]);
  return `pi-session-${namespace}-${createHash("sha256").update(key).digest("hex")}`;
}
export function reservation(namespace: string, key: string): string {
  if (!key || key.length > 1024) throw new Error("Invalid reservation key");
  return `pi-${namespace}-${createHash("sha256").update(key).digest("hex")}`;
}
export function jobs(entries: readonly SessionEntry[], owner: Owner, namespace: string): Job[] {
  const result = new Map<string, Job>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const j = entry.data as Job | undefined;
    if (!j || j.session !== owner.session || j.file !== owner.file || j.namespace !== namespace
      || !/^[a-f0-9-]{36}$/.test(j.nonce) || j.label !== `pi:${namespace}:${j.nonce}`
      || (j.id !== undefined && (!Number.isSafeInteger(j.id) || j.id < 0))
      || (j.created !== undefined && (typeof j.created !== "string" || !Number.isFinite(Date.parse(j.created))))) continue;
    result.set(j.nonce, j);
  }
  return [...result.values()];
}
export function matching(job: Job, tasks: Task[]): Task | undefined {
  const matches = tasks.filter(t => t.label === job.label && (job.id === undefined || t.id === job.id)
    && (job.created === undefined || t.created === job.created));
  return matches.length === 1 ? matches[0] : undefined;
}
export function view(job: Job, tasks: Task[]) {
  const task = matching(job, tasks);
  return {
    nonce: job.nonce, id: job.id ?? task?.id,
    phase: !job.admitted ? "ADMISSION_UNKNOWN" : task?.phase ?? "UNKNOWN",
    ...(task?.exitCode === undefined || !job.admitted ? {} : { exitCode: task.exitCode }),
    ...(job.cancellationRequested ? { cancellationRequested: true as const } : {}),
  };
}
export type JobView = ReturnType<typeof view>;
/** A successful complete snapshot defines the current list, not historical intent.
 * Absence says nothing about completion, descendants, publication or retry safety. */
export function trackedViews(owned: readonly Job[], tasks: Task[]): JobView[] {
  return owned.filter(job => matching(job, tasks)).map(job => view(job, tasks));
}
export type StatusFilter = { nonce?: string; state?: "all" | "active" | "finished" };
/** UNKNOWN is unresolved, not finished; active filters must retain uncertainty. */
export function filterViews(rows: JobView[], filter: StatusFilter, owned: readonly { nonce: string }[] = rows): JobView[] {
  if (filter.nonce && !owned.some(row => row.nonce === filter.nonce)) throw new Error("Nonce not owned by this session branch");
  return rows.filter(row => (!filter.nonce || row.nonce === filter.nonce)
    && (filter.state === "active" ? row.phase !== "EXITED" : filter.state === "finished" ? row.phase === "EXITED" : true));
}
function noticeKey(e: SessionEntry): string | undefined {
  const data = e.type === "custom_message" && e.customType === NOTICE ? e.details
    : e.type === "custom" && e.customType === RECEIPT ? e.data : undefined;
  const key = (data as { key?: unknown } | undefined)?.key;
  return typeof key === "string" ? key : undefined;
}
export function noticed(entries: readonly SessionEntry[], key: string): boolean {
  return entries.some(e => noticeKey(e) === key);
}
/** Later cancellation intent/result changes can inform, but must not pay to wake twice. */
export function completionNoticed(entries: readonly SessionEntry[], nonce: string): boolean {
  return entries.some(e => noticeKey(e)?.startsWith(`${nonce}:EXITED:`));
}
