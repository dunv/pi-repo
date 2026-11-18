// Explicit one-time enrollment, then unattended expiry of sealed closed-task
// payloads. Never an age-based task sweeper, fabricated stopped proof or retry.
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digest, lifecycleJSON, durableSave, git, runtimeFrom } from './core.mjs';
import { finalizationAttempts } from './finalize.mjs';
import { admissions, observeRetirementProcesses } from './retire.mjs';
import { inventoryPayloads, removePayloadInventory } from './dispose.mjs';
import { repositoryIdentity, assertNoPayloadMounts } from './repository.mjs';
import { Backend, configuration } from '../pueue/backend.ts';
import { protectedText, protectedContentScanner } from './protected-content.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000;
const sha256 = /^[a-f0-9]{64}$/;
const groups = ['build-output', 'recovery'];
const enrollmentName = 'automatic-retention-enrollment.json';
const groupClaim = group => `automatic-retention-${group}-claim.json`;
const groupReceipt = group => `automatic-retention-${group}-receipt.json`;
function block(code) { const error = new Error(code); error.retentionReason = code; throw error; }
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function privateDirectory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || await realpath(path) !== path) block('unsafe-private-directory');
  return [st.dev, st.ino];
}
const identity = who => ({ session: who?.session, file: who?.file });
const validWho = who => typeof who?.session === 'string' && who.session.length > 0 && who.session.length <= 200
  && typeof who.file === 'string' && who.file.length <= 4096 && isAbsolute(who.file);
async function saveRecord(path, value) {
  if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 128 * 1024 * 1024) block('automatic-record-exceeds-private-reader-limit');
  return durableSave(path, value);
}
function timestamp(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(text) || !Number.isFinite(Date.parse(text))) block('invalid-lifecycle-time');
  return Date.parse(text);
}
export function automaticPolicy(runtime) {
  const p = runtime.automaticRetention;
  if (runtime.automaticRetentionProtocol !== 1 || !p || p.version !== 1 || !uuid.test(p.id)
    || !Array.isArray(p.repositories) || !p.repositories.length || p.repositories.length > 8
    || new Set(p.repositories).size !== p.repositories.length || p.repositories.some(path => typeof path !== 'string' || !isAbsolute(path))
    || p.buildDays !== 7 || p.recoveryDays !== 30 || Object.keys(p).sort().join(',') !== 'buildDays,id,recoveryDays,repositories,version') block('automatic-policy-not-enabled');
  return { version: 1, id: p.id, repositories: [...p.repositories], buildDays: 7, recoveryDays: 30 };
}
function pathsFor(closed, group) {
  return group === 'build-output' ? ['build-output'] : [`${closed.kind}/source.bundle`, `${closed.kind}/local-files.json`];
}
// Validate the completed closure itself; no archived status is upgraded to live
// authority and no missing or partial lifecycle record is repaired.
async function closedTask(runtime, input, now) {
  const policy = automaticPolicy(runtime);
  if (!uuid.test(input.task) || !policy.repositories.includes(input.repository)) block('repository-outside-policy');
  await privateDirectory(runtime.state);
  const directory = join(runtime.state, input.task), root = await privateDirectory(directory);
  const original = await lifecycleJSON(join(directory, 'task.json'));
  if (original.version !== 1 || original.id !== input.task || original.directory !== directory) block('task-identity-changed');
  const hasRetired = await exists(join(directory, 'retired.json')), hasFinalized = await exists(join(directory, 'finalized.json'));
  if (hasRetired === hasFinalized) block('task-not-unambiguously-closed');
  const kind = hasRetired ? 'retirement' : 'finalization';
  const receipt = await lifecycleJSON(join(directory, hasRetired ? 'retired.json' : 'finalized.json'));
  const auth = receipt.authorization;
  if (!auth || !uuid.test(auth.id) || receipt.version !== 1 || receipt.task !== original.id || auth.task !== original.id
    || receipt.directory !== join(directory, kind) || !['discarded', 'integrated'].includes(receipt.disposition)) block('invalid-closure-receipt');
  const closedAt = timestamp(hasRetired ? receipt.retiredAt : receipt.finalizedAt);
  if (!Number.isFinite(now) || closedAt > now || timestamp(auth.confirmedAt) > closedAt) block('future-or-inconsistent-closure');
  const archiveRoot = await privateDirectory(join(directory, kind));
  const intent = await lifecycleJSON(join(directory, kind, 'intent.json')), ready = await lifecycleJSON(join(directory, kind, 'ready.json'));
  if (!equal(intent.authorization, auth) || timestamp(ready.recordedAt) > closedAt) block('incomplete-closure');
  const repository = await repositoryIdentity(input.repository, runtime);
  if (repository.main !== input.repository || !equal(repository, receipt.repository) || !equal(repository, ready.repository)
    || !equal(repository, hasRetired ? intent.repository : auth.repository)) block('closed-repository-identity-unverified');
  let latest;
  if (hasRetired) {
    if (receipt.authority !== 'operator-attested-retirement' || receipt.stoppedProof !== false || receipt.terminalVerified !== false
      || !Array.isArray(receipt.attempts) || !receipt.attempts.length || !equal(intent.attempts.map(row => ({ attempt: row.attempt, nonce: row.nonce })), receipt.attempts)
      || ready.evidence !== auth.evidence || ready.archiveFingerprint !== intent.archiveFingerprint) block('incoherent-retirement');
    latest = receipt.attempts.at(-1);
    const claim = await lifecycleJSON(join(directory, 'retirement-claim.json'));
    if (claim.id !== auth.id || claim.task !== original.id || !equal(claim.authorization, auth)) block('incoherent-retirement-claim');
    const continuation = await lifecycleJSON(join(directory, `revision-after-${digest(latest.nonce)}.json`));
    if (!equal(continuation, { retirement: auth.id, previousNonce: latest.nonce })) block('retirement-continuation-changed');
  } else {
    latest = { attempt: receipt.attempt, nonce: receipt.nonce };
    if (ready.archiveFingerprint !== auth.archiveFingerprint || !Array.isArray(intent.stopped) || !intent.stopped.length
      || intent.stopped.some(proof => proof.stopped !== true)) block('incoherent-finalization');
    const prefix = intent.reconciliationId ? 'finalization' : 'revision';
    const claim = await lifecycleJSON(join(directory, `${prefix}-after-${digest(latest.nonce)}.json`));
    if (!equal(claim, { finalization: auth.id, previousNonce: latest.nonce })) block('finalization-claim-changed');
  }
  if (!latest || !uuid.test(latest.nonce) || (latest.attempt !== null && !uuid.test(latest.attempt))) block('latest-admission-unresolved');
  const task = { ...original, nonce: latest.nonce, ...(latest.attempt === null ? {} : { attempt: latest.attempt }) };
  const attempts = await finalizationAttempts(task, runtime), jobs = await admissions(task, attempts);
  const recordedAttempts = hasRetired ? receipt.attempts : intent.attempts.map(row => ({ attempt: row.attempt ?? null, nonce: row.nonce }));
  if (attempts.length !== recordedAttempts.length || attempts.some(row => !recordedAttempts.some(saved => saved.nonce === row.nonce && saved.attempt === (row.attempt ?? null)))) block('closure-attempts-changed');
  if (await exists(task.worktree)) block('worktree-reappeared');
  const worktrees = (await git(runtime, repository.main, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  if (worktrees.includes(`worktree ${task.worktree}`) || worktrees.includes(`branch refs/heads/${task.branch}`)
    || (await git(runtime, repository.main, ['for-each-ref', '--format=%(refname)', `refs/heads/${task.branch}`])).trim()) block('delegate-ref-or-registration-reappeared');
  if (await exists(join(directory, 'disposed.json')) || (await readdir(directory)).some(name => name.startsWith('retention-'))) block('other-disposal-history-present');
  const retainedAttemptEvidence = [];
  for (const row of attempts) {
    const path = row.attempt === undefined ? directory : join(directory, 'revisions', row.attempt);
    const evidence = {};
    for (const name of ['submission.json', 'result.json', 'containment.json', ...(row.attempt === undefined ? [] : ['attempt.json'])]) {
      evidence[name] = await exists(join(path, name)) ? await lifecycleJSON(join(path, name)) : null;
    }
    if (hasRetired) {
      const saved = intent.attempts.find(attempt => attempt.nonce === row.nonce);
      if (!equal(saved?.result, evidence['result.json']) || !equal(saved?.containment, evidence['containment.json'])) block('retired-attempt-evidence-changed');
    }
    retainedAttemptEvidence.push(evidence);
  }
  const closure = { original, receipt, intent, ready, attempts, jobs, repository, archiveRoot, retainedAttemptEvidence };
  return { task, kind, policy, root, closedAt, closure, runtime, closureDigest: digest(JSON.stringify(closure)) };
}
// Root-owned machine identity is captured prospectively at enrollment, never
// backfilled into historical worker evidence. Start times fence PID reuse on the
// enrolled boot. A later boot on this SAME enrolled host kills that boot's old
// processes, but does not manufacture terminal statuses or override other gates.
export async function observeAutomaticProcesses(task) {
  const observation = await observeRetirementProcesses(task);
  const host = await open('/etc/machine-id', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let hostIdentity;
  try {
    const st = await host.stat(), text = (await host.readFile('utf8')).trim();
    if (!st.isFile() || st.uid !== 0 || st.mode & 0o022 || !/^[a-f0-9]{32}$/.test(text)) block('host-identity-unavailable');
    hostIdentity = digest(text);
  } finally { await host.close(); }
  // The reference scan already read these identities before/after inspecting
  // each PID. Avoid a second racy /proc pass. Preserve the existing enrollment
  // identity schema; no historical records or consent are rewritten.
  const visibilityRecords = observation.visibilityRecords.map(({ pid, startTime, commandSha256, cgroupSha256 }) =>
    ({ pid, startTime, commandSha256, cgroupSha256 }));
  return { ...observation, hostIdentity, visibilityRecords };
}
function permittedVisibility(current, enrolled) {
  if (current.hostIdentity !== enrolled.hostIdentity) return false;
  if (current.bootId !== enrolled.bootId) return true; // Only the independently enrolled host, with every other gate intact.
  return current.visibilityRecords.every(row => enrolled.visibilityRecords.some(previous => equal(previous, row)));
}
async function backendAndProcesses(closed, observe, processes) {
  const snapshot = await observe(); // A complete fresh snapshot, never caller-supplied tool input.
  if (!snapshot || !uuid.test(snapshot.namespace) || !Array.isArray(snapshot.tasks)) block('backend-snapshot-unavailable');
  for (const [index, job] of closed.closure.jobs.entries()) {
    if (job.namespace !== snapshot.namespace) block('original-backend-namespace-unavailable');
    const matches = snapshot.tasks.filter(row => row.label === job.label);
    // Recycled numeric IDs under different labels are unrelated. A reused label,
    // however, can never be treated as missing or as terminal evidence.
    if (matches.length > 1 || matches.some(row => row.id !== job.id || row.created !== job.created
      || !['EXITED', 'KILLED'].includes(row.phase) || (row.phase === 'EXITED' && !Number.isSafeInteger(row.exitCode)))) block('active-unknown-or-reused-original-job');
    const result = closed.closure.retainedAttemptEvidence[index]['result.json'];
    if (matches[0]?.phase === 'EXITED' && Number.isSafeInteger(result?.code) && matches[0].exitCode !== result.code) block('backend-contradicts-retained-result');
  }
  const observation = await processes(closed.task);
  if (!uuid.test(observation.bootId) || observation.stoppedProof !== false || observation.observation !== 'current-user-process-reference-scan'
    || !sha256.test(observation.hostIdentity) || !Array.isArray(observation.visibilityRecords)
    || !Array.isArray(observation.uninspectablePids) || observation.visibilityRecords.length !== observation.uninspectablePids.length
    || observation.visibilityRecords.some((row, index) => row.pid !== observation.uninspectablePids[index] || !/^\d+$/.test(row.startTime)
      || !sha256.test(row.commandSha256) || !sha256.test(row.cgroupSha256))) block('process-observation-unavailable');
  return observation;
}
const rowStamp = st => [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeNs.toString(), st.ctimeNs.toString()].map(value => String(value));
// Hash and inspect through held directory FDs. No symlink traversal, unbounded
// body loading or credential-bearing content in reports. Enrollment is one-time
// inspection; expiry must see those same sealed bytes and metadata.
async function sealFiles(task, rootIdentity, files) {
  const root = await open(task.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const sealed = []; let total = 0;
  try {
    const st = await root.stat(); if (!equal([st.dev, st.ino], rootIdentity)) block('task-directory-replaced');
    for (const row of files) {
      if (protectedText.test(row.path) || row.shared) block('protected-or-shared-payload');
      if (row.kind === 'directory') { sealed.push(row); continue; }
      if (row.kind === 'symlink') {
        if (protectedText.test(row.target ?? '')) block('protected-symlink-target');
        sealed.push(row); continue; // Inventory binds the link; target is never read/deleted.
      }
      const parts = row.path.split('/'), parents = []; let parent = root;
      try {
        for (const part of parts.slice(0, -1)) {
          if (!part || part === '.' || part === '..') block('unsafe-payload-path');
          parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); parents.push(parent);
        }
        const path = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`;
        const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await fd.stat({ bigint: true });
          if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n || !equal(row.stamp, rowStamp(before))) block('payload-changed-before-inspection');
          total += Number(before.size); if (total > 16 * 1024 ** 3) block('payload-inspection-exceeds-16-gib');
          const hash = createHash('sha256'), buffer = Buffer.alloc(65536), scanner = protectedContentScanner(row.path); let position = 0;
          while (position < Number(before.size)) {
            const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
            if (!bytesRead) block('payload-truncated');
            const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
            try { scanner.push(chunk); } catch { block('potential-protected-operational-content'); }
            position += bytesRead;
          }
          if (!equal(rowStamp(await fd.stat({ bigint: true })), row.stamp) || !equal(rowStamp(await lstat(path, { bigint: true })), row.stamp)) block('payload-changed-during-inspection');
          let contentExceptions;
          try { contentExceptions = scanner.finish(); } catch { block('potential-protected-operational-content'); }
          sealed.push({ ...row, sha256: hash.digest('hex'), ...(contentExceptions.length ? { contentExceptions } : {}) });
        } finally { await fd.close(); }
      } finally { for (const fd of parents.reverse()) await fd.close(); }
    }
  } finally { await root.close(); }
  return sealed;
}
async function inspectRecovery(closed) {
  for (const name of ['source.bundle', 'local-files.json']) {
    const st = await lstat(join(closed.task.directory, closed.kind, name));
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077 || st.nlink !== 1) block('unsafe-recovery-file');
  }
  const archive = await lifecycleJSON(join(closed.task.directory, closed.kind, 'local-files.json'));
  if (archive.version !== 1 || archive.base !== closed.task.base || archive.branch !== closed.task.branch || !Array.isArray(archive.files)
    || archive.files.length > 10000 || typeof archive.patch !== 'string' || !Number.isSafeInteger(archive.bytes) || archive.bytes < 0
    || Object.keys(archive).sort().join(',') !== 'base,branch,bytes,files,patch,version') block('invalid-recovery-archive');
  const bundle = join(closed.task.directory, closed.kind, 'source.bundle');
  await git(closed.runtime, closed.closure.repository.main, ['bundle', 'verify', bundle]);
  if ((await git(closed.runtime, closed.closure.repository.main, ['bundle', 'list-heads', bundle])).trim() !== `${closed.task.base} refs/heads/${closed.task.branch}`) block('unexpected-recovery-bundle-ref');
  let bytes = 0;
  if (protectedText.test(archive.patch)) block('protected-recovery-patch');
  for (const row of archive.files) {
    if (!row || typeof row.name !== 'string' || isAbsolute(row.name) || row.name.split('/').some(part => !part || part === '.' || part === '..')
      || row.name.includes('\0') || protectedText.test(row.name) || protectedText.test(row.symlink ?? '')) block('protected-recovery-entry');
    const keys = Object.keys(row).sort().join(',');
    if (keys === 'deleted,name') { if (row.deleted !== true) block('invalid-deleted-archive-entry'); continue; }
    if (!Number.isSafeInteger(row.mode) || !['base64,mode,name', 'mode,name,symlink'].includes(keys)
      || (keys === 'mode,name,symlink' && typeof row.symlink !== 'string')) block('unknown-recovery-entry-schema');
    if (row.symlink !== undefined) bytes += Buffer.byteLength(row.symlink);
    if (row.base64 !== undefined) {
      if (typeof row.base64 !== 'string') block('invalid-recovery-encoding');
      const body = Buffer.from(row.base64, 'base64'); bytes += body.length;
      if (bytes > (closed.kind === 'retirement' ? 80 : 64) * 1024 * 1024 || body.toString('base64') !== row.base64 || protectedText.test(body.toString('utf8'))) block('protected-or-oversized-decoded-recovery');
    }
  }
  if (bytes !== archive.bytes) block('recovery-byte-count-changed');
  const bound = closed.kind === 'retirement' ? archive : { files: archive.files, bytes: archive.bytes };
  if (digest(JSON.stringify(bound)) !== closed.closure.ready.archiveFingerprint) block('recovery-differs-from-closed-archive');
}
async function payloadSeal(closed, selections) {
  const paths = selections.flatMap(group => pathsFor(closed, group));
  assertNoPayloadMounts(closed.task.directory, paths.map(path => join(closed.task.directory, path)), await readFile('/proc/self/mountinfo', 'utf8'));
  if (selections.includes('recovery')) await inspectRecovery(closed);
  const files = await inventoryPayloads(closed.task, paths);
  if (!selections.every(group => files.some(row => pathsFor(closed, group).includes(row.path)))) block('selected-payload-group-missing');
  const sealed = await sealFiles(closed.task, closed.root, files);
  return Object.fromEntries(selections.map(group => [group, sealed.filter(row => pathsFor(closed, group).some(path => row.path === path || row.path.startsWith(path + '/')))]));
}
function validateSelections(selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2 || new Set(selections).size !== selections.length || selections.some(group => !groups.includes(group))) block('explicit-payload-groups-required');
}
export async function assessAutomaticEnrollment(runtime, input, who, observe, now = Date.now(), processes = observeAutomaticProcesses) {
  validateSelections(input.selections); if (!validWho(who)) block('persistent-enrolling-session-required');
  const closed = await closedTask(runtime, input, now);
  if (await exists(join(closed.task.directory, 'disposal-claim.json')) || await exists(join(closed.task.directory, enrollmentName))) block('disposal-or-enrollment-already-claimed');
  const observation = await backendAndProcesses(closed, observe, processes), seals = await payloadSeal(closed, input.selections);
  const evidence = digest(JSON.stringify({ closure: closed.closureDigest, policy: closed.policy, root: closed.root, seals, observation, caller: identity(who) }));
  const deadlines = Object.fromEntries(input.selections.map(group => [group, new Date(closed.closedAt + DAY * (group === 'build-output' ? closed.policy.buildDays : closed.policy.recoveryDays)).toISOString()]));
  return { ...closed, observation, seals, evidence, deadlines };
}
export function automaticEnrollmentAuthorization(gate, who) {
  return { id: randomUUID(), task: gate.task.id, policy: gate.policy, evidence: gate.evidence, caller: identity(who),
    confirmedAt: new Date().toISOString(), declaration: 'selected closed payloads are disposable after the displayed deadlines; owners/build users idle; visibility gaps investigated; protected content inspected' };
}
export async function enrollAutomaticRetention(runtime, input, who, observe, authorization, guard = () => {}, now = undefined, processes = observeAutomaticProcesses) {
  const clock = now === undefined ? Date.now : () => now;
  now = clock();
  const gate = await assessAutomaticEnrollment(runtime, input, who, observe, now, processes);
  if (!authorization || !uuid.test(authorization.id) || !equal(authorization, { ...automaticEnrollmentAuthorization(gate, who), id: authorization.id, confirmedAt: authorization.confirmedAt })
    || timestamp(authorization.confirmedAt) > now + 5000 || now - timestamp(authorization.confirmedAt) > 300000 || input.expectedEvidence !== gate.evidence) block('fresh-exact-enrollment-authorization-required');
  guard();
  const claim = { version: 1, kind: 'automatic-retention-enrollment', id: authorization.id, task: gate.task.id,
    closure: gate.closureDigest, policy: gate.policy, repository: gate.closure.repository, root: gate.root, authorization, seals: gate.seals,
    deadlines: gate.deadlines, observation: gate.observation };
  // Reserve the EXISTING exclusive disposal slot. Ordinary tools will reject this
  // different kind, not reinterpret it as completed ordinary disposal.
  await saveRecord(join(gate.task.directory, 'disposal-claim.json'), claim);
  guard();
  const closed = await closedTask(runtime, input, now);
  if (closed.closureDigest !== gate.closureDigest || !equal(await backendAndProcesses(closed, observe, processes), gate.observation)
    || !equal(await payloadSeal(closed, input.selections), gate.seals)) block('evidence-changed-after-enrollment-claim');
  guard();
  const receipt = { version: 1, kind: 'automatic-retention-enrollment-receipt', task: gate.task.id, claim: digest(JSON.stringify(claim)),
    enrollment: claim.id, enrolledAt: new Date(clock()).toISOString() };
  await saveRecord(join(gate.task.directory, enrollmentName), receipt);
  return { ...receipt, deadlines: gate.deadlines, policy: gate.policy, authority: 'explicit-enrollment-for-automatic-expiry' };
}

async function enrolledTask(runtime, taskId, observe, now, processes) {
  const directory = join(runtime.state, taskId), claim = await lifecycleJSON(join(directory, 'disposal-claim.json'));
  if (claim.kind !== 'automatic-retention-enrollment' || claim.version !== 1 || claim.task !== taskId || !uuid.test(claim.id)
    || !equal(claim.policy, automaticPolicy(runtime))) block('not-enrolled-under-current-policy');
  const input = { task: taskId, repository: claim.repository?.main };
  const closed = await closedTask(runtime, input, now);
  const receipt = await lifecycleJSON(join(directory, enrollmentName));
  if (receipt.version !== 1 || receipt.kind !== 'automatic-retention-enrollment-receipt' || receipt.task !== taskId || receipt.enrollment !== claim.id
    || receipt.claim !== digest(JSON.stringify(claim)) || timestamp(receipt.enrolledAt) > now || closed.closureDigest !== claim.closure
    || !equal(closed.root, claim.root) || !equal(closed.closure.repository, claim.repository)) block('incomplete-or-changed-enrollment');
  const selected = Object.keys(claim.seals); validateSelections(selected);
  const expectedEvidence = digest(JSON.stringify({ closure: closed.closureDigest, policy: closed.policy, root: closed.root, seals: claim.seals,
    observation: claim.observation, caller: claim.authorization?.caller }));
  if (claim.authorization?.task !== taskId || claim.authorization.id !== claim.id || claim.authorization.evidence !== expectedEvidence
    || !equal(claim.authorization.policy, claim.policy) || !validWho(claim.authorization.caller)
    || timestamp(claim.authorization.confirmedAt) > timestamp(receipt.enrolledAt) + 5000) block('enrollment-authorization-changed');
  const observation = await backendAndProcesses(closed, observe, processes);
  // New same-boot visibility gaps/PID reuse and a different host stay blocked.
  // A real subsequent boot of the prospectively enrolled host does not require
  // interpreting an old cgroup; source/ref absence and sealed data still apply.
  if (!permittedVisibility(observation, claim.observation)) block('process-visibility-or-host-changed-needs-operator-review');
  const names = await readdir(directory), known = new Set([enrollmentName, ...groups.flatMap(group => [groupClaim(group), groupReceipt(group)])]);
  if (names.some(name => name.startsWith('automatic-retention-') && !known.has(name))) block('unknown-automatic-retention-record');
  const completed = new Set();
  for (const group of groups) {
    const claimed = await exists(join(directory, groupClaim(group))), done = await exists(join(directory, groupReceipt(group)));
    if (claimed !== done) block('interrupted-automatic-disposal-no-retry');
    if (!claimed) continue;
    const attempt = await lifecycleJSON(join(directory, groupClaim(group))), result = await lifecycleJSON(join(directory, groupReceipt(group)));
    if (!selected.includes(group) || attempt.kind !== 'automatic-retention-payload-disposal' || attempt.task !== taskId || attempt.enrollment !== claim.id
      || attempt.group !== group || !uuid.test(attempt.id) || !equal(attempt.files, claim.seals[group]) || result.kind !== 'automatic-retention-payload-receipt'
      || result.operation !== attempt.id || result.task !== taskId || result.group !== group || result.enrollment !== claim.id
      || result.claim !== digest(JSON.stringify(attempt)) || result.entriesRemoved !== attempt.files.length
      || result.unlinkedAllocatedBytes !== attempt.files.reduce((sum, row) => sum + (row.shared ? 0 : row.allocatedBytes), 0)
      || timestamp(result.completedAt) > now || timestamp(result.completedAt) < timestamp(attempt.claimedAt)) block('mismatched-automatic-disposal-history');
    if ((await inventoryPayloads(closed.task, pathsFor(closed, group))).length) block('removed-payload-reappeared');
    completed.add(group);
  }
  const pending = selected.filter(group => !completed.has(group));
  for (const group of selected) {
    const due = closed.closedAt + DAY * (group === 'build-output' ? claim.policy.buildDays : claim.policy.recoveryDays);
    if (claim.deadlines[group] !== new Date(due).toISOString()) block('expiry-deadline-changed');
  }
  if (pending.length && !equal(await payloadSeal(closed, pending), Object.fromEntries(pending.map(group => [group, claim.seals[group]])))) block('enrolled-payload-changed');
  return { closed, claim, due: pending.filter(group => timestamp(claim.deadlines[group]) <= now), pending };
}
export async function runAutomaticRetention(runtime, { apply = false } = {}, observe, now = undefined, processes = observeAutomaticProcesses, guard = () => {}) {
  const clock = now === undefined ? Date.now : () => now;
  now = clock();
  if (typeof apply !== 'boolean' || !Number.isFinite(now)) block('explicit-run-mode-and-valid-time-required');
  const policy = automaticPolicy(runtime); await privateDirectory(runtime.state);
  const names = (await readdir(runtime.state)).filter(name => uuid.test(name)).sort();
  if (names.length > 10000) block('task-inventory-too-large');
  const report = { version: 1, mode: apply ? 'apply' : 'dry-run', policy, checkedAt: new Date(now).toISOString(), tasks: [], removedGroups: 0 };
  for (const task of names) {
    const removed = [];
    try {
      const directory = join(runtime.state, task);
      await privateDirectory(directory);
      if (!await exists(join(directory, enrollmentName))) {
        if (await exists(join(directory, 'disposal-claim.json')) && (await lifecycleJSON(join(directory, 'disposal-claim.json'))).kind === 'automatic-retention-enrollment') block('incomplete-enrollment-no-retry');
        continue;
      }
      const gate = await enrolledTask(runtime, task, observe, clock(), processes);
      if (apply) for (const group of gate.due) {
        // Re-evaluate each group, including the first group's completed receipt.
        const fresh = await enrolledTask(runtime, task, observe, clock(), processes);
        if (!fresh.due.includes(group)) block('expiry-state-changed');
        const files = fresh.claim.seals[group], id = randomUUID(); guard();
        const claim = { version: 1, kind: 'automatic-retention-payload-disposal', id, task, group, enrollment: fresh.claim.id,
          files, claimedAt: new Date(clock()).toISOString() };
        await saveRecord(join(fresh.closed.task.directory, groupClaim(group)), claim);
        // The full gate intentionally rejects our pending claim. Revalidate the
        // closure/backend/visibility and selected exact sealed payload separately.
        const closed = await closedTask(runtime, { task, repository: fresh.claim.repository.main }, clock());
        const visibility = await backendAndProcesses(closed, observe, processes);
        if (closed.closureDigest !== fresh.claim.closure || !permittedVisibility(visibility, fresh.claim.observation)
          || !equal((await payloadSeal(closed, [group]))[group], files)) block('evidence-changed-after-automatic-claim');
        guard(); const unlinkedAllocatedBytes = await removePayloadInventory(closed.task, files, guard, closed.root);
        if ((await inventoryPayloads(closed.task, pathsFor(closed, group))).length || !equal(await privateDirectory(closed.task.directory), closed.root)) block('partial-payload-removal');
        const receipt = { version: 1, kind: 'automatic-retention-payload-receipt', operation: id, task, group, enrollment: fresh.claim.id,
          claim: digest(JSON.stringify(claim)), entriesRemoved: files.length, unlinkedAllocatedBytes, completedAt: new Date(clock()).toISOString(),
          accounting: 'Observed unlinked allocation, not guaranteed free-space reclamation; audit records, sharing, snapshots and open files remain.' };
        await saveRecord(join(closed.task.directory, groupReceipt(group)), receipt); removed.push(group); report.removedGroups++;
      }
      report.tasks.push({ task, status: removed.length ? 'removed' : gate.due.length ? 'eligible' : 'retained', due: gate.due, removed });
    } catch (error) { report.tasks.push({ task, status: 'skipped', removed, reason: error.retentionReason ?? 'unsafe-or-unavailable-evidence' }); }
  }
  return report;
}

export function configuredAutomaticObserver(env = process.env) {
  const config = configuration(env); if (!config) block('pueue-configuration-unavailable');
  const backend = new Backend(config);
  return async () => { await backend.check(); return { namespace: config.namespace, tasks: await backend.tasks() }; };
}
// No processes on module load. The immutable Nix launcher supplies a minimal
// explicit environment and holds flock around this entire bounded invocation.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== '--runtime' || !isAbsolute(args[1]) || args.length > 3 || (args[2] !== undefined && args[2] !== '--apply')) {
    throw new Error('Usage: automatic-retention.mjs --runtime ABSOLUTE_RUNTIME [--apply]');
  }
  const runtime = await runtimeFrom(args[1]);
  console.log(JSON.stringify(await runAutomaticRetention(runtime, { apply: args[2] === '--apply' }, configuredAutomaticObserver()), null, 2));
}
