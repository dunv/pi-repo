// Linux cgroup-v2 evidence for cooperating delegated workers. No PID-only or
// backend KILLED inference, no signalling, cgroup mutation or automatic cleanup.
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { attemptDirectory, json, save } from './core.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const root = '/sys/fs/cgroup';
const boot = '/proc/sys/kernel/random/boot_id';
const io = { readFile, lstat, realpath };
export function scopeName(task, attempt) {
  if (!uuid.test(task) || (attempt !== undefined && !uuid.test(attempt))) throw new Error('Full task/attempt UUID required');
  return `pi-delegate-${task}-${attempt ?? 'initial'}.scope`;
}
function validPath(path, scope) {
  return typeof path === 'string' && isAbsolute(path) && !path.split('/').some(p => p === '.' || p === '..')
    && path.startsWith(`/user.slice/user-${process.getuid()}.slice/`)
    && path.endsWith('/' + scope);
}
async function current(fs) {
  const rows = (await fs.readFile('/proc/self/cgroup', 'utf8')).trim().split('\n');
  if (rows.length !== 1 || !rows[0].startsWith('0::')) throw new Error('Recovery requires unified cgroup v2');
  return rows[0].slice(3);
}
export async function recordContainment(task, attempt, fs = io) {
  const scope = scopeName(task.id, attempt), cgroup = await current(fs);
  if (!validPath(cgroup, scope)) throw new Error('Worker is not in its dedicated attempt scope');
  const path = root + cgroup;
  if (await fs.realpath(path) !== path) throw new Error('Unexpected cgroup path');
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid cgroup directory');
  const bootId = (await fs.readFile(boot, 'utf8')).trim();
  if (!uuid.test(bootId)) throw new Error('Boot identity unavailable');
  const evidence = { version: 1, task: task.id, attempt: attempt ?? null, scope, cgroup,
    bootId, inode: stat.ino, device: stat.dev, recordedAt: new Date().toISOString() };
  await save(join(attemptDirectory(task, attempt), 'containment.json'), evidence);
  return evidence;
}
async function evidenceFor(task, attempt) {
  let evidence;
  try { evidence = await json(join(attemptDirectory(task, attempt), 'containment.json')); }
  catch { throw new Error('No trusted attempt containment evidence; legacy/unrecorded workers cannot be resumed safely'); }
  if (evidence.version !== 1 || evidence.task !== task.id || evidence.attempt !== (attempt ?? null)
    || evidence.scope !== scopeName(task.id, attempt) || !validPath(evidence.cgroup, evidence.scope)
    || !uuid.test(evidence.bootId) || !Number.isSafeInteger(evidence.inode) || !Number.isSafeInteger(evidence.device)) {
    throw new Error('Attempt containment identity mismatch');
  }
  return evidence;
}
export async function assertContained(task, attempt, fs = io) {
  const evidence = await evidenceFor(task, attempt);
  if (await current(fs) !== evidence.cgroup || (await fs.readFile(boot, 'utf8')).trim() !== evidence.bootId) {
    throw new Error('Worker containment changed');
  }
  const stat = await fs.lstat(root + evidence.cgroup);
  if (stat.ino !== evidence.inode || stat.dev !== evidence.device) throw new Error('Worker cgroup was replaced');
}
export async function assertStopped(task, attempt = task.attempt, fs = io) {
  const evidence = await evidenceFor(task, attempt);
  if ((await fs.readFile(boot, 'utf8')).trim() !== evidence.bootId) throw new Error('Boot changed; previous containment evidence needs operator investigation');
  const path = root + evidence.cgroup;
  try {
    if (await fs.realpath(path) !== path) throw new Error('Unexpected cgroup path');
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== evidence.inode || stat.dev !== evidence.device) {
      throw new Error('Previous attempt cgroup was replaced');
    }
    // populated includes the entire subtree, including double-forked/setsid
    // descendants. An empty cgroup.procs alone would miss nested cgroups.
    const events = await fs.readFile(join(path, 'cgroup.events'), 'utf8');
    if (!/^populated 0$/m.test(events) || /^populated 1$/m.test(events)) throw new Error('Old worker or descendants are still present, or liveness is uncertain');
    return { ...evidence, stopped: true, observed: 'empty-cgroup', checkedAt: new Date().toISOString() };
  } catch (error) {
    // Linux cannot remove a populated cgroup. Missing is proof only because a
    // trusted, exclusive startup record binds this exact scope on this boot.
    if (error.code !== 'ENOENT') throw error;
    // Only the cgroup directory's absence counts, not a missing events file.
    try { await fs.lstat(path); } catch (missing) {
      if (missing.code === 'ENOENT') return { ...evidence, stopped: true, observed: 'removed-cgroup', checkedAt: new Date().toISOString() };
      throw missing;
    }
    throw new Error('Previous cgroup liveness evidence is unavailable');
  }
}
