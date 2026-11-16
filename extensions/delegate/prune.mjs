// Later retained-artifact cleanup. This is deliberately separate from ordinary
// one-shot disposal and only accepts a fully completed, independently revalidated
// disposal history.
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, durableSave, lifecycleJSON } from './core.mjs';
import { cleanupTask, cleanupEvidence } from './cleanup.mjs';
import { disposalGate, inventoryPayloads, removePayloadInventory, assertNoPayloadMounts } from './dispose.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const groupNames = ['build-output', 'recovery', 'diagnostics'];
const groups = new Set(groupNames);
const diagnosticNames = new Set(['brief.md', 'report.md', 'worker.log', 'metrics.jsonl', 'tracked.diff', 'claude-result.json']);
const sessionName = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[a-f0-9-]{36}\.jsonl$/;
const checkLogName = /^check-[0-7]-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.log$/;
const protectedText = /(?:mailhub|unknown[ -]?outcome|approved[ -]?set|trash[ -]?journal|\bjournal\b)/i;
const authorizationFields = ['id', 'task', 'nonce', 'finalization', 'selections', 'inventory', 'repository', 'legacyRecovery',
  'repositoryBinding', 'cleanupCaller', 'cleanupEvidence', 'confirmedAt'];
const stamp = st => [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeNs.toString(), st.ctimeNs.toString()]
  .map(value => typeof value === 'bigint' ? value.toString() : value);

async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function bytesHash(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.mode & 0o077n || before.size > 128n * 1024n * 1024n) {
      throw new Error('Unsafe or oversized lifecycle hash input');
    }
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), linked = await lstat(path, { bigint: true });
    if (BigInt(bytes.length) !== before.size || !equal(stamp(before), stamp(after)) || !equal(stamp(before), stamp(linked))) {
      throw new Error('Lifecycle hash input changed during read');
    }
    return digest(bytes);
  } finally { await fd.close(); }
}
async function rootIdentity(task) {
  const st = await lstat(task.directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077
    || await realpath(task.directory) !== task.directory) throw new Error('Canonical private task directory required');
  return [st.dev, st.ino];
}
async function filesystem(path) {
  const value = await statfs(path, { bigint: true });
  return { availableBytes: (value.bavail * value.bsize).toString(), freeBytes: (value.bfree * value.bsize).toString(),
    blockSize: value.bsize.toString(), limitation: 'A point-in-time filesystem observation; concurrent activity, snapshots and open files prevent attributing changes to this operation.' };
}
function claimPath(task) { return join(task.directory, 'disposal-claim.json'); }
function disposedPath(task) { return join(task.directory, 'disposed.json'); }
function baseDigest(claimHash, receiptHash) { return digest(JSON.stringify({ disposalClaim: claimHash, disposed: receiptHash })); }
function retentionClaimPath(task, predecessor) { return join(task.directory, `retention-after-${predecessor}.json`); }
function retentionReceiptPath(task, id) { return join(task.directory, `retention-${id}.json`); }
function projectAuthorization(claim) { return Object.fromEntries(authorizationFields.map(key => [key, claim[key]])); }
function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value)
  && equal(Object.keys(value).sort(), [...keys].sort()); }
function claimDigest(claim) { return digest(JSON.stringify(claim)); }
function receiptHistory(receipt) { const { history, ...bound } = receipt; return digest(JSON.stringify(bound)); }

function validateDisposalAuthorization(auth, task) {
  if (!exactKeys(auth, authorizationFields) || !uuid.test(auth.id) || auth.task !== task.id || auth.nonce !== task.nonce
    || !hash.test(auth.finalization) || !hash.test(auth.inventory) || !Array.isArray(auth.selections) || !auth.selections.length
    || auth.selections.length > 2 || new Set(auth.selections).size !== auth.selections.length
    || auth.selections.some(value => !['build-output', 'recovery'].includes(value)) || !auth.repository
    || typeof auth.repository !== 'object' || typeof auth.repository.main !== 'string' || !isAbsolute(auth.repository.main)
    || auth.legacyRecovery !== false || auth.repositoryBinding !== 'verified'
    || !validTime(auth.confirmedAt)) throw new Error('Earlier disposal authorization is incomplete, legacy, or invalid');
}

// disposeTask writes authorization fields flat into the permanent claim, while
// disposed.json retains the same authorization nested. Older completed records
// use this same completed schema. No missing receipt or partial claim is upgraded.
async function originalDisposal(task) {
  const path = claimPath(task), receiptPath = disposedPath(task);
  if (await absent(path) || await absent(receiptPath)) throw new Error('Later retention cleanup requires a completed coherent earlier delegate_dispose');
  const claim = await lifecycleJSON(path), receipt = await lifecycleJSON(receiptPath);
  const auth = projectAuthorization(claim);
  validateDisposalAuthorization(auth, task);
  const commonClaimKeys = [...authorizationFields, 'kind', 'stopped', 'statuses'];
  const ordinaryKeys = [...commonClaimKeys, 'files'];
  const compactKeys = [...commonClaimKeys, 'compacted', 'originalByteSha256', 'originalInventoryDigest', 'inventoryEntries',
    'inventoryAllocatedBytes', 'originalClaimAllocatedBytes', 'compactionReceipt', 'perFileDetail'];
  if (claim.kind !== 'permanent-payload-disposal' || !Array.isArray(claim.stopped) || !claim.stopped.length
    || !Array.isArray(claim.statuses) || !claim.statuses.length || !exactKeys(claim, claim.compacted === true ? compactKeys : ordinaryKeys)) {
    throw new Error('Earlier disposal claim has an unknown or incomplete schema');
  }
  const receiptKeys = ['version', 'task', 'nonce', 'authorization', 'disposedAt', 'entriesRemoved', 'unlinkedAllocatedBytes', 'accounting', 'retained'];
  if (!exactKeys(receipt, receiptKeys) || receipt.version !== 1 || receipt.task !== task.id || receipt.nonce !== task.nonce
    || !equal(receipt.authorization, auth) || !validTime(receipt.disposedAt) || Date.parse(receipt.disposedAt) < Date.parse(auth.confirmedAt)
    || !Number.isSafeInteger(receipt.entriesRemoved) || receipt.entriesRemoved < 0
    || !Number.isSafeInteger(receipt.unlinkedAllocatedBytes) || receipt.unlinkedAllocatedBytes < 0
    || typeof receipt.accounting !== 'string' || !receipt.accounting.includes('not a filesystem free-space guarantee')
    || typeof receipt.retained !== 'string') throw new Error('Earlier disposal receipt is incomplete or mismatched');
  const finalizedHash = digest(JSON.stringify(task.finalized));
  if (auth.finalization !== finalizedHash || receipt.authorization.id !== claim.id) throw new Error('Earlier disposal finalization/identity binding changed');
  const receiptHash = await bytesHash(receiptPath);
  if (claim.compacted === true) {
    if (!hash.test(claim.originalByteSha256) || !hash.test(claim.originalInventoryDigest) || !uuid.test(claim.compactionReceipt)
      || !Number.isSafeInteger(claim.inventoryEntries) || claim.inventoryEntries !== receipt.entriesRemoved
      || !Number.isSafeInteger(claim.inventoryAllocatedBytes) || claim.inventoryAllocatedBytes < 0
      || !Number.isSafeInteger(claim.originalClaimAllocatedBytes) || claim.originalClaimAllocatedBytes < 0
      || claim.inventory !== claim.originalInventoryDigest || claim.perFileDetail !== 'removed; completion requires matching retention receipt') {
      throw new Error('Invalid compacted disposal tombstone');
    }
    const compact = await lifecycleJSON(retentionReceiptPath(task, claim.compactionReceipt));
    const compaction = compact.compaction;
    if (compact.kind !== 'retention-prune-receipt' || compact.operation !== claim.compactionReceipt || !compaction
      || compaction.kind !== 'retention-disposal-claim-compaction' || compaction.operation !== claim.compactionReceipt
      || compaction.originalByteSha256 !== claim.originalByteSha256 || compaction.tombstoneByteSha256 !== await bytesHash(path)
      || compaction.originalInventoryDigest !== claim.originalInventoryDigest || compaction.entries !== claim.inventoryEntries
      || compaction.inventoryAllocatedBytes !== claim.inventoryAllocatedBytes || compaction.originalClaimAllocatedBytes !== claim.originalClaimAllocatedBytes
      || compaction.authorizationId !== claim.id) throw new Error('Compacted disposal tombstone lacks a matching durable receipt');
    return { claim, authorization: auth, receipt, compacted: true, claimHash: claim.originalByteSha256,
      base: baseDigest(claim.originalByteSha256, receiptHash), receiptHash };
  }
  const claimHash = await bytesHash(path);
  const roots = auth.selections.flatMap(group => group === 'build-output' ? ['build-output'] : ['finalization/source.bundle', 'finalization/local-files.json']);
  if (!Array.isArray(claim.files) || claim.files.length > 250000 || receipt.entriesRemoved !== claim.files.length
    || claim.files.some(row => !row || typeof row.path !== 'string' || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || !roots.some(root => row.path === root || (root === 'build-output' && row.path.startsWith(root + '/')))
      || !Number.isSafeInteger(row.allocatedBytes) || row.allocatedBytes < 0 || typeof row.shared !== 'boolean'
      || !['file', 'directory', 'symlink'].includes(row.kind) || !Array.isArray(row.stamp) || row.stamp.length !== 8)
    || new Set(claim.files.map(row => row.path)).size !== claim.files.length
    || claim.inventory !== digest(JSON.stringify([await rootIdentity(task), claim.files]))
    || receipt.unlinkedAllocatedBytes !== claim.files.reduce((total, row) => total + (row.shared ? 0 : row.allocatedBytes), 0)) {
    throw new Error('Invalid completed disposal claim inventory');
  }
  return { claim, authorization: auth, receipt, compacted: false, claimHash,
    base: baseDigest(claimHash, receiptHash), receiptHash };
}

function validateRetentionClaim(row, predecessor, task) {
  const base = ['id', 'task', 'nonce', 'finalization', 'predecessor', 'inventory', 'selections', 'evidence', 'confirmation', 'mode', 'caller', 'confirmedAt', 'kind', 'files'];
  if (!exactKeys(row, base) || row.kind !== 'retention-prune' || !uuid.test(row.id) || row.predecessor !== predecessor
    || row.task !== task.id || row.nonce !== task.nonce || row.finalization !== digest(JSON.stringify(task.finalized)) || !hash.test(row.inventory)
    || !hash.test(row.evidence) || !hash.test(row.confirmation) || !['payload', 'compaction'].includes(row.mode) || !validTime(row.confirmedAt)
    || typeof row.caller?.session !== 'string' || !row.caller.session || typeof row.caller?.file !== 'string' || !isAbsolute(row.caller.file)
    || !Array.isArray(row.selections) || row.selections.length > 3 || new Set(row.selections).size !== row.selections.length
    || row.selections.some(group => !groups.has(group)) || !Array.isArray(row.files) || row.files.length > 250000
    || row.files.some(file => !file || typeof file.path !== 'string' || file.path.length > 4096 || !Number.isSafeInteger(file.allocatedBytes) || file.allocatedBytes < 0)
    || (row.mode === 'compaction' ? row.selections.length || row.files.length !== 1 || row.files[0].path !== 'disposal-claim.json' : !row.selections.length)) throw new Error('Invalid retention claim');
}
function validateReceipt(receipt, claim, predecessor) {
  const keys = ['kind', 'version', 'operation', 'task', 'nonce', 'finalization', 'predecessor', 'claim', 'mode', 'selections',
    'inventory', 'history', 'removedGroups', 'retainedGroups', 'retainedGroupMeasurements', 'filesystemBefore', 'filesystemAfter', 'accounting', 'completedAt',
    ...(claim.mode === 'compaction' ? ['compaction'] : [])];
  if (!exactKeys(receipt, keys) || receipt.kind !== 'retention-prune-receipt' || receipt.version !== 1
    || receipt.operation !== claim.id || receipt.task !== claim.task || receipt.nonce !== claim.nonce
    || receipt.finalization !== claim.finalization || receipt.predecessor !== predecessor || receipt.claim !== claimDigest(claim)
    || receipt.mode !== claim.mode || !equal(receipt.selections, claim.selections) || !hash.test(receipt.history)
    || receipt.history !== receiptHistory(receipt)
    || !exactKeys(receipt.inventory, ['digest', 'entries', 'allocatedBytes', 'unlinkedAllocatedBytes', 'pathsDigest', 'durableRecordOverheadExcluded'])
    || receipt.inventory.digest !== claim.inventory || receipt.inventory.entries !== claim.files.length
    || receipt.inventory.allocatedBytes !== claim.files.reduce((total, row) => total + row.allocatedBytes, 0)
    || !Number.isSafeInteger(receipt.inventory.unlinkedAllocatedBytes) || receipt.inventory.unlinkedAllocatedBytes < 0
    || receipt.inventory.pathsDigest !== digest(JSON.stringify(claim.files.map(row => row.path))) || receipt.inventory.durableRecordOverheadExcluded !== true
    || !Array.isArray(receipt.removedGroups) || !equal(receipt.removedGroups, claim.selections)
    || !Array.isArray(receipt.retainedGroups) || receipt.retainedGroups.length > 3 || new Set(receipt.retainedGroups).size !== receipt.retainedGroups.length
    || receipt.retainedGroups.some(group => !groups.has(group) || receipt.removedGroups.includes(group))
    || !receipt.retainedGroupMeasurements || !equal(Object.keys(receipt.retainedGroupMeasurements).sort(), [...receipt.retainedGroups].sort())
    || Object.keys(receipt.retainedGroupMeasurements).some(group => !groups.has(group))
    || !receipt.retainedGroups.every(group => receipt.retainedGroupMeasurements[group]?.present === true
      && Number.isSafeInteger(receipt.retainedGroupMeasurements[group].entries)
      && Number.isSafeInteger(receipt.retainedGroupMeasurements[group].allocatedBytes)
      && hash.test(receipt.retainedGroupMeasurements[group].pathsDigest))
    || !receipt.filesystemBefore || !receipt.filesystemAfter || !validTime(receipt.completedAt)
    || Date.parse(receipt.completedAt) < Date.parse(claim.confirmedAt) || typeof receipt.accounting !== 'string') {
    throw new Error('Dangling or mismatched retention operation; no retry');
  }
}

// Retention records form one bounded append-only chain. Unknown retention names,
// duplicate operation IDs, cycles, disconnected receipts and dangling claims fail.
async function retentionHistory(task, base, ownClaim) {
  const names = await readdir(task.directory), claims = new Map(), receipts = new Map(), operationIds = new Set();
  for (const name of names) {
    if (!name.startsWith('retention-')) continue;
    if (name.startsWith('retention-after-')) {
      const predecessor = name.slice('retention-after-'.length, -5);
      if (!name.endsWith('.json') || !hash.test(predecessor) || name !== `retention-after-${predecessor}.json` || claims.has(predecessor)) throw new Error('Unrecognized or duplicate retention claim record');
      const row = await lifecycleJSON(join(task.directory, name)); validateRetentionClaim(row, predecessor, task);
      if (operationIds.has(row.id)) throw new Error('Duplicate retention operation id');
      operationIds.add(row.id); claims.set(predecessor, row);
    } else {
      const id = name.endsWith('.json') ? name.slice('retention-'.length, -5) : '';
      if (!uuid.test(id) || name !== `retention-${id}.json` || receipts.has(id)) throw new Error('Unrecognized or duplicate retention receipt record');
      const row = await lifecycleJSON(join(task.directory, name));
      if (row.operation !== id) throw new Error('Invalid retention receipt identity');
      receipts.set(id, row);
    }
  }
  let predecessor = base, count = 0; const removed = new Set(), completed = [];
  while (claims.has(predecessor)) {
    if (++count > 128) throw new Error('Retention history exceeds 128 operations; investigate manually');
    const claim = claims.get(predecessor);
    if (claim.id === ownClaim) { claims.delete(predecessor); operationIds.delete(claim.id); break; }
    const receipt = receipts.get(claim.id);
    if (!receipt) throw new Error('Dangling retention operation; no retry');
    validateReceipt(receipt, claim, predecessor);
    for (const group of receipt.removedGroups) {
      if (!groups.has(group) || removed.has(group)) throw new Error('Duplicate/invalid removed retention group');
      removed.add(group);
    }
    completed.push({ claim, receipt }); predecessor = receipt.history;
    claims.delete(claim.predecessor); receipts.delete(claim.id); operationIds.delete(claim.id);
  }
  if (claims.size || receipts.size || operationIds.size) throw new Error('Unrecognized, cyclic or disconnected retention history');
  return { predecessor, removed, completed };
}

async function diagnosticsPaths(task) {
  const names = await readdir(task.directory), paths = [];
  for (const name of names) if (diagnosticNames.has(name) || checkLogName.test(name)) paths.push(name);
  if (names.includes('sessions')) paths.push('sessions');
  return paths.sort();
}
async function pathsFor(task, selections) {
  const paths = [];
  if (selections.includes('build-output')) paths.push('build-output');
  if (selections.includes('recovery')) paths.push('finalization/source.bundle', 'finalization/local-files.json');
  if (selections.includes('diagnostics')) paths.push(...await diagnosticsPaths(task));
  return paths;
}
async function protectedIdentities(task) {
  const result = new Set();
  for (const file of [task.owner?.file, task.custodian?.file]) {
    if (typeof file !== 'string') continue;
    try { const st = await lstat(file); result.add(`${st.dev}:${st.ino}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
async function assertNoProtectedAliases(task, files) {
  const protectedInodes = await protectedIdentities(task);
  for (const row of files) {
    const identity = `${row.stamp?.[0]}:${row.stamp?.[1]}`;
    if (protectedInodes.has(identity)) throw new Error('Selected payload aliases an initiating/custodian session; preserve it');
    // A symlink target is never followed, but an arbitrary chain cannot be proven
    // unrelated to an external protected session. Preserve it rather than unlinking.
    if (row.kind === 'symlink') throw new Error('Selected payload contains a symlink; inspect and preserve the group');
  }
}
async function heldContent(root, row, protectedInodes) {
  // Hold the only allowed intermediate directory too. O_NOFOLLOW on just the
  // final component cannot fence a swapped sessions/ symlink.
  const parent = row.path.startsWith('sessions/')
    ? await open(`/proc/self/fd/${root.fd}/sessions`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
  let fd;
  try {
    const name = parent ? row.path.slice('sessions/'.length) : row.path;
    const path = `/proc/self/fd/${(parent ?? root).fd}/${name}`;
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.mode & 0o077n || before.nlink !== 1n
      || !equal(row.stamp, stamp(before)) || protectedInodes.has(`${before.dev}:${before.ino}`) || before.size > 16n * 1024n * 1024n) {
      throw new Error('Diagnostic is unsafe, shared, protected or oversized; preserve it');
    }
    const body = Buffer.alloc(Number(before.size) + 1), { bytesRead } = await fd.read(body, 0, body.length, 0), after = await fd.stat({ bigint: true });
    const linked = await lstat(path, { bigint: true });
    if (bytesRead !== Number(before.size) || !equal(stamp(before), stamp(after)) || !equal(row.stamp, stamp(after))
      || !equal(row.stamp, stamp(linked))) throw new Error('Diagnostic content changed or path was replaced during inspection');
    return body.subarray(0, bytesRead);
  } finally { await fd?.close(); await parent?.close(); }
}
async function inspectDiagnostics(task, files) {
  const protectedInodes = await protectedIdentities(task), hashes = {};
  const root = await open(task.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await root.stat();
    if (!equal([identity.dev, identity.ino], await rootIdentity(task))) throw new Error('Task root changed during diagnostic inspection');
    for (const row of files) {
      if (row.path === 'sessions') {
        if (row.kind !== 'directory') throw new Error('Task-local sessions must be a real directory');
        continue;
      }
      const session = row.path.startsWith('sessions/') && !row.path.slice('sessions/'.length).includes('/');
      if (row.kind !== 'file' || (!diagnosticNames.has(row.path) && !checkLogName.test(row.path) && !(session && sessionName.test(row.path.slice(9))))) {
        throw new Error('Diagnostics contain an unknown file or nested directory; preserve the entire group');
      }
      const body = await heldContent(root, row, protectedInodes), text = body.toString('utf8');
      if (protectedText.test(text) || [task.owner?.file, task.custodian?.file].filter(Boolean).some(path => text.includes(path))) {
        throw new Error('Protected operational/session evidence detected; inspect and preserve it rather than pruning diagnostics');
      }
      hashes[row.path] = digest(body);
    }
  } finally { await root.close(); }
  return hashes;
}
async function inspectRecoveryArchive(task) {
  const path = join(task.directory, 'finalization', 'local-files.json');
  if (await absent(path)) return null;
  const archive = await lifecycleJSON(path);
  if (!Array.isArray(archive.files) || archive.files.length > 10000) throw new Error('Unknown local-files archive schema; preserve recovery');
  for (const row of archive.files) {
    if (!row || typeof row.name !== 'string') throw new Error('Unknown local-files archive entry; preserve recovery');
    let text = row.name;
    if (typeof row.base64 === 'string' && row.base64.length <= 22 * 1024 * 1024) {
      const body = Buffer.from(row.base64, 'base64');
      if (body.toString('base64') !== row.base64) throw new Error('Invalid local-files archive encoding');
      text += '\n' + body.toString('utf8');
    }
    if (protectedText.test(text)) throw new Error('Protected operational evidence detected in recovery archive; preserve it');
  }
  return digest(JSON.stringify(archive));
}
async function measuredGroups(task) {
  const measured = {};
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  for (const group of groupNames) {
    const paths = await pathsFor(task, [group]);
    assertNoPayloadMounts(task.directory, paths.map(path => join(task.directory, path)), mounts);
    const files = await inventoryPayloads(task, paths);
    measured[group] = { present: files.length > 0, entries: files.length,
      allocatedBytes: files.reduce((total, row) => total + row.allocatedBytes, 0), paths: files.map(row => row.path) };
  }
  return measured;
}
async function freshEvidence(task, input, runtime, observe, original) {
  return cleanupEvidence(task, { task: task.id, repository: input.repository, action: 'dispose' }, runtime, observe,
    task.finalized.authorization.id, original.claim.id);
}
function validateRequest(input) {
  if (!uuid.test(input.task) || typeof input.repository !== 'string' || !isAbsolute(input.repository)
    || !Array.isArray(input.selections) || input.selections.length > 3 || new Set(input.selections).size !== input.selections.length
    || input.selections.some(group => !groups.has(group)) || (input.compactDisposalClaim !== undefined && typeof input.compactDisposalClaim !== 'boolean')
    || (input.inventoryOffset !== undefined && (!Number.isSafeInteger(input.inventoryOffset) || input.inventoryOffset < 0))
    || (input.inventoryLimit !== undefined && (!Number.isSafeInteger(input.inventoryLimit) || input.inventoryLimit < 1 || input.inventoryLimit > 1000))
    || (input.compactDisposalClaim === true ? input.selections.length !== 0 : input.selections.length === 0)) {
    throw new Error('Exact repository and either explicit retained payload selections or separate compaction mode required');
  }
}

export async function assessPrune(runtime, input, observe, ownClaim) {
  if (runtime.retentionProtocol !== 1 || runtime.cleanupProtocol !== 1 || runtime.disposalProtocol !== 1
    || runtime.reconciliationProtocol !== 1 || runtime.finalizationProtocol !== 1 || runtime.containmentProtocol !== 1) {
    throw new Error('Explicit retention, cleanup, disposal, reconciliation, finalization and containment protocols required');
  }
  validateRequest(input);
  const task = await cleanupTask(runtime, { task: input.task, repository: input.repository, action: 'dispose' });
  const original = await originalDisposal(task);
  // Always run the complete ordinary gate internally, including after compaction.
  // This rechecks finalization intent/ready, original claim ID, repository, archived
  // review, current backend contradiction and fresh same-boot containment.
  const disposal = await disposalGate(task, { task: task.id, expectedNonce: task.nonce, expectedFinalization: original.authorization.finalization,
    selections: original.authorization.selections, legacyRecovery: original.authorization.legacyRecovery }, runtime, {
    cleanupCaller: null,
    cleanupVerify: (current, finalization, disposalClaim) => cleanupEvidence(current,
      { task: task.id, repository: input.repository, action: 'dispose', ...(original.authorization.legacyRecovery ? { legacyRecovery: true, selections: ['recovery'] } : {}) },
      runtime, observe, finalization, disposalClaim),
  }, original.claim.id);
  if (disposal.files.length) throw new Error('Earlier disposal selected roots have reappeared; investigate instead of pruning');
  const proof = await freshEvidence(task, input, runtime, observe, original);
  const history = await retentionHistory(task, original.base, ownClaim), pending = retentionClaimPath(task, history.predecessor);
  if (!await absent(pending) && (!ownClaim || (await lifecycleJSON(pending)).id !== ownClaim)) throw new Error('Retention operation already claimed or interrupted; no retry');
  for (const group of history.removed) {
    if ((await inventoryPayloads(task, await pathsFor(task, [group]))).length) throw new Error(`Previously removed group reappeared: ${group}`);
  }
  if (input.selections.some(group => history.removed.has(group))) throw new Error('A previously removed group cannot be selected again');
  const root = await rootIdentity(task), before = await filesystem(task.directory);
  let files, contentHashes = {}, recoveryArchiveHash = null, compaction = null;
  if (input.compactDisposalClaim === true) {
    if (original.compacted) throw new Error('Disposal claim was already compacted');
    assertNoPayloadMounts(task.directory, [claimPath(task)], await readFile('/proc/self/mountinfo', 'utf8'));
    files = await inventoryPayloads(task, ['disposal-claim.json']);
    if (files.length !== 1 || files[0].kind !== 'file' || files[0].shared) throw new Error('Disposal claim must be one unshared regular file for compaction');
    const { files: oldFiles, ...nonFiles } = original.claim;
    const estimate = { ...nonFiles, compacted: true, originalByteSha256: original.claimHash,
      originalInventoryDigest: original.authorization.inventory, inventoryEntries: oldFiles.length,
      inventoryAllocatedBytes: oldFiles.reduce((total, row) => total + (row.allocatedBytes ?? 0), 0),
      originalClaimAllocatedBytes: files[0].allocatedBytes, compactionReceipt: '00000000-0000-0000-0000-000000000000',
      perFileDetail: 'removed; completion requires matching retention receipt' };
    const estimatedLogicalBytes = Buffer.byteLength(JSON.stringify(estimate, null, 2) + '\n'), blockSize = Number(before.blockSize);
    compaction = { path: 'disposal-claim.json', byteSha256: original.claimHash, metadata: files[0],
      originalInventoryDigest: original.authorization.inventory, inventoryEntries: oldFiles.length,
      inventoryAllocatedBytes: estimate.inventoryAllocatedBytes, beforeAllocatedBytes: files[0].allocatedBytes,
      estimatedTombstoneLogicalBytes: estimatedLogicalBytes,
      estimatedAfterAllocatedBytes: Math.ceil(estimatedLogicalBytes / blockSize) * blockSize,
      estimateLimitation: 'Filesystem allocation is estimated from current block size; xattrs, compression, sparse allocation and record writes can differ.',
      irreversibleLoss: 'Per-file disposal inventory paths, stamps, kinds, targets and allocation details will be destroyed.' };
  } else {
    const selectedPaths = await pathsFor(task, input.selections);
    assertNoPayloadMounts(task.directory, selectedPaths.map(path => join(task.directory, path)), await readFile('/proc/self/mountinfo', 'utf8'));
    files = await inventoryPayloads(task, selectedPaths);
    await assertNoProtectedAliases(task, files);
    for (const group of input.selections) {
      const groupPaths = await pathsFor(task, [group]);
      if (!files.some(file => groupPaths.some(path => file.path === path || file.path.startsWith(path + '/')))) throw new Error(`Selected retained group is no longer present: ${group}`);
    }
    if (input.selections.includes('diagnostics')) {
      const diagnosticPaths = await diagnosticsPaths(task);
      contentHashes = await inspectDiagnostics(task, files.filter(row => diagnosticPaths.some(path => row.path === path || row.path.startsWith(path + '/'))));
    }
    if (input.selections.includes('recovery')) recoveryArchiveHash = await inspectRecoveryArchive(task);
  }
  const boundFiles = files.map(row => contentHashes[row.path] ? { ...row, contentSha256: contentHashes[row.path] } : row);
  const inventory = digest(JSON.stringify({ root, files: boundFiles, selections: input.selections, mode: input.compactDisposalClaim === true ? 'compaction' : 'payload',
    predecessor: history.predecessor, recoveryArchiveHash, compaction }));
  const retained = await measuredGroups(task);
  return { task, original, proof, predecessor: history.predecessor, history, files: boundFiles, root, inventory, compaction,
    allocatedBytes: files.reduce((total, file) => total + file.allocatedBytes, 0), filesystemBefore: before,
    retainedGroups: retained, availableGroups: groupNames.filter(group => retained[group].present) };
}

export function pruneExpectedEvidence(gate, input, caller) {
  const expectedFinalization = digest(JSON.stringify(gate.task.finalized));
  return digest(JSON.stringify([caller.session, caller.file, input.task, input.repository, input.selections,
    input.compactDisposalClaim === true, expectedFinalization, gate.proof.evidence, gate.predecessor, gate.inventory]));
}
export function pruneAuthorization(gate, input, caller) {
  return { id: randomUUID(), task: gate.task.id, nonce: gate.task.nonce, finalization: digest(JSON.stringify(gate.task.finalized)),
    predecessor: gate.predecessor, inventory: gate.inventory, selections: [...input.selections], evidence: gate.proof.evidence,
    confirmation: input.expectedEvidence, mode: input.compactDisposalClaim === true ? 'compaction' : 'payload', caller, confirmedAt: new Date().toISOString() };
}
function validateAuthorization(gate, input, authorization, caller) {
  const mode = input.compactDisposalClaim === true ? 'compaction' : 'payload', confirmed = Date.parse(authorization?.confirmedAt);
  if (!authorization || !uuid.test(authorization.id) || authorization.task !== gate.task.id || authorization.nonce !== gate.task.nonce
    || authorization.finalization !== digest(JSON.stringify(gate.task.finalized)) || authorization.predecessor !== gate.predecessor
    || authorization.inventory !== gate.inventory || authorization.evidence !== gate.proof.evidence || !equal(authorization.selections, input.selections)
    || authorization.mode !== mode || !validTime(authorization.confirmedAt) || confirmed > Date.now() + 5000 || Date.now() - confirmed > 5 * 60 * 1000
    || gate.history.completed.some(operation => operation.claim.id === authorization.id)
    || !equal(authorization.caller, caller)
    || typeof caller?.session !== 'string' || !caller.session || typeof caller?.file !== 'string' || !isAbsolute(caller.file)
    || input.expectedNonce !== gate.task.nonce || input.expectedFinalization !== authorization.finalization
    || input.expectedInventory !== gate.inventory || authorization.confirmation !== input.expectedEvidence
    || typeof input.expectedEvidence !== 'string' || !hash.test(input.expectedEvidence)
    || input.expectedEvidence !== pruneExpectedEvidence(gate, input, caller)) {
    throw new Error('Fresh bound interactive retention authorization and exact expected fields required');
  }
}
function retentionClaim(gate, authorization) {
  return { ...authorization, kind: 'retention-prune', files: gate.files };
}
async function completedReceipt(gate, claim, input, unlinkedAllocatedBytes, filesystemAfter, retainedMeasurements, compaction) {
  const inventory = { digest: gate.inventory, entries: gate.files.length, allocatedBytes: gate.allocatedBytes, unlinkedAllocatedBytes,
    pathsDigest: digest(JSON.stringify(gate.files.map(row => row.path))), durableRecordOverheadExcluded: true };
  const retainedGroupMeasurements = Object.fromEntries(Object.entries(retainedMeasurements).filter(([, value]) => value.present)
    .map(([group, value]) => [group, { present: true, entries: value.entries, allocatedBytes: value.allocatedBytes,
      pathsDigest: digest(JSON.stringify(value.paths)) }]));
  const retainedGroups = groupNames.filter(group => retainedGroupMeasurements[group]);
  const receipt = { kind: 'retention-prune-receipt', version: 1, operation: claim.id, task: claim.task, nonce: claim.nonce,
    finalization: claim.finalization, predecessor: gate.predecessor, claim: claimDigest(claim), mode: claim.mode,
    selections: claim.selections, inventory, history: '', removedGroups: claim.selections, retainedGroups, retainedGroupMeasurements,
    filesystemBefore: gate.filesystemBefore, filesystemAfter,
    accounting: 'Observed allocated blocks and filesystem free-space are not guaranteed reclamation; durable claim/receipt/tombstone overhead, open files, snapshots and concurrent activity remain.',
    completedAt: new Date().toISOString(), ...(compaction ? { compaction } : {}) };
  receipt.history = receiptHistory(receipt);
  return receipt;
}

export async function pruneTask(runtime, input, observe, authorization, guard = () => {}, caller) {
  if (input.compactDisposalClaim === true) throw new Error('Payload API cannot compact or remove permanent claims; use the separate compaction API');
  const gate = await assessPrune(runtime, input, observe); validateAuthorization(gate, input, authorization, caller);
  guard(); const path = retentionClaimPath(gate.task, gate.predecessor), claim = retentionClaim(gate, authorization);
  await durableSave(path, claim);
  const fresh = await assessPrune(runtime, input, observe, authorization.id);
  if (fresh.predecessor !== gate.predecessor || fresh.inventory !== gate.inventory || fresh.proof.evidence !== gate.proof.evidence) throw new Error('Retention inventory/evidence changed after claim; retain the pending claim');
  guard(); const unlinkedAllocatedBytes = await removePayloadInventory(gate.task, gate.files, guard, gate.root);
  const retained = await measuredGroups(gate.task);
  for (const group of input.selections) if (retained[group].present) throw new Error('Selected retained group remains after unlink; retain pending claim');
  guard();
  if (!equal(await rootIdentity(gate.task), gate.root)) throw new Error('Task directory changed after unlink; retain pending claim');
  const receipt = await completedReceipt(gate, claim, input, unlinkedAllocatedBytes, await filesystem(gate.task.directory), retained);
  await durableSave(retentionReceiptPath(gate.task, authorization.id), receipt);
  return receipt;
}

// Compaction replaces the old claim through a held canonical directory FD. The
// old file must be unshared and unchanged. The original operation ID and every
// non-file proof field are preserved byte-for-value in the tombstone.
export async function compactDisposalClaim(runtime, input, observe, authorization, guard = () => {}, caller) {
  if (input.compactDisposalClaim !== true || !Array.isArray(input.selections) || input.selections.length !== 0) {
    throw new Error('Compaction API requires explicit compact mode and no payload selections');
  }
  const request = { ...input, selections: [], compactDisposalClaim: true };
  const gate = await assessPrune(runtime, request, observe); validateAuthorization(gate, request, authorization, caller);
  guard(); const pending = retentionClaimPath(gate.task, gate.predecessor), claim = retentionClaim(gate, authorization);
  await durableSave(pending, claim);
  const fresh = await assessPrune(runtime, request, observe, authorization.id);
  if (fresh.predecessor !== gate.predecessor || fresh.inventory !== gate.inventory || fresh.proof.evidence !== gate.proof.evidence
    || fresh.original.base !== gate.original.base) throw new Error('Evidence changed after compaction claim; retain pending claim');
  const root = await open(gate.task.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let tombstone, originalAllocated, tombstoneAllocated, tombstoneHash;
  try {
    const heldRoot = await root.stat();
    if (!equal([heldRoot.dev, heldRoot.ino], gate.root)) throw new Error('Task directory changed before compaction');
    const oldPath = `/proc/self/fd/${root.fd}/disposal-claim.json`, old = await open(oldPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let oldBytes, oldStat;
    try {
      oldStat = await old.stat({ bigint: true });
      if (!oldStat.isFile() || oldStat.uid !== BigInt(process.getuid()) || oldStat.mode & 0o077n || oldStat.nlink !== 1n) throw new Error('Hardlinked or unsafe disposal claim cannot be compacted');
      oldBytes = Buffer.alloc(Number(oldStat.size) + 1); const read = await old.read(oldBytes, 0, oldBytes.length, 0);
      if (read.bytesRead !== Number(oldStat.size) || digest(oldBytes.subarray(0, read.bytesRead)) !== gate.original.claimHash) throw new Error('Disposal claim changed before compaction');
      oldBytes = oldBytes.subarray(0, read.bytesRead); originalAllocated = Number(oldStat.blocks * 512n);
    } finally { await old.close(); }
    const oldRecord = JSON.parse(oldBytes.toString('utf8')), { files, ...nonFiles } = oldRecord;
    tombstone = { ...nonFiles, compacted: true, originalByteSha256: gate.original.claimHash,
      originalInventoryDigest: gate.original.authorization.inventory, inventoryEntries: files.length,
      inventoryAllocatedBytes: files.reduce((total, row) => total + (row.allocatedBytes ?? 0), 0),
      originalClaimAllocatedBytes: originalAllocated, compactionReceipt: authorization.id,
      perFileDetail: 'removed; completion requires matching retention receipt' };
    const temporaryName = `.retention-compaction-${authorization.id}.tmp`, temporary = `/proc/self/fd/${root.fd}/${temporaryName}`;
    const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await out.writeFile(JSON.stringify(tombstone, null, 2) + '\n'); await out.sync(); } finally { await out.close(); }
    const current = await open(oldPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const currentStat = await current.stat({ bigint: true }), now = await current.readFile();
      if (currentStat.nlink !== 1n || !equal(gate.files[0].stamp, stamp(currentStat)) || digest(now) !== gate.original.claimHash) {
        throw new Error('Disposal claim changed or became shared before compaction rename');
      }
    } finally { await current.close(); }
    guard();
    // rename through the held root descriptor; no unconstrained path lookup is used.
    const { rename } = await import('node:fs/promises'); await rename(temporary, oldPath); await root.sync();
    const afterRoot = await root.stat();
    if (!equal([afterRoot.dev, afterRoot.ino], gate.root)) throw new Error('Task directory changed during compaction');
    const final = await open(oldPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const st = await final.stat({ bigint: true }), bytes = await final.readFile(); tombstoneAllocated = Number(st.blocks * 512n); tombstoneHash = digest(bytes); }
    finally { await final.close(); }
  } finally { await root.close(); }
  guard();
  const compaction = { kind: 'retention-disposal-claim-compaction', operation: authorization.id,
    authorizationId: gate.original.authorization.id, originalByteSha256: gate.original.claimHash,
    tombstoneByteSha256: tombstoneHash, originalInventoryDigest: gate.original.authorization.inventory,
    entries: gate.original.claim.files.length, inventoryAllocatedBytes: gate.compaction.inventoryAllocatedBytes,
    originalClaimAllocatedBytes: originalAllocated, tombstoneAllocatedBytes: tombstoneAllocated,
    estimatedAfterAllocatedBytes: tombstoneAllocated, allocationDeltaBytes: tombstoneAllocated - originalAllocated,
    irreversibleLoss: gate.compaction.irreversibleLoss };
  if (!equal(await rootIdentity(gate.task), gate.root)) throw new Error('Task directory changed after compaction; retain pending claim');
  const retained = await measuredGroups(gate.task);
  const receipt = await completedReceipt(gate, claim, request, Math.max(0, originalAllocated - tombstoneAllocated),
    await filesystem(gate.task.directory), retained, compaction);
  await durableSave(retentionReceiptPath(gate.task, authorization.id), receipt);
  return receipt;
}
