// Disposable workspaces: inspect/use the result, then remove it. No archive,
// custody transfer, enrollment, expiry policy or historical terminal evidence.
import { constants } from 'node:fs';
import { open, readFile, readdir, lstat, realpath, unlink, rmdir } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { Backend, configuration } from '../pueue/backend.ts';
import { privateJSON, git, digest, writeTask } from './core.mjs';
import { assertStopped } from './containment.mjs';
import { repositoryIdentity, assertNoPayloadMounts } from './repository.mjs';
import { withTaskLock } from './lock.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (path, root) => path === root || path.startsWith(root + '/');
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function directory(path, privateMode = false) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || await realpath(path) !== path
    || (privateMode && st.mode & 0o077)) throw new Error('Canonical user-owned workspace directory required');
  return [st.dev, st.ino];
}
export function configuredObserver(env = process.env) {
  const config = configuration(env);
  if (!config) throw new Error('Current Pueue configuration unavailable');
  const backend = new Backend(config);
  return async id => { await backend.check(); return { namespace: config.namespace, tasks: await backend.tasks(id) }; };
}
export async function loadWorkspace(runtime, id, allowClosing = false) {
  if (runtime.disposableProtocol !== 1) throw new Error('Activate the disposable workspace runtime first');
  if (!uuid.test(id)) throw new Error('Full task UUID required');
  await directory(runtime.state, true);
  const root = join(runtime.state, id); await directory(root, true);
  const task = await privateJSON(join(root, 'task.json'));
  // Old immutable lifecycle records are not migrated or purged by installing a
  // new extension. Legacy files can still be inspected/reused in the foreground.
  if (task.version !== 2) throw new Error('Legacy task is not a disposable workspace; inspect/reuse its files directly. No records were changed');
  if (task.id !== id || task.directory !== root || !uuid.test(task.namespace)
    || !isAbsolute(task.repo ?? '') || task.branch !== `delegate/${id}`
    || dirname(task.worktree ?? '') !== task.repo + '.worktrees' || !basename(task.worktree).endsWith(id)
    || !task.repository?.main) throw new Error('Workspace manifest identity mismatch');
  if (!same(await repositoryIdentity(task.repository.main, runtime), task.repository)) throw new Error('Workspace repository changed');
  if (!allowClosing && task.closing) throw new Error('Workspace cleanup is in progress; inspect it or explicitly finish cleanup');
  return task;
}
async function attempts(task) {
  const rows = [{ attempt: undefined, directory: task.directory }], path = join(task.directory, 'revisions');
  if (await exists(path)) {
    await directory(path, true);
    const names = await readdir(path);
    if (names.length > 1000 || names.some(name => !uuid.test(name))) throw new Error('Unsupported attempt directory');
    for (const attempt of names) { const root = join(path, attempt); await directory(root, true); rows.push({ attempt, directory: root }); }
  }
  return rows;
}
export async function assertWorkspaceIdle(task, runtime, observe, stopped = assertStopped) {
  const snapshot = await observe(task.id);
  if (snapshot?.namespace !== task.namespace || !Array.isArray(snapshot.tasks)) throw new Error('Complete current task backend unavailable');
  const rows = await attempts(task), nonces = new Set();
  for (const row of rows) if (await exists(join(row.directory, 'submission.json'))) {
    const submitted = await privateJSON(join(row.directory, 'submission.json'));
    if (!uuid.test(submitted.nonce)) throw new Error('Invalid task submission');
    nonces.add(submitted.nonce);
  }
  for (const job of snapshot.tasks) {
    if ((job.references?.includes(task.id) || [...nonces].some(nonce => job.label === `pi:${task.namespace}:${nonce}`))
      && !['EXITED', 'KILLED'].includes(job.phase)) throw new Error(`A worker is running, queued or uncertain (Pueue #${job.id ?? '?'} ${job.phase}); leave its workspace alone`);
  }
  for (const row of rows) {
    if (await exists(join(row.directory, 'containment.json'))) await stopped({ ...task, attempt: row.attempt }, row.attempt);
    else if (!task.closing && await exists(join(row.directory, 'started.json'))) throw new Error('Started worker has no current stopped-scope evidence');
  }
  // This checks cooperating workers, not arbitrary foreground/build-server users.
  // The agent manual and exact removal confirmation require those users idle.
}
async function sourceStamp(task, runtime) {
  // Confirmation binds current source metadata, not an archive of its bytes.
  // Even a huge discarded file must remain removable without serializing a diff.
  const status = await git(runtime, task.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const names = new Set((await git(runtime, task.worktree, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '-z'])
    + await git(runtime, task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  const stamps = [];
  for (const name of [...names].sort()) {
    try {
      const st = await lstat(join(task.worktree, name));
      stamps.push([name, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs]);
    } catch (error) { if (error.code === 'ENOENT') stamps.push([name, 'deleted']); else throw error; }
  }
  return digest(JSON.stringify({ status, stamps }));
}
async function inspectTree(path, identity) {
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = await root.stat();
    if (!same([st.dev, st.ino], identity)) throw new Error('Workspace root replaced');
    const walk = async parent => {
      for (const name of await readdir(`/proc/self/fd/${parent.fd}`)) {
        const entry = `/proc/self/fd/${parent.fd}/${name}`, item = await lstat(entry);
        if (item.uid !== process.getuid() || item.dev !== st.dev) throw new Error('Foreign-owned or mounted workspace entry');
        if (item.isDirectory() && !item.isSymbolicLink()) {
          const fd = await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            const opened = await fd.stat();
            if (opened.dev !== item.dev || opened.ino !== item.ino) throw new Error('Workspace entry replaced');
            await walk(fd);
          } finally { await fd.close(); }
        } else if (!item.isFile() && !item.isSymbolicLink()) throw new Error('Unsupported workspace file type');
      }
    };
    await walk(root);
  } finally { await root.close(); }
}
export async function inspectWorkspace(runtime, id, observe, who, stopped) {
  const task = await loadWorkspace(runtime, id, true), rootIdentity = await directory(task.directory, true);
  await assertWorkspaceIdle(task, runtime, observe, stopped);
  const paths = [task.directory];
  let stamp = null, head = null, worktreeIdentity = null;
  const registrations = (await git(runtime, task.repository.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(block => block.split('\0'));
  const registered = registrations.filter(row => row[0] === `worktree ${task.worktree}`);
  if (await exists(task.worktree)) {
    worktreeIdentity = await directory(task.worktree);
    if (!same(await repositoryIdentity(task.worktree, runtime), task.repository) || registered.length !== 1
      || registered[0].some(row => /^(?:locked|prunable)(?: |$)/.test(row))) throw new Error('Workspace registration/repository changed or locked');
    if ((await git(runtime, task.worktree, ['symbolic-ref', '--short', 'HEAD'])).trim() !== task.branch) throw new Error('Workspace branch changed');
    head = (await git(runtime, task.worktree, ['rev-parse', 'HEAD'])).trim();
    stamp = await sourceStamp(task, runtime); paths.push(task.worktree);
  } else if (registered.length) throw new Error('Missing registered worktree needs Git inspection');
  const ref = (await git(runtime, task.repository.main, ['for-each-ref', '--format=%(objectname)', `refs/heads/${task.branch}`])).trim() || null;
  if (head && ref !== head) throw new Error('Workspace ref changed');
  if (registrations.some(row => row[0] !== `worktree ${task.worktree}` && row.includes(`branch refs/heads/${task.branch}`))) throw new Error('Workspace ref is checked out elsewhere');
  for (const file of [who?.file, task.owner?.file].filter(Boolean)) {
    const actual = await realpath(file).catch(error => { if (error.code === 'ENOENT') return file; throw error; });
    if (paths.some(path => inside(file, path) || inside(actual, path))) throw new Error('Main/originating session is inside cleanup scope; preserve it');
  }
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  for (const path of paths) assertNoPayloadMounts(path, [path], mountinfo);
  await inspectTree(task.directory, rootIdentity);
  if (worktreeIdentity) await inspectTree(task.worktree, worktreeIdentity);
  return { task, paths, rootIdentity, sourceStamp: stamp, head, ref,
    identity: digest(JSON.stringify({ task, rootIdentity, worktreeIdentity, stamp, head, ref })) };
}
// Delete only entries below held directory descriptors. Never traverse symlink
// targets or mount points; never remove the main/originating session directory.
async function removeTree(path, identity) {
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), st = await root.stat();
  try {
    if (!same([st.dev, st.ino], identity)) throw new Error('Workspace directory replaced before deletion');
    const remove = async (parent, name) => {
      const entry = `/proc/self/fd/${parent.fd}/${name}`, before = await lstat(entry);
      if (before.uid !== process.getuid() || before.dev !== st.dev) throw new Error('Foreign-owned or mounted workspace entry');
      if (before.isDirectory() && !before.isSymbolicLink()) {
        const fd = await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const opened = await fd.stat();
          if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Workspace entry replaced');
          // Bazel makes output directories read-only. Restore only owner access
          // on this validated, held directory; never chmod symlink targets/files.
          if ((opened.mode & 0o700) !== 0o700) await fd.chmod((opened.mode & 0o777) | 0o700);
          for (const child of await readdir(`/proc/self/fd/${fd.fd}`)) await remove(fd, child);
          const after = await lstat(entry);
          if (after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('Workspace directory replaced');
          await rmdir(entry);
        } finally { await fd.close(); }
      } else if (before.isFile() || before.isSymbolicLink()) await unlink(entry);
      else throw new Error('Unsupported workspace file type');
    };
    // Keep the small manifest until last: an interrupted cleanup can be inspected
    // and explicitly finished with the SAME operation, not a recovery protocol.
    for (const name of (await readdir(path)).filter(name => name !== 'task.json')) await remove(root, name);
    await remove(root, 'task.json');
    const after = await lstat(path);
    if (!same([after.dev, after.ino], identity)) throw new Error('Workspace root replaced');
    await rmdir(path);
  } finally { await root.close(); }
}
export async function cleanupWorkspace(runtime, input, who, observe, confirm, guard = () => {}, stopped) {
  if (!['used', 'discarded'].includes(input.disposition) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000) throw new Error('Used/discarded result and a short handoff summary required');
  return withTaskLock(runtime, input.task, false, async () => {
    const gate = await inspectWorkspace(runtime, input.task, observe, who, stopped); guard();
    if (!await confirm(gate)) throw new Error('Workspace cleanup not authorized');
    guard();
    const fresh = await inspectWorkspace(runtime, input.task, observe, who, stopped);
    if (fresh.identity !== gate.identity) throw new Error('Workspace changed during confirmation; inspect again');
    guard();
    // The current manifest is the only progress state. Keep it until last;
    // closing workspaces cannot launch workers or accept source writes.
    await writeTask({ ...gate.task, closing: true });
    if (gate.head) await git(runtime, gate.task.repository.main, ['worktree', 'remove', '--force', gate.task.worktree]);
    guard();
    const registrations = (await git(runtime, gate.task.repository.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
    if (registrations.includes(`branch refs/heads/${gate.task.branch}`)) throw new Error('Workspace ref is in use; task records remain');
    if (gate.ref) await git(runtime, gate.task.repository.main, ['update-ref', '-d', `refs/heads/${gate.task.branch}`, gate.ref]);
    guard();
    await removeTree(gate.task.directory, gate.rootIdentity);
    return { task: input.task, disposition: input.disposition, summary: input.summary,
      removed: gate.paths, branch: gate.task.branch, archived: false };
  });
}
