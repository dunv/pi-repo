// Read-only, local allocation/identity inventory. Never a deletion manifest.
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lifecycleJSON, git, runtimeFrom } from '../../../extensions/delegate/core.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
async function allocation(path, device, seen = new Set()) {
  const st = await lstat(path);
  if (st.dev !== device) throw new Error('Mounted data excluded; manual inventory required');
  const identity = `${st.dev}:${st.ino}`;
  if (seen.has(identity)) return 0;
  seen.add(identity);
  if (seen.size > 1000000) throw new Error('Inventory exceeds one million entries');
  let bytes = st.blocks * 512;
  if (st.isDirectory() && !st.isSymbolicLink()) {
    if (await realpath(path) !== path) throw new Error('Directory changed or intermediate symlink');
    for (const name of await readdir(path)) bytes += await allocation(join(path, name), device, seen);
  }
  return bytes;
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function inventory(runtime) {
  const root = runtime.state, st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || await realpath(root) !== root) throw new Error('Canonical private state directory required');
  const tasks = [], repositories = new Map();
  for (const id of (await readdir(root)).sort()) {
    if (!uuid.test(id)) continue; // Global lock/control files are not tasks.
    const row = { task: id, classification: 'unassessed', blockers: [], allocatedBytes: {}, receipts: {} };
    tasks.push(row);
    const directory = join(root, id);
    try {
      const ds = await lstat(directory);
      if (!ds.isDirectory() || ds.isSymbolicLink() || ds.uid !== process.getuid() || ds.mode & 0o077) throw new Error('Unsafe task directory');
      const task = await lifecycleJSON(join(directory, 'task.json'));
      if (task.id !== id || task.directory !== directory || task.branch !== `delegate/${id}`
        || !isAbsolute(task.repo) || !isAbsolute(task.worktree) || dirname(task.worktree) !== task.repo + '.worktrees'
        || !task.worktree.endsWith(id)) throw new Error('Task ownership/path identity incomplete');
      Object.assign(row, { repo: task.repo, worktree: task.worktree, branch: task.branch,
        owner: { session: task.owner?.session, file: task.owner?.file }, worktreeExists: await exists(task.worktree) });
      if (row.worktreeExists) {
        const ws = await lstat(task.worktree);
        if (!ws.isDirectory() || ws.isSymbolicLink() || await realpath(task.worktree) !== task.worktree) throw new Error('Worktree path changed');
        row.worktreeAllocatedBytes = await allocation(task.worktree, ws.dev);
      }
      for (const [name, path] of Object.entries({ finalized: 'finalized.json', reconciled: 'reconciliation.json', disposed: 'disposed.json', containment: 'containment.json', result: 'result.json', feedback: 'feedback' })) row.receipts[name] = await exists(join(directory, path));
      for (const name of await readdir(directory)) {
        const category = name === 'build-output' ? 'build' : name === 'bazel-output' ? 'legacyBuild' : name === 'finalization' ? 'archivesAndReceipts'
          : /(?:\.log|\.jsonl)$/.test(name) ? 'logsAndSessions' : name === 'revisions' ? 'revisions' : 'otherEvidence';
        row.allocatedBytes[category] = (row.allocatedBytes[category] ?? 0) + await allocation(join(directory, name), ds.dev);
      }
      if (!repositories.has(task.repo)) repositories.set(task.repo, (async () => {
        if (await realpath(task.repo) !== task.repo) throw new Error('Repository path unavailable/changed');
        return { worktrees: (await git(runtime, task.repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0'),
          refs: (await git(runtime, task.repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/delegate/'])).trim().split('\n') };
      })().catch(() => null));
      const registration = await repositories.get(task.repo);
      row.branchExists = registration ? registration.refs.includes(`refs/heads/${task.branch}`) : null;
      row.branchRegistered = registration ? registration.worktrees.includes(`branch refs/heads/${task.branch}`) : null;
      row.worktreeRegistered = registration ? registration.worktrees.includes(`worktree ${task.worktree}`) : null;
      if (!registration) row.blockers.push('Repository identity/registration unavailable');
      row.blockers.push('No live terminal/stopped-worker, current review or integration/discard assessment performed');
    } catch (error) { row.blockers.push(error.code ?? 'Invalid/incomplete local evidence; manual inspection required'); }
  }
  return { state: root, observedAt: new Date().toISOString(), tasks,
    accounting: 'Allocated blocks per category, deduplicated within each top-level artifact only; shared hardlinks, snapshots, open files and concurrent changes prevent treating this as reclaimable space.',
    instruction: 'Not a deletion manifest. Inspect live attempt identity/status, stopped proof, source/review and external foreground users separately. Never infer disposability from age, exit files or a merged ref.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('No positional arguments; use the existing PI_DELEGATE_RUNTIME');
  console.log(JSON.stringify(await inventory(await runtimeFrom(process.env.PI_DELEGATE_RUNTIME)), null, 2));
}
