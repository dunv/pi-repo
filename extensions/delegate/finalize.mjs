// Explicit, recoverable disposal; never infer acceptance from worker completion.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readlink, readdir, realpath, rmdir } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { attemptDirectory, digest, git, json, privateDir, save, snapshot } from './core.mjs';
import { assertStopped } from './containment.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const limit = 64 * 1024 * 1024;
async function absent(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function finalizationAttempts(task, runtime) {
  if (!uuid.test(task.id) || (task.attempt !== undefined && !uuid.test(task.attempt))
    || task.directory !== join(runtime.state, task.id)) throw new Error('Finalization task identity mismatch');
  await privateDir(runtime.state); await privateDir(task.directory);
  const manifest = await json(join(task.directory, 'task.json'));
  for (const key of ['id', 'repo', 'directory', 'worktree', 'base', 'branch']) {
    if (manifest[key] !== task[key]) throw new Error('Finalization manifest identity mismatch');
  }
  if (JSON.stringify(manifest.checks) !== JSON.stringify(task.checks)) throw new Error('Frozen check plan changed');
  if (manifest.owner?.session !== task.owner?.session || manifest.owner?.file !== task.owner?.file
    || task.branch !== `delegate/${task.id}` || task.worktree === task.repo
    || dirname(task.worktree) !== task.repo + '.worktrees' || !basename(task.worktree).endsWith(task.id)) {
    throw new Error('Finalization ownership/path mismatch');
  }
  const attempts = [undefined];
  const revisions = join(task.directory, 'revisions');
  if (!await absent(revisions)) {
    await privateDir(revisions);
    for (const name of await readdir(revisions)) {
      if (!uuid.test(name)) throw new Error('Unknown retained revision; investigate manually');
      attempts.push(name);
    }
  }
  const rows = [];
  for (const attempt of attempts) {
    const directory = attemptDirectory(task, attempt);
    await privateDir(directory);
    if (attempt !== undefined) {
      const plan = await json(join(directory, 'attempt.json'));
      if (plan.task !== task.id || plan.attempt !== attempt) throw new Error('Revision identity mismatch');
    }
    const submission = await json(join(directory, 'submission.json'));
    if (typeof submission.nonce !== 'string' || !submission.nonce) throw new Error('Unresolved attempt admission; manual reconciliation required');
    rows.push({ attempt, nonce: submission.nonce });
  }
  if (rows.find(row => row.attempt === task.attempt)?.nonce !== task.nonce) throw new Error('Latest attempt binding changed');
  return rows;
}
// Include ignored local files as well: their contents were not covered by review.
// Bounded JSON/base64 recovery avoids relying on an external archive executable.
async function localFiles(task, runtime) {
  const names = new Set((await git(runtime, task.worktree, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '-z'])
    + await git(runtime, task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    + await git(runtime, task.worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  if (names.size > 10000) throw new Error('Too many local files to archive; reconcile manually');
  const files = []; let bytes = 0;
  for (const name of [...names].sort()) {
    const path = resolve(task.worktree, name), rel = relative(task.worktree, path);
    if (!rel || rel.startsWith('../') || rel.startsWith('/') || rel.split('/').includes('.git')) throw new Error('Unsafe archive path');
    let stat;
    try { stat = await lstat(path); } catch (error) {
      if (error.code === 'ENOENT') { files.push({ name, deleted: true }); continue; } throw error;
    }
    // Never follow an intermediate symlink outside the checkout.
    const parent = await realpath(dirname(path));
    if (parent !== task.worktree && !parent.startsWith(task.worktree + '/')) throw new Error('Archive path escapes checkout');
    bytes += stat.size;
    if (bytes > limit || !(stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsupported/oversized local archive; reconcile manually');
    const data = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
    if (!stat.isSymbolicLink() && data.length !== stat.size) throw new Error('Local file changed during archive');
    files.push({ name, mode: stat.mode, ...(stat.isSymbolicLink() ? { symlink: data } : { base64: data.toString('base64') }) });
  }
  return { files, bytes };
}
export async function finalizationGate(task, input, runtime, statuses, stopped = assertStopped, claim) {
  if (runtime.finalizationProtocol !== 1 || runtime.containmentProtocol !== 1) throw new Error('Activate the finalization/scoped runtime and restart Pi first');
  if (task.finalized || task.id !== input.task || task.nonce !== input.expectedNonce
    || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint) || !['integrated', 'discarded'].includes(input.disposition)) {
    throw new Error('Latest task and reviewed fingerprint/disposition required');
  }
  const attempts = await finalizationAttempts(task, runtime);
  if (await realpath(task.worktree) !== task.worktree || await realpath(task.repo) !== task.repo) throw new Error('Checkout path changed');
  const common = async path => resolve(path, (await git(runtime, path, ['rev-parse', '--git-common-dir'])).trim());
  if (await realpath(await common(task.repo)) !== await realpath(await common(task.worktree))) throw new Error('Worker repository identity changed');
  const claimPath = join(task.directory, `revision-after-${digest(task.nonce)}.json`);
  if (!await absent(claimPath)) {
    const existing = await json(claimPath);
    if (!claim || existing.finalization !== claim) throw new Error('Attempt already claimed for revision/finalization; reconcile manually');
  }
  if (!await absent(join(task.directory, 'finalized.json'))) throw new Error('Task already finalized');
  const proofs = [];
  if (!Array.isArray(statuses) || statuses.length !== attempts.length) throw new Error('Every attempt needs authoritative terminal status');
  for (const row of attempts) {
    const matches = statuses.filter(status => status.nonce === row.nonce);
    if (matches.length !== 1 || !['EXITED', 'KILLED'].includes(matches[0].phase)
      || (matches[0].phase === 'EXITED' && !Number.isSafeInteger(matches[0].exitCode))) {
      throw new Error('Absent/UNKNOWN/active attempt; finalization blocked');
    }
    proofs.push(await stopped({ ...task, attempt: row.attempt }, row.attempt));
  }
  if (/^[a-zS] /m.test(await git(runtime, task.worktree, ['ls-files', '-v']))
    || /^160000 /m.test(await git(runtime, task.worktree, ['ls-files', '--stage']))) {
    throw new Error('Sparse/assume-unchanged entries or submodules require manual reconciliation');
  }
  if (await snapshot(task, runtime) !== input.expectedFingerprint) throw new Error('Reviewed source fingerprint changed');
  const feedback = join(task.directory, 'feedback');
  const records = new Map();
  for (const name of await readdir(feedback)) {
    if (!/\.json$/.test(name) || !uuid.test(name.slice(0, -5))) continue;
    const record = await json(join(feedback, name));
    if (record.task === task.id && record.nonce === task.nonce && record.attempt === (task.attempt ?? null)) records.set(name.slice(0, -5), record);
  }
  const superseded = new Set([...records.values()].map(record => record.supersedes).filter(Boolean));
  const current = [...records].filter(([id, record]) => !superseded.has(id)
    && (input.disposition === 'discarded' || record.reviewedFingerprint === input.expectedFingerprint)).map(([, record]) => record);
  if (!current.length || (input.disposition === 'integrated' && current.some(record => record.assessment?.reviewStatus !== 'reviewed'
    || record.assessment?.correctness !== 'good'))) throw new Error('Record current caller review/feedback before finalization');
  if (input.disposition === 'integrated') {
    const directory = attemptDirectory(task, task.attempt), passed = new Set();
    for (const name of await readdir(directory)) if (/^check-\d+-[a-f0-9-]+\.json$/.test(name)) {
      const check = await json(join(directory, name));
      if (check.passed === true && check.after === input.expectedFingerprint) passed.add(check.index);
    }
    if (task.checks.some((_, index) => !passed.has(index))) throw new Error('Current passing evidence required for all planned checks');
  }
  // 'integrated' is the caller's disposition, not automatic verification of a merge.
  const local = await localFiles(task, runtime);
  return { attempts, proofs, local, archiveFingerprint: digest(JSON.stringify(local)) };
}
export function finalizationAuthorization(task, input, gate) {
  return { id: randomUUID(), task: task.id, nonce: task.nonce, fingerprint: input.expectedFingerprint,
    disposition: input.disposition, archiveFingerprint: gate.archiveFingerprint, confirmedAt: new Date().toISOString() };
}
export async function finalizeTask(task, input, runtime, statuses, authorization, guard = () => {}, stopped = assertStopped) {
  const gate = await finalizationGate(task, input, runtime, statuses, stopped);
  if (!authorization || authorization.task !== task.id || authorization.nonce !== task.nonce
    || authorization.fingerprint !== input.expectedFingerprint || authorization.disposition !== input.disposition
    || authorization.archiveFingerprint !== gate.archiveFingerprint || !uuid.test(authorization.id) || !authorization.confirmedAt) {
    throw new Error('Fresh bound interactive authorization required');
  }
  guard();
  // Shared permanent continuation claim excludes stale session branches and revisions.
  await save(join(task.directory, `revision-after-${digest(task.nonce)}.json`), { finalization: authorization.id, previousNonce: task.nonce });
  const directory = join(task.directory, 'finalization');
  await privateDir(directory);
  await save(join(directory, 'intent.json'), { task: task.id, input, authorization, attempts: gate.attempts, stopped: gate.proofs });
  const bundle = join(directory, 'source.bundle');
  await git(runtime, task.repo, ['bundle', 'create', bundle, `refs/heads/${task.branch}`]);
  await chmod(bundle, 0o600);
  await git(runtime, task.repo, ['bundle', 'verify', bundle]);
  const patch = await git(runtime, task.worktree, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD']);
  const archive = { version: 1, base: task.base, branch: task.branch, patch, ...gate.local };
  await save(join(directory, 'local-files.json'), archive);
  if (digest(JSON.stringify(await json(join(directory, 'local-files.json')))) !== digest(JSON.stringify(archive))) throw new Error('Recovery archive verification failed');
  const fresh = await finalizationGate(task, input, runtime, statuses, stopped, authorization.id);
  if (fresh.archiveFingerprint !== authorization.archiveFingerprint) throw new Error('Local/ignored files changed after confirmation');
  guard();
  await save(join(directory, 'ready.json'), { archiveFingerprint: fresh.archiveFingerprint, recordedAt: new Date().toISOString() });
  // Git refuses locked/nested worktrees; never use double-force or rm -rf.
  await git(runtime, task.repo, ['worktree', 'remove', '--force', task.worktree]);
  guard();
  // Do not delete a ref reused by another checkout during the disposal window.
  const worktrees = (await git(runtime, task.repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  if (worktrees.includes(`branch refs/heads/${task.branch}`)) throw new Error('Delegate branch is checked out elsewhere; retained for manual reconciliation');
  // Compare-and-delete: a moved ref must survive even after worktree removal.
  await git(runtime, task.repo, ['update-ref', '-d', `refs/heads/${task.branch}`, task.base]);
  // Remove only an empty direct container, never recursively or through symlinks.
  let containerRemoved = false;
  try { await rmdir(dirname(task.worktree)); containerRemoved = true; } catch { /* Nonempty/inaccessible containers stay. */ }
  const receipt = { version: 1, task: task.id, attempt: task.attempt ?? null, nonce: task.nonce,
    disposition: input.disposition, directory, authorization, containerRemoved, finalizedAt: new Date().toISOString(), evidenceRetained: true };
  await save(join(task.directory, 'finalized.json'), receipt);
  return receipt;
}
export function finalizationRequest(task) {
  if (task.reconciliationId) return { available: false, task: task.id,
    instruction: 'Foreground-only reconciliation does not authorize finalization. Retain the worktree and all evidence; no automatic removal or claim release.' };
  return { tool: 'delegate_finalize', task: task.id, expectedNonce: task.nonce,
    instruction: 'After review, feedback and authorized integration (or an explicit discard decision), finalize this task to archive local changes and remove its worktree/branch. Supply the current reviewed fingerprint. Finalization requires fresh interactive confirmation and independent stopped-worker proof; completion/feedback alone never triggers deletion.' };
}
