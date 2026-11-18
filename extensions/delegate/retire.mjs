// Operator-attested abandonment, NOT recovered terminal/stopped evidence. This
// separate, opt-in archive-only path never relaxes ordinary lifecycle gates.
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, lstat, realpath, readdir, readFile, readlink, chmod } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { ENTRY, digest, lifecycleJSON, durableSave, privateDir, git, snapshot } from './core.mjs';
import { finalizationAttempts, localFiles } from './finalize.mjs';
import { repositoryIdentity, assertNoPayloadMounts } from './repository.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const protectedText = /(?:mailhub|trash[-_ ]?journal|approved[-_ ]?(?:mail|message)[-_ ]?set|unknown[-_ ]outcome)/i;
const gone = error => ['ENOENT', 'ESRCH'].includes(error.code);
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function directory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || await realpath(path) !== path) {
    throw new Error('Canonical private retirement state required');
  }
}
function callerValid(who) {
  return typeof who?.session === 'string' && who.session.length > 0 && who.session.length <= 200
    && typeof who.file === 'string' && isAbsolute(who.file);
}
async function optionalJSON(path) { return await exists(path) ? lifecycleJSON(path) : null; }

// This observation is deliberately NOT called stopped proof. /proc cannot prove
// an unreferenced process will never write here later. A human must independently
// establish idleness, including old clients and external build servers.
export async function observeRetirementProcesses(task) {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!uuid.test(boot)) throw new Error('Current Linux boot identity unavailable');
  const roots = [task.worktree, task.directory];
  const references = text => roots.some(root => text === root || text.startsWith(root + '/') || text.includes(root + '\0'));
  let seen = 0;
  const uninspectablePids = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    if (++seen > 100000) throw new Error('Process observation exceeds retirement bound');
    const base = '/proc/' + pid;
    try {
      if ((await lstat(base)).uid !== process.getuid()) continue;
      let incomplete = false;
      const observe = async operation => {
        try { return await operation(); } catch (error) {
          if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
          incomplete = true; return null;
        }
      };
      const cwd = await observe(() => readlink(join(base, 'cwd')));
      const cmd = await observe(() => readFile(join(base, 'cmdline'))) ?? Buffer.alloc(0);
      if (cmd.length > 1024 * 1024) throw new Error('Oversized process command; retirement blocked');
      if ((cwd !== null && references(cwd)) || cmd.toString('utf8').includes(task.id)) throw new Error(`Process ${pid} references this delegate; retirement blocked`);
      const fds = await observe(() => readdir(join(base, 'fd'))) ?? [];
      if (fds.length > 100000) throw new Error('Open-file observation exceeds retirement bound');
      for (const fd of fds) {
        let target;
        try { target = await observe(() => readlink(join(base, 'fd', fd))); } catch (error) { if (gone(error)) continue; throw error; }
        if (target !== null && references(target)) throw new Error(`Process ${pid} has a delegate file open; retirement blocked`);
      }
      if (incomplete) uninspectablePids.push(Number(pid));
      if (uninspectablePids.length > 1000) throw new Error('Too many uninspectable processes for explicit operator investigation');
    } catch (error) { if (!gone(error)) throw error; }
  }
  if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== boot) throw new Error('Boot changed during observation');
  return { bootId: boot, observation: 'current-user-process-reference-scan', uninspectablePids: uninspectablePids.sort((a, b) => a - b), stoppedProof: false };
}

async function attemptsFor(task, runtime, claimId) {
  const names = await readdir(task.directory);
  if (names.length > 1024) throw new Error('Too many lifecycle artifacts');
  if (names.some(name => ['finalization', 'finalized.json', 'disposal-claim.json', 'disposed.json', 'reconciliation.json', 'retired.json', 'retirement'].includes(name)
    || name.startsWith('finalization-after-'))) {
    // Own archive is allowed only during this exact claimed operation.
    const blockers = names.filter(name => ['finalization', 'finalized.json', 'disposal-claim.json', 'disposed.json', 'reconciliation.json', 'retired.json'].includes(name) || name.startsWith('finalization-after-'));
    if (blockers.length || !claimId) throw new Error('Prior reconciliation/finalization/disposal or interrupted retirement requires investigation');
  }
  const initial = await lifecycleJSON(join(task.directory, 'submission.json'));
  if (!uuid.test(initial.nonce)) throw new Error('Unresolved original admission; retirement blocked');
  const rows = [{ attempt: undefined, nonce: initial.nonce, previousNonce: null, plan: null }];
  const revisions = join(task.directory, 'revisions');
  if (await exists(revisions)) {
    await directory(revisions);
    const children = await readdir(revisions);
    if (children.length > 1024) throw new Error('Too many revision attempts');
    for (const attempt of children) {
      if (!uuid.test(attempt)) throw new Error('Unknown revision artifact');
      const path = join(revisions, attempt); await directory(path);
      const plan = await lifecycleJSON(join(path, 'attempt.json')), submission = await lifecycleJSON(join(path, 'submission.json'));
      if (plan.task !== task.id || plan.attempt !== attempt || !uuid.test(plan.previousNonce)
        || !uuid.test(submission.nonce) || !hash.test(plan.expectedFingerprint)) throw new Error('Unresolved or mismatched revision admission');
      rows.push({ attempt, nonce: submission.nonce, previousNonce: plan.previousNonce, plan });
    }
  }
  const chain = [rows[0]], remaining = rows.slice(1), allowed = new Set();
  while (remaining.length) {
    const next = remaining.filter(row => row.previousNonce === chain.at(-1).nonce);
    if (next.length !== 1) throw new Error('Broken/forked revision chain');
    const row = next[0], name = `revision-after-${digest(row.previousNonce)}.json`;
    const claim = await lifecycleJSON(join(task.directory, name));
    if (!equal(claim, { attempt: row.attempt, previousNonce: row.previousNonce })) throw new Error('Revision claim differs from admitted chain');
    allowed.add(name); chain.push(row); remaining.splice(remaining.indexOf(row), 1);
  }
  if (new Set(chain.map(row => row.nonce)).size !== chain.length) throw new Error('Duplicate admission nonce');
  const latest = chain.at(-1), latestName = `revision-after-${digest(latest.nonce)}.json`;
  for (const name of names.filter(name => name.startsWith('revision-after-'))) {
    if (allowed.has(name)) continue;
    const claim = await lifecycleJSON(join(task.directory, name));
    if (!claimId || name !== latestName || !equal(claim, { retirement: claimId, previousNonce: latest.nonce })) throw new Error('Unresolved continuation claim; no retirement retry');
  }
  const retired = await optionalJSON(join(task.directory, 'retirement-claim.json'));
  if (retired && (!claimId || retired.id !== claimId)) throw new Error('Retirement already claimed; no retry');
  const current = { ...task, nonce: latest.nonce, ...(latest.attempt === undefined ? {} : { attempt: latest.attempt }) };
  // Reuse strict manifest/path/owner checks, not ordinary terminal authority.
  const checked = await finalizationAttempts(current, runtime);
  if (checked.length !== chain.length) throw new Error('Retained attempts changed');
  return { task: current, rows: chain };
}

export async function admissions(task, rows) {
  const fd = await open(task.owner.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text;
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.nlink !== 1 || st.size > 64 * 1024 * 1024) throw new Error('Private original session history required');
    const buffer = Buffer.alloc(st.size + 1), { bytesRead } = await fd.read(buffer, 0, buffer.length, 0), after = await fd.stat();
    if (bytesRead !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new Error('Original session changed while reading');
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await fd.close(); }
  let entries;
  try { entries = text.trimEnd().split('\n').map(line => JSON.parse(line)); } catch { throw new Error('Invalid original session history'); }
  const header = entries.shift();
  if (header?.type !== 'session' || header.version !== 3 || header.id !== task.owner.session || entries.length > 200000) throw new Error('Original session identity mismatch');
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id) || !(entry.parentId === null || ids.has(entry.parentId))) throw new Error('Invalid original session tree');
    ids.add(entry.id);
  }
  const taskEntries = entries.filter(entry => entry.type === 'custom' && entry.customType === ENTRY && entry.data?.id === task.id).map(entry => entry.data);
  const keys = ['id', 'owner', 'directory', 'repo', 'worktree', 'base', 'branch', 'checks', 'verification'];
  if (taskEntries.some(record => keys.some(key => !equal(record[key], task[key]))
    || !rows.some(row => row.attempt === record.attempt && (record.nonce === undefined || row.nonce === record.nonce)))) throw new Error('Conflicting original task history');
  return rows.map(row => {
    if (!taskEntries.some(record => record.attempt === row.attempt && record.nonce === row.nonce)) throw new Error('Admission lacks original owning task history');
    const jobs = entries.filter(entry => entry.type === 'custom' && entry.customType === 'pi-repo.pueue.job.v1' && entry.data?.nonce === row.nonce).map(entry => entry.data);
    const full = jobs.find(job => job.admitted === true && Number.isSafeInteger(job.id) && job.id >= 0 && typeof job.created === 'string' && Number.isFinite(Date.parse(job.created)));
    if (!full || !uuid.test(full.namespace) || full.session !== task.owner.session || full.file !== task.owner.file
      || full.label !== `pi:${full.namespace}:${row.nonce}`) throw new Error('Original exact admission identity unavailable');
    const identity = { session: full.session, file: full.file, namespace: full.namespace, nonce: row.nonce,
      id: full.id, label: full.label, created: full.created, admitted: true };
    if (jobs.some(job => ['session', 'file', 'namespace', 'label'].some(key => job[key] !== identity[key])
      || (job.id !== undefined && job.id !== identity.id) || (job.created !== undefined && job.created !== identity.created) || job.admitted === false)) throw new Error('Contradictory admission history');
    return identity;
  });
}

export async function assessRetirement(runtime, input, who, observe, claimId, processes = observeRetirementProcesses) {
  if (runtime.retirementProtocol !== 1 || !uuid.test(input.task) || !isAbsolute(input.repository ?? '') || !callerValid(who)
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) throw new Error('Opt-in retirement runtime, canonical repository, persistent caller and bounded reason required');
  await directory(runtime.state);
  const root = join(runtime.state, input.task); await directory(root);
  const original = await lifecycleJSON(join(root, 'task.json'));
  if (original.version !== 1 || original.id !== input.task || original.directory !== root || !callerValid(original.owner)) throw new Error('Retirement manifest identity mismatch');
  const { task, rows } = await attemptsFor(original, runtime, claimId);
  if (await realpath(task.worktree) !== task.worktree || basename(task.worktree).endsWith(task.id) === false
    || dirname(task.worktree) !== task.repo + '.worktrees') throw new Error('Retirement worktree path changed');
  const repository = await repositoryIdentity(input.repository, runtime);
  if (repository.main !== input.repository || !equal(repository, await repositoryIdentity(task.worktree, runtime))) throw new Error('Select the matching canonical main checkout');
  if (await exists(task.repo) && !equal(repository, await repositoryIdentity(task.repo, runtime))) throw new Error('Original source path was replaced');
  const registrations = (await git(runtime, repository.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(block => block.split('\0'));
  const registered = registrations.filter(block => block[0] === `worktree ${task.worktree}`);
  if (registered.length !== 1 || registered[0].some(field => /^(?:locked|prunable)(?: |$)/.test(field))
    || registrations.some(block => block[0]?.startsWith(`worktree ${task.worktree}/`))) throw new Error('Locked/prunable/nested worktree; retirement blocked');
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  assertNoPayloadMounts(task.worktree, [task.worktree], mounts);
  assertNoPayloadMounts(task.directory, [join(task.directory, 'retirement')], mounts);
  const jobs = await admissions(task, rows), attempts = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], directory = row.attempt === undefined ? task.directory : join(task.directory, 'revisions', row.attempt);
    const result = await optionalJSON(join(directory, 'result.json')), containment = await optionalJSON(join(directory, 'containment.json'));
    const current = await observe(jobs[i]); // Complete original-namespace query; errors never become absence.
    if (current !== null && (current.nonce !== row.nonce || !['EXITED', 'KILLED'].includes(current.phase)
      || (current.phase === 'EXITED' && !Number.isSafeInteger(current.exitCode)))) throw new Error('Active/unknown backend attempt; retirement blocked');
    if (current?.phase === 'EXITED' && result && Number.isSafeInteger(result.code) && current.exitCode !== result.code) throw new Error('Backend contradicts retained worker result');
    attempts.push({ attempt: row.attempt ?? null, nonce: row.nonce, plan: row.plan, job: jobs[i], result, containment,
      backend: current === null ? 'absent-not-terminal-proof' : current.phase, exitCode: current?.exitCode ?? null });
  }
  const observation = await processes(task);
  if (!uuid.test(observation.bootId) || observation.stoppedProof !== false || observation.observation !== 'current-user-process-reference-scan'
    || !Array.isArray(observation.uninspectablePids)) throw new Error('Current process observation unavailable');
  const fingerprint = await snapshot(task, runtime, claimId), local = await localFiles(task, runtime);
  const patch = await git(runtime, task.worktree, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD']);
  if (protectedText.test(patch) || local.files.some(file => protectedText.test(file.name) || (file.base64 && protectedText.test(Buffer.from(file.base64, 'base64').toString('utf8'))))) {
    throw new Error('Potential protected operational evidence; preserve and investigate separately');
  }
  // Hidden index entries/submodules must not evade snapshot/archive coverage.
  if (/^[a-zS] /m.test(await git(runtime, task.worktree, ['ls-files', '-v'])) || /^160000 /m.test(await git(runtime, task.worktree, ['ls-files', '--stage']))) throw new Error('Unsupported sparse/submodule checkout');
  const archive = { version: 1, base: task.base, branch: task.branch, patch, ...local };
  const evidence = digest(JSON.stringify({ original, repository, attempts, observation, fingerprint, archive,
    caller: { session: who.session, file: who.file }, reason: input.reason }));
  return { task, repository, attempts, observation, fingerprint, archive, evidence,
    authority: 'operator-attested-retirement', backendAuthority: false, terminalVerified: false, stoppedProof: false };
}
export function retirementAuthorization(gate, who, reason) {
  return { id: randomUUID(), task: gate.task.id, evidence: gate.evidence, fingerprint: gate.fingerprint,
    caller: { session: who.session, file: who.file }, reason, confirmedAt: new Date().toISOString(),
    declaration: 'obsolete-discarded; all owners/build users idle; no surviving workers or descendants; protected evidence inspected',
    authority: 'operator-attested-retirement', terminalVerified: false, stoppedProof: false };
}
export async function retireTask(runtime, input, who, observe, authorization, guard = () => {}, processes = observeRetirementProcesses) {
  const gate = await assessRetirement(runtime, input, who, observe, undefined, processes);
  if (!authorization || !uuid.test(authorization.id) || !Number.isFinite(Date.parse(authorization.confirmedAt))
    || !equal(authorization, { ...retirementAuthorization(gate, who, input.reason), id: authorization.id, confirmedAt: authorization.confirmedAt })
    || input.expectedEvidence !== gate.evidence || input.expectedFingerprint !== gate.fingerprint) throw new Error('Fresh exact retirement assessment and interactive authorization required');
  guard();
  const id = authorization.id, task = gate.task;
  // Competes with the latest revision/recovery/finalization. Never replace old
  // claims. Interrupted operations remain permanently fenced, without retry.
  await durableSave(join(task.directory, `revision-after-${digest(task.nonce)}.json`), { retirement: id, previousNonce: task.nonce });
  await durableSave(join(task.directory, 'retirement-claim.json'), { id, task: task.id, authorization });
  const fresh = await assessRetirement(runtime, input, who, observe, id, processes);
  if (fresh.evidence !== gate.evidence) throw new Error('Retirement evidence changed after claim; retain pending operation');
  guard();
  const directory = join(task.directory, 'retirement'); await privateDir(directory);
  const parent = await open(task.directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
  await durableSave(join(directory, 'intent.json'), { version: 1, authorization, repository: gate.repository,
    attempts: gate.attempts, observation: gate.observation, archiveFingerprint: digest(JSON.stringify(gate.archive)) });
  const bundle = join(directory, 'source.bundle');
  await git(runtime, gate.repository.main, ['bundle', 'create', bundle, `refs/heads/${task.branch}`]);
  await chmod(bundle, 0o600); await git(runtime, gate.repository.main, ['bundle', 'verify', bundle]);
  const fd = await open(bundle, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
  await durableSave(join(directory, 'local-files.json'), gate.archive);
  if (!equal(await lifecycleJSON(join(directory, 'local-files.json')), gate.archive)) throw new Error('Retirement archive verification failed');
  const final = await assessRetirement(runtime, input, who, observe, id, processes);
  if (final.evidence !== gate.evidence) throw new Error('Retirement evidence changed before removal; preserve archives and claim');
  guard();
  await durableSave(join(directory, 'ready.json'), { repository: gate.repository, evidence: gate.evidence,
    archiveFingerprint: digest(JSON.stringify(gate.archive)), recordedAt: new Date().toISOString() });
  // Normal Git safeguards for locked/nested worktrees remain; no double force.
  await git(runtime, gate.repository.main, ['worktree', 'remove', '--force', task.worktree]);
  guard();
  if ((await git(runtime, gate.repository.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0').includes(`branch refs/heads/${task.branch}`)) throw new Error('Delegate ref is checked out elsewhere; preserve it');
  await git(runtime, gate.repository.main, ['update-ref', '-d', `refs/heads/${task.branch}`, task.base]);
  const receipt = { version: 1, task: task.id, disposition: 'discarded', directory, authorization, repository: gate.repository,
    authority: gate.authority, backendAuthority: false, terminalVerified: false, stoppedProof: false,
    attempts: gate.attempts.map(row => ({ attempt: row.attempt, nonce: row.nonce })),
    retiredAt: new Date().toISOString(), evidenceRetained: true, buildOutputsRetained: true };
  await durableSave(join(task.directory, 'retired.json'), receipt);
  return receipt;
}
