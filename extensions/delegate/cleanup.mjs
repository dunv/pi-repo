// Cleanup authority is operation-scoped, never foreground/worker custody. Bound
// original terminal history and local Git identity are revalidated at each gate.
import { lstat, realpath, opendir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { digest, lifecycleJSON, snapshot } from './core.mjs';
import { archived, assertCustody } from './reconcile.mjs';
import { finalizationAttempts, finalizationClaimPath } from './finalize.mjs';
import { repositoryIdentity, assertFinalizationMounts } from './repository.mjs';
import { assertStopped } from './containment.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function exists(path) {
  try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function privateDirectory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || await realpath(path) !== path) {
    throw new Error('Canonical private cleanup state required');
  }
}
export async function cleanupTask(runtime, input) {
  if (runtime.cleanupProtocol !== 1 || runtime.containmentProtocol !== 1 || runtime.reconciliationProtocol !== 1
    || runtime.finalizationProtocol !== 1 || !uuid.test(input.task) || !['finalize', 'dispose'].includes(input.action)
    || typeof input.repository !== 'string' || !isAbsolute(input.repository)) throw new Error('Explicit cleanup runtime, exact task/action and canonical repository required');
  if (input.legacyRecovery !== undefined && typeof input.legacyRecovery !== 'boolean') throw new Error('legacyRecovery must be an explicit boolean');
  if (input.legacyRecovery === true && (runtime.legacyRecoveryDisposalProtocol !== 1 || runtime.disposalProtocol !== 1
    || input.action !== 'dispose' || input.disposition !== undefined || !equal(input.selections, ['recovery']))) {
    throw new Error('Legacy recovery disposal requires separate runtime opt-in and recovery-only disposal selection');
  }
  await privateDirectory(runtime.state);
  const directory = join(runtime.state, input.task); await privateDirectory(directory);
  const task = await lifecycleJSON(join(directory, 'task.json'));
  if (task.id !== input.task || task.directory !== directory || task.version !== 1) throw new Error('Cleanup manifest identity mismatch');
  const names = [];
  for await (const entry of await opendir(directory)) {
    if (names.length >= 1024) throw new Error('Too many retained artifacts for cleanup');
    names.push(entry.name);
  }
  if (names.includes('revisions')) throw new Error('Cleanup supports original attempts only; revision history remains blocked');
  const submission = await lifecycleJSON(join(directory, 'submission.json'));
  if (!uuid.test(submission.nonce)) throw new Error('Exact original admission nonce required');
  task.nonce = submission.nonce;
  if (names.includes('reconciliation.json')) {
    const receipt = await lifecycleJSON(join(directory, 'reconciliation.json'));
    task.reconciliationId = receipt.id; task.custodian = receipt.to;
  }
  if (names.includes('finalized.json')) task.finalized = await lifecycleJSON(join(directory, 'finalized.json'));
  if ((input.action === 'finalize') === Boolean(task.finalized)) throw new Error('Action does not match retained/finalized task state');
  const attempts = await finalizationAttempts(task, runtime);
  if (attempts.length !== 1) throw new Error('Only original scoped attempts support cleanup');
  return task;
}
// No caller-supplied terminal status, stopped proof, custody identity or Git
// identity is accepted. `observe` is the extension's complete backend query.
export async function cleanupEvidence(task, input, runtime, observe, finalizationClaim, disposalClaim) {
  if (runtime.cleanupProtocol !== 1) throw new Error('Explicit cleanup runtime required');
  const current = await cleanupTask(runtime, input);
  if (!equal(current, task)) throw new Error('Cleanup task/evidence changed');
  if (await exists(join(task.directory, 'disposal-claim.json'))
    && (!disposalClaim || (await lifecycleJSON(join(task.directory, 'disposal-claim.json'))).id !== disposalClaim)) {
    throw new Error('Disposal already claimed or interrupted; no cleanup retry');
  }
  const finalization = task.finalized;
  const allowedClaim = finalization?.authorization?.id ?? finalizationClaim;
  await assertCustody(task, task.custodian ?? task.owner, allowedClaim);
  // An unclaimed task has no custody to transfer. Pending ordinary continuation
  // claims must not be repurposed for cleanup (including interrupted admissions).
  const claim = join(task.directory, `revision-after-${digest(task.nonce)}.json`);
  if (await exists(claim)) {
    const record = await lifecycleJSON(claim);
    if (task.reconciliationId ? record.reconciliation !== task.reconciliationId
      : !allowedClaim || record.finalization !== allowedClaim || record.previousNonce !== task.nonce) {
      throw new Error('Existing continuation claim blocks cleanup');
    }
  }
  const repository = await repositoryIdentity(input.repository, runtime);
  if (repository.main !== input.repository) throw new Error('Select the canonical main checkout, not a linked checkout');
  let legacyRecords = null;
  if (finalization && input.legacyRecovery === true) {
    // This is explicit permission to lose a finalized legacy recovery copy, NOT
    // proof of its historical Git identity. Never manufacture or backfill it.
    const intent = await lifecycleJSON(join(task.directory, 'finalization', 'intent.json'));
    const ready = await lifecycleJSON(join(task.directory, 'finalization', 'ready.json'));
    if (Object.hasOwn(finalization, 'repository') || Object.hasOwn(finalization.authorization ?? {}, 'repository')
      || Object.hasOwn(intent, 'repository') || Object.hasOwn(intent.authorization ?? {}, 'repository') || Object.hasOwn(ready, 'repository')) {
      throw new Error('Legacy exception requires entirely absent repository bindings; partial or modern identity must not be bypassed');
    }
    // An existing source must agree, but even this does not upgrade the absent
    // historical identity. Worktree/ref absence is checked by disposalGate.
    if (await exists(task.repo) && !equal(await repositoryIdentity(task.repo, runtime), repository)) throw new Error('Original repository path was replaced');
    legacyRecords = { intent, ready, claim: await lifecycleJSON(finalizationClaimPath(task)) };
  } else if (finalization) {
    if (!finalization.repository || !equal(finalization.repository, repository)
      || !equal(finalization.authorization?.repository, repository)) throw new Error('Finalization lacks matching durable repository identity; legacy cleanup remains blocked without explicit legacy recovery disposal');
  } else {
    if (!equal(await repositoryIdentity(task.worktree, runtime), repository)) throw new Error('Retained worker belongs to another repository');
    if (await exists(task.repo) && !equal(await repositoryIdentity(task.repo, runtime), repository)) throw new Error('Original repository path was replaced');
    await assertFinalizationMounts(task);
  }
  const archive = await archived(task, task.nonce, allowedClaim);
  const result = await lifecycleJSON(join(task.directory, 'result.json'));
  if (!equal(result, archive.worker) || result.code !== archive.status.exitCode || result.signal
    || result.integrityError || result.workerError || !hash.test(result.fingerprint)) throw new Error('Original worker result differs from bound archived review');
  const backend = await observe(archive.job);
  if (backend !== null && (backend.nonce !== task.nonce || backend.phase !== 'EXITED' || backend.exitCode !== archive.status.exitCode)) {
    throw new Error('Current backend contradicts archived terminal evidence');
  }
  const stopped = await assertStopped(task);
  let reconciliation = null;
  if (task.reconciliationId) {
    reconciliation = await lifecycleJSON(join(task.directory, 'reconciliation.json'));
    if (reconciliation.evidence.historyHash !== archive.historyHash || !equal(reconciliation.evidence.job, archive.job)
      || !equal(reconciliation.evidence.terminal, archive.status)
      || reconciliation.evidence.resultHash !== digest(JSON.stringify(result))
      || reconciliation.evidence.containmentHash !== digest(JSON.stringify(await lifecycleJSON(join(task.directory, 'containment.json'))))) {
      throw new Error('Reconciled archived provenance changed');
    }
  }
  const evidence = digest(JSON.stringify({ task: await lifecycleJSON(join(task.directory, 'task.json')),
    history: archive.historyHash, job: archive.job, status: archive.status, result, reconciliation,
    containment: await lifecycleJSON(join(task.directory, 'containment.json')), repository,
    finalization: finalization ?? null, legacyRecovery: input.legacyRecovery === true, legacyRecords }));
  return { repository, evidence, stopped, backendPresent: backend !== null, legacyRecovery: input.legacyRecovery === true,
    status: { ...archive.status, phase: 'RECONCILED_EXITED', backendAuthority: false,
      provenance: 'original-session-terminal-review-v1', authority: 'cleanup-only' } };
}
export async function assessCleanup(runtime, input, observe) {
  const task = await cleanupTask(runtime, input);
  const proof = await cleanupEvidence(task, input, runtime, observe);
  return { task, proof, fingerprint: task.finalized ? null : await snapshot(task, runtime) };
}
