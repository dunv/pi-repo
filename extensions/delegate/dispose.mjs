// Explicit payload disposal AFTER recoverable finalization. No task-root purge,
// claim release, age policy, backend mutation, or following external symlinks.
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, readlink, readFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, durableSave, git, lifecycleJSON as json } from './core.mjs';
import { finalizationAttempts, finalizationClaimPath } from './finalize.mjs';
import { assertCustody, reconciledStatus } from './reconcile.mjs';
import { assertStopped } from './containment.mjs';
import { repositoryIdentity, assertNoPayloadMounts } from './repository.mjs';
export { assertNoPayloadMounts } from './repository.mjs';

const choices = { 'build-output': ['build-output'], recovery: ['finalization/source.bundle', 'finalization/local-files.json'] };
const claimPath = task => join(task.directory, 'disposal-claim.json');
async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function canonicalDirectory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || await realpath(path) !== path) throw new Error('Disposal directory ownership/path changed');
  return st;
}
const stamp = st => [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeNs.toString(), st.ctimeNs.toString()];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Metadata binds disposable build state, not a claim that its contents were
// reviewed. Source/ignored bytes were separately bound at finalization. Never
// read build-file bodies or copy them into another disk-sized archive.
async function payloads(task, selections) {
  const files = [], root = await canonicalDirectory(task.directory); let inventoryBytes = 0;
  async function walk(rel) {
    if (files.length >= 250000) throw new Error('Disposal inventory exceeds 250000 entries; investigate manually');
    const path = join(task.directory, rel), st = await lstat(path, { bigint: true });
    if (st.uid !== BigInt(process.getuid()) || st.dev !== BigInt(root.dev)
      || !(st.isFile() || st.isDirectory() || st.isSymbolicLink())) throw new Error('Foreign owner, mount or unsupported disposal entry');
    const row = { path: rel, stamp: stamp(st).map(v => typeof v === 'bigint' ? v.toString() : v),
      kind: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
      allocatedBytes: Number(st.blocks * 512n), shared: st.nlink > 1n && !st.isDirectory() };
    if (st.isSymbolicLink()) row.target = await readlink(path);
    inventoryBytes += Buffer.byteLength(JSON.stringify(row));
    if (inventoryBytes > 64 * 1024 * 1024) throw new Error('Disposal inventory exceeds 64 MiB; investigate manually');
    files.push(row);
    if (st.isDirectory()) {
      if (await realpath(path) !== path) throw new Error('Disposal directory became a symlink');
      for (const name of (await readdir(path)).sort()) await walk(rel + '/' + name);
      const after = await lstat(path, { bigint: true });
      if (!equal(row.stamp, stamp(after).map(v => typeof v === 'bigint' ? v.toString() : v))) throw new Error('Build state changed during inventory');
    }
  }
  for (const selection of selections) for (const rel of choices[selection]) {
    await canonicalDirectory(join(task.directory, rel.split('/').slice(0, -1).join('/')));
    if (!await absent(join(task.directory, rel))) await walk(rel);
  }
  return files;
}
export async function disposalGate(task, input, runtime, context, ownClaim) {
  if (runtime.disposalProtocol !== 1 || runtime.finalizationProtocol !== 1 || runtime.containmentProtocol !== 1) throw new Error('Explicit scoped disposal runtime required');
  if (input.task !== task.id || input.expectedNonce !== task.nonce || !/^[a-f0-9]{64}$/.test(input.expectedFinalization)
    || (input.legacyRecovery !== undefined && typeof input.legacyRecovery !== 'boolean')
    || !Array.isArray(input.selections) || !input.selections.length || input.selections.length > 2
    || new Set(input.selections).size !== input.selections.length || input.selections.some(s => !Object.hasOwn(choices, s))) throw new Error('Exact task/finalization and explicit payload selections required');
  if (!await absent(claimPath(task)) && (!ownClaim || (await json(claimPath(task))).id !== ownClaim)) throw new Error('Disposal already claimed or interrupted; no automatic retry');
  await canonicalDirectory(runtime.state); await canonicalDirectory(task.directory);
  const receipt = await json(join(task.directory, 'finalized.json'));
  if (digest(JSON.stringify(receipt)) !== input.expectedFinalization || receipt.task !== task.id || receipt.nonce !== task.nonce
    || receipt.attempt !== (task.attempt ?? null) || receipt.directory !== join(task.directory, 'finalization')) throw new Error('Finalization receipt changed');
  const finalization = await json(finalizationClaimPath(task));
  const intent = await json(join(receipt.directory, 'intent.json'));
  const ready = await json(join(receipt.directory, 'ready.json'));
  if (finalization.finalization !== receipt.authorization?.id || finalization.previousNonce !== task.nonce
    || !equal(intent.authorization, receipt.authorization) || intent.task !== task.id
    || ready.archiveFingerprint !== receipt.authorization.archiveFingerprint) throw new Error('Incomplete/mismatched finalization; retain all payloads');
  const cleanup = context.cleanupVerify ? await context.cleanupVerify(task, receipt.authorization.id, ownClaim) : null;
  if (input.legacyRecovery === true && (runtime.legacyRecoveryDisposalProtocol !== 1 || !cleanup?.legacyRecovery
    || !equal(input.selections, ['recovery']))) throw new Error('Legacy recovery disposal requires the separately enabled cleanup-only gate');
  if (Boolean(cleanup?.legacyRecovery) !== (input.legacyRecovery === true)) throw new Error('Legacy disposal mode mismatch');
  if (!cleanup) await assertCustody(task, context.who, receipt.authorization.id);
  const attempts = await finalizationAttempts(task, runtime), proofs = [];
  const statuses = cleanup ? [cleanup.status] : task.reconciliationId
    ? [await reconciledStatus(task, runtime, context.who, context.observe, context.stopped ?? assertStopped, receipt.authorization.id, true)]
    : await context.statuses();
  if (!Array.isArray(statuses) || statuses.length !== attempts.length) throw new Error('Every retained attempt needs terminal evidence');
  for (const attempt of attempts) {
    const rows = statuses.filter(s => s.nonce === attempt.nonce);
    if (rows.length !== 1 || !((task.reconciliationId || cleanup)
      ? rows[0].phase === 'RECONCILED_EXITED' && rows[0].backendAuthority === false
      : ['EXITED', 'KILLED'].includes(rows[0].phase))
      || (rows[0].phase !== 'KILLED' && !Number.isSafeInteger(rows[0].exitCode))) throw new Error('Uncertain/live attempt; disposal blocked');
    proofs.push(await (context.stopped ?? assertStopped)({ ...task, attempt: attempt.attempt }, attempt.attempt));
  }
  if (!await absent(task.worktree)) throw new Error('Worktree still exists; disposal blocked');
  const repo = cleanup ? cleanup.repository.main : task.repo;
  await canonicalDirectory(repo);
  const repository = await repositoryIdentity(repo, runtime);
  if (receipt.repository && (!equal(repository, receipt.repository) || !equal(repository, receipt.authorization.repository)
    || !equal(repository, ready.repository))) throw new Error('Finalized repository identity changed');
  const worktrees = (await git(runtime, repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  if (worktrees.includes(`worktree ${task.worktree}`) || worktrees.includes(`branch refs/heads/${task.branch}`)
    || (await git(runtime, repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${task.branch}`])).trim()) throw new Error('Delegate worktree/ref exists again; investigate before disposal');
  assertNoPayloadMounts(task.directory, input.selections.flatMap(s => choices[s].map(rel => join(task.directory, rel))),
    await readFile('/proc/self/mountinfo', 'utf8'));
  const root = await canonicalDirectory(task.directory), rootIdentity = [root.dev, root.ino];
  const files = await payloads(task, input.selections);
  return { receipt, files, proofs, statuses, rootIdentity, repository, legacyRecovery: input.legacyRecovery === true, cleanupCaller: cleanup ? context.cleanupCaller : null, cleanupEvidence: cleanup?.evidence ?? null, inventory: digest(JSON.stringify([rootIdentity, files])),
    allocatedBytes: files.reduce((n, f) => n + f.allocatedBytes, 0) };
}
export function disposalAuthorization(task, input, gate) {
  return { id: randomUUID(), task: task.id, nonce: task.nonce, finalization: input.expectedFinalization,
    selections: input.selections, inventory: gate.inventory, repository: gate.repository,
    legacyRecovery: gate.legacyRecovery, repositoryBinding: gate.legacyRecovery ? 'operator-selected; historical identity unverified' : 'verified',
    cleanupCaller: gate.cleanupCaller, cleanupEvidence: gate.cleanupEvidence, confirmedAt: new Date().toISOString() };
}
// Use held directory descriptors through Linux /proc/self/fd so an intermediate
// directory swapped for a symlink cannot redirect traversal to an SDK/cache.
// This fences cooperating callers, not hostile same-user mutation; any observed
// change leaves a permanent claim and partial evidence, never an automatic retry.
async function removePayloads(task, files, guard, rootIdentity) {
  const root = await open(task.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let unlinkedAllocatedBytes = 0;
  const rows = new Map(files.map(row => [row.path, row]));
  async function remove(parent, name, rel) {
    guard();
    const path = `/proc/self/fd/${parent.fd}/${name}`, row = rows.get(rel);
    const st = await lstat(path, { bigint: true });
    if (!row || !equal(row.stamp, stamp(st).map(v => typeof v === 'bigint' ? v.toString() : v))) throw new Error('Payload changed during disposal; retain partial evidence');
    if (row.kind === 'directory') {
      const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const held = await fd.stat({ bigint: true });
        if (held.ino !== st.ino || held.dev !== st.dev) throw new Error('Disposal directory replaced');
        for (const child of (await readdir(`/proc/self/fd/${fd.fd}`)).sort()) await remove(fd, child, rel + '/' + child);
        await fd.sync();
        const after = await lstat(path, { bigint: true });
        if (after.ino !== st.ino || after.dev !== st.dev) throw new Error('Disposal directory moved');
        guard(); await rmdir(path);
      } finally { await fd.close(); }
    } else { guard(); await unlink(path); }
    unlinkedAllocatedBytes += row.shared ? 0 : row.allocatedBytes;
  }
  try {
    const st = await root.stat();
    if (!equal([st.dev, st.ino], rootIdentity)) throw new Error('Task directory replaced before disposal');
    for (const row of files.filter(row => !rows.has(row.path.slice(0, row.path.lastIndexOf('/'))))) {
      if (row.path.startsWith('finalization/')) {
        const parent = await open(`/proc/self/fd/${root.fd}/finalization`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await remove(parent, row.path.split('/')[1], row.path); await parent.sync(); } finally { await parent.close(); }
      } else await remove(root, row.path, row.path);
    }
    await root.sync();
  } finally { await root.close(); }
  return unlinkedAllocatedBytes;
}
export async function disposeTask(task, input, runtime, context, authorization, guard = () => {}) {
  const gate = await disposalGate(task, input, runtime, context);
  if (!authorization || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(authorization.id) || authorization.task !== task.id || authorization.nonce !== task.nonce
    || authorization.finalization !== input.expectedFinalization || !equal(authorization.selections, input.selections)
    || authorization.inventory !== gate.inventory || !equal(authorization.repository, gate.repository)
    || authorization.legacyRecovery !== gate.legacyRecovery
    || authorization.repositoryBinding !== (gate.legacyRecovery ? 'operator-selected; historical identity unverified' : 'verified')
    || authorization.cleanupEvidence !== gate.cleanupEvidence || !equal(authorization.cleanupCaller, gate.cleanupCaller) || !Number.isFinite(Date.parse(authorization.confirmedAt))) throw new Error('Fresh bound interactive disposal authorization required');
  guard();
  await durableSave(claimPath(task), { ...authorization, kind: 'permanent-payload-disposal', files: gate.files,
    stopped: gate.proofs, statuses: gate.statuses });
  const fresh = await disposalGate(task, input, runtime, context, authorization.id);
  if (fresh.inventory !== gate.inventory || !equal(fresh.repository, gate.repository)
    || fresh.cleanupEvidence !== gate.cleanupEvidence) throw new Error('Payload/repository/evidence changed after disposal claim; investigate manually');
  guard();
  const unlinkedAllocatedBytes = await removePayloads(task, gate.files, guard, gate.rootIdentity);
  guard();
  const root = await canonicalDirectory(task.directory);
  if (!equal([root.dev, root.ino], gate.rootIdentity)) throw new Error('Task directory moved during disposal; investigate partial outcome');
  const receipt = { version: 1, task: task.id, nonce: task.nonce, authorization, disposedAt: new Date().toISOString(),
    entriesRemoved: gate.files.length, unlinkedAllocatedBytes,
    accounting: 'Unlinked allocated blocks, excluding multiply-linked files; not a filesystem free-space guarantee. Open files, snapshots and concurrent writes may retain space.',
    retained: 'Identity/manifests, claims, finalization intent/ready/receipt, reconciliation, results, containment, feedback, checks, logs and sessions. No external symlink targets removed.' };
  await durableSave(join(task.directory, 'disposed.json'), receipt);
  return receipt;
}
