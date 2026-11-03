// Explicit recovery is a new attempt, never a rewritten successful result.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attemptDirectory, digest, json, prepareRevision, snapshot, validateInput, verificationProfile, workerBackend } from './core.mjs';
import { assertStopped } from './containment.mjs';

export async function recoveryGate(task, input, runtime, rows) {
  if (runtime.containmentProtocol !== 1 || runtime.revisionProtocol !== 1) throw new Error('Recovery requires the scoped runtime; activate it and restart Pi first');
  if (task.id !== input.task || !task.nonce || task.nonce !== input.expectedNonce) throw new Error('Latest task/job binding changed');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].nonce !== task.nonce
    || !['EXITED', 'KILLED'].includes(rows[0].phase)) throw new Error('Recovery requires a known terminal job; absent/UNKNOWN/active jobs remain blocked');
  const status = rows[0];
  if (status.phase === 'EXITED' && !Number.isSafeInteger(status.exitCode)) throw new Error('Previous exit status is uncertain');
  const root = join(runtime.state, task.id), directory = attemptDirectory(task, task.attempt);
  const manifest = await json(join(root, 'task.json'));
  if (task.directory !== root || manifest.id !== task.id || manifest.directory !== root
    || manifest.owner?.session !== task.owner.session || manifest.owner?.file !== task.owner.file
    || manifest.worktree !== task.worktree || manifest.base !== task.base || manifest.branch !== task.branch) {
    throw new Error('Retained task identity mismatch');
  }
  let previous, resultState;
  try {
    previous = await json(join(directory, 'result.json'));
    resultState = previous?.code === 0 && !previous.signal && !previous.integrityError && !previous.workerError
      && /^[a-f0-9]{64}$/.test(previous.fingerprint) ? 'success' : 'failed';
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    resultState = error.code === 'ENOENT' ? 'missing' : 'invalid';
  }
  if (status.phase === 'EXITED' && status.exitCode === 0 && !status.cancellationRequested && resultState === 'success') {
    throw new Error('Use delegate_revise for successful uncanceled attempts');
  }
  const plan = task.attempt === undefined ? manifest : await json(join(directory, 'attempt.json'));
  if (task.attempt !== undefined && (plan.task !== task.id || plan.attempt !== task.attempt)) throw new Error('Previous attempt identity mismatch');
  if ((await json(join(directory, 'submission.json'))).nonce !== task.nonce) throw new Error('Previous submission binding mismatch');
  const selection = { backend: plan.backend ?? 'pi', route: plan.route ?? null, model: plan.model, thinking: plan.thinking };
  for (const key of ['backend', 'route', 'model', 'thinking']) {
    if (JSON.stringify(selection[key]) !== JSON.stringify(task[key] ?? (key === 'backend' ? 'pi' : key === 'route' ? null : undefined))) {
      throw new Error('Frozen invocation differs from session evidence');
    }
  }
  if (JSON.stringify(task.checks) !== JSON.stringify(manifest.checks) || task.profile !== manifest.profile
    || JSON.stringify(task.verification) !== JSON.stringify(manifest.verification)) throw new Error('Frozen verification plan differs');
  const frozen = { ...manifest, ...selection, attempt: task.attempt, nonce: task.nonce };
  validateInput({ ...frozen, brief: input.brief }); verificationProfile(frozen.verification); workerBackend(frozen, runtime);
  const stopped = await assertStopped(task);
  // Compare with the caller's reviewed CURRENT source, not the failed attempt's
  // result fingerprint. Foreground fixes are allowed without falsifying history.
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint) || await snapshot(frozen, runtime) !== input.expectedFingerprint) {
    throw new Error('Current source differs from reviewed fingerprint');
  }
  return { frozen, selection, stopped, execution: { nonce: status.nonce, phase: status.phase,
    exitCode: status.exitCode ?? null, cancellationRequested: status.cancellationRequested === true, workerResult: resultState } };
}

export async function prepareRecovery(task, input, runtime, rows, authorization, guard = () => {}) {
  const gate = await recoveryGate(task, input, runtime, rows);
  if (!authorization || authorization.task !== task.id || authorization.previousNonce !== task.nonce
    || authorization.expectedFingerprint !== input.expectedFingerprint || authorization.briefHash !== digest(input.brief)
    || !/^[a-f0-9-]{36}$/.test(authorization.id) || !authorization.confirmedAt) throw new Error('Fresh bound user authorization required');
  guard();
  // prepareRevision uses the SAME exclusive per-parent claim as ordinary revise,
  // so stale branch history and cross-tool races cannot admit two continuations.
  const recovery = { version: 1, previousAttempt: task.attempt ?? null, previousNonce: task.nonce,
    execution: gate.execution, stopped: gate.stopped, authorization };
  return prepareRevision(gate.frozen, { ...gate.selection, brief: input.brief,
    expectedNonce: input.expectedNonce, expectedFingerprint: input.expectedFingerprint }, runtime, recovery);
}
export async function assertRecoveryHandoff(task, plan, runtime) {
  const recovery = plan.recovery, authorization = recovery?.authorization;
  if (runtime.containmentProtocol !== 1 || recovery?.version !== 1 || plan.previousNonce !== recovery.previousNonce
    || authorization?.task !== task.id || authorization.previousNonce !== plan.previousNonce
    || authorization.expectedFingerprint !== plan.expectedFingerprint
    || authorization.briefHash !== digest(await readFile(join(attemptDirectory(task, plan.attempt), 'brief.md'), 'utf8'))) {
    throw new Error('Recovery authorization/binding changed before startup');
  }
  const previousAttempt = recovery.previousAttempt ?? undefined;
  const directory = attemptDirectory(task, previousAttempt);
  const parent = previousAttempt === undefined ? task : await json(join(directory, 'attempt.json'));
  if ((await json(join(directory, 'submission.json'))).nonce !== plan.previousNonce) throw new Error('Recovery parent submission changed');
  for (const key of ['backend', 'route', 'model', 'thinking']) {
    if (JSON.stringify(plan[key] ?? (key === 'backend' ? 'pi' : null)) !== JSON.stringify(parent[key] ?? (key === 'backend' ? 'pi' : null))) {
      throw new Error('Recovery invocation changed before startup');
    }
  }
  const claim = await json(join(task.directory, `revision-after-${digest(plan.previousNonce)}.json`));
  if (claim.attempt !== plan.attempt || claim.previousNonce !== plan.previousNonce) throw new Error('Recovery continuation claim changed');
  await assertStopped(task, previousAttempt);
}
export function recoveryAuthorization(task, input) {
  return { id: randomUUID(), task: task.id, previousNonce: task.nonce,
    expectedFingerprint: input.expectedFingerprint, briefHash: digest(input.brief), confirmedAt: new Date().toISOString() };
}
