// Explicit foreground custody, not Pueue adoption or a worker retry. Immutable
// manifests/history stay untouched; a shared permanent continuation claim fences
// stale cooperating sessions. No live provider, daemon or worktree mutations.
import { constants } from 'node:fs';
import { open, lstat, opendir, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENTRY, digest, snapshot, git } from './core.mjs';
import { assertStopped } from './containment.mjs';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = who => ({ session: who?.session, file: who?.file });
const equalOwner = (a, b) => same(identity(a), identity(b));
const claimPath = task => join(task.directory, `revision-after-${digest(task.nonce)}.json`);
const receiptPath = task => join(task.directory, 'reconciliation.json');
async function missing(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function directory(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077
    || await realpath(path) !== path) throw new Error('Reconciliation requires canonical private directories');
}
// Bounds and O_NOFOLLOW apply to history too: never read credential files, accept
// a symlink/FIFO or echo arbitrary history/parse errors into model-facing output.
async function privateText(path, limit = 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > limit) throw new Error('Unsafe/oversized reconciliation evidence');
    const data = Buffer.alloc(st.size + 1), { bytesRead } = await fd.read(data, 0, data.length, 0);
    if (bytesRead !== st.size || (await fd.stat()).size !== st.size) throw new Error('Evidence changed during read');
    return data.subarray(0, bytesRead).toString('utf8');
  } finally { await fd.close(); }
}
async function privateJSON(path) {
  try { return JSON.parse(await privateText(path)); }
  catch (error) { if (error.code === 'ENOENT') throw error; throw new Error('Invalid/private reconciliation evidence required'); }
}
async function durable(path, value) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  const dir = await open(resolve(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
function ownerValid(who) {
  return typeof who?.session === 'string' && who.session.length > 0 && who.session.length <= 200
    && typeof who.file === 'string' && isAbsolute(who.file);
}
const taskKeys = ['id', 'owner', 'directory', 'repo', 'worktree', 'base', 'branch', 'sourceHead', 'sourceFingerprint',
  'sourceTree', 'backend', 'route', 'model', 'thinking', 'profile', 'checks', 'verification'];
function taskEqual(a, b) { return taskKeys.every(key => same(a[key], b[key])); }
const taskHash = task => digest(JSON.stringify([...taskKeys, 'nonce'].map(key => [key, task[key] ?? null])));
function ancestors(entry, entries) {
  const result = [];
  for (let parent = entry.parentId; parent !== null;) {
    const node = entries.get(parent);
    if (!node || result.length >= entries.size) throw new Error('Broken original session ancestry');
    result.push(node); parent = node.parentId;
  }
  return result.reverse();
}
async function archived(task, nonce) {
  let text, lines;
  try {
    text = await privateText(task.owner.file, 64 * 1024 * 1024);
    lines = text.trimEnd().split('\n').map(line => JSON.parse(line));
  } catch { throw new Error('Original private session history unavailable/invalid; no inferred terminal result'); }
  const header = lines.shift();
  if (header?.type !== 'session' || header.version !== 3 || header.id !== task.owner.session || lines.length > 200000) throw new Error('Original session identity/schema mismatch');
  const entries = new Map();
  for (const entry of lines) {
    if (typeof entry.id !== 'string' || !entry.id || entries.has(entry.id)
      || !(entry.parentId === null || entries.has(entry.parentId))) throw new Error('Invalid original session tree');
    entries.set(entry.id, entry);
    if (entry.type === 'custom' && entry.customType === ENTRY && entry.data?.id === task.id
      && (!taskEqual(task, entry.data) || entry.data.attempt !== undefined
        || entry.data.finalized || (entry.data.nonce !== undefined && entry.data.nonce !== nonce))) {
      throw new Error('Conflicting task/attempt history; explicit investigation required');
    }
  }
  const reviews = [];
  for (const entry of lines) {
    const message = entry.message;
    if (entry.type !== 'message' || message?.role !== 'toolResult' || message.toolName !== 'delegate_review' || message.isError !== false) continue;
    let review;
    try { review = JSON.parse(message.content.map(b => b.type === 'text' ? b.text : '').join('\n')); } catch { continue; }
    if (review.task !== task.id) continue;
    // Later foreground collections are diagnostic, never new backend evidence.
    if (review.status?.phase === 'RECONCILED_EXITED' && review.status.backendAuthority === false) continue;
    if (review.attempt != null || review.status?.nonce !== nonce || review.worktree !== task.worktree
      || review.baseline?.base !== task.base || review.status.phase !== 'EXITED'
      || !Number.isSafeInteger(review.status.exitCode)) throw new Error('Conflicting archived review evidence');
    const branch = ancestors(entry, entries);
    const call = branch.flatMap(e => e.type === 'message' && e.message?.role === 'assistant' && Array.isArray(e.message.content) ? e.message.content : [])
      .filter(b => b.type === 'toolCall' && b.id === message.toolCallId);
    if (call.length !== 1 || call[0].name !== 'delegate_review' || call[0].arguments?.task !== task.id) throw new Error('Archived review lacks bound originating tool call');
    const tasks = branch.filter(e => e.type === 'custom' && e.customType === ENTRY && e.data?.id === task.id);
    if (!tasks.length || tasks.at(-1).data.nonce !== nonce || !taskEqual(task, tasks.at(-1).data)) throw new Error('Archived review lacks owning branch task');
    const jobs = branch.filter(e => e.type === 'custom' && e.customType === 'pi-repo.pueue.job.v1' && e.data?.nonce === nonce);
    const job = jobs.at(-1)?.data;
    if (!job || job.session !== task.owner.session || job.file !== task.owner.file || !uuid.test(job.namespace)
      || job.label !== `pi:${job.namespace}:${nonce}` || job.admitted !== true
      || !Number.isSafeInteger(job.id) || job.id < 0 || job.id !== review.status.id
      || typeof job.created !== 'string' || !Number.isFinite(Date.parse(job.created))) throw new Error('Archived backend admission identity incomplete');
    const canceled = lines.some(e => e.type === 'custom' && e.customType === 'pi-repo.pueue.job.v1'
      && e.data?.nonce === nonce && e.data.cancellationRequested === true);
    const status = { nonce, id: job.id, phase: 'EXITED', exitCode: review.status.exitCode,
      ...(canceled || review.status.cancellationRequested ? { cancellationRequested: true } : {}) };
    reviews.push({ entry: entry.id, job: { session: job.session, file: job.file, namespace: job.namespace,
      nonce, id: job.id, label: job.label, created: job.created, admitted: true }, status, worker: review.worker,
      bindingHash: digest(JSON.stringify([header, tasks.at(-1), jobs.at(-1), call[0], entry])) });
  }
  if (!reviews.length) throw new Error('No original successful terminal delegate_review record; handoffs/logs/result.json alone are insufficient');
  if (reviews.some(r => r.status.exitCode !== reviews[0].status.exitCode || !same(r.job, reviews[0].job))) throw new Error('Contradictory archived terminal evidence');
  const selected = reviews.at(-1);
  for (const entry of lines) if (entry.type === 'custom' && entry.customType === 'pi-repo.pueue.job.v1' && entry.data?.nonce === nonce) {
    const job = entry.data;
    if (['session', 'file', 'namespace', 'label'].some(key => job[key] !== selected.job[key])
      || (job.id !== undefined && job.id !== selected.job.id) || (job.created !== undefined && job.created !== selected.job.created)
      || job.admitted === false) throw new Error('Conflicting original backend identity history');
  }
  // Bind the original evidence, NOT unrelated appended chat. In the original
  // session the assessment's own tool result necessarily extends this file.
  return { ...selected, historyHash: digest(JSON.stringify([selected.bindingHash, selected.status])) };
}
async function boundedNames(path) {
  const names = [];
  for await (const entry of await opendir(path)) {
    if (names.length >= 1024) throw new Error('Too many retained artifacts for reconciliation');
    names.push(entry.name);
  }
  return names;
}
async function retained(runtime, id) {
  if (!uuid.test(id) || runtime.containmentProtocol !== 1 || runtime.reconciliationProtocol !== 1) throw new Error('Full task UUID and explicitly enabled scoped reconciliation runtime required');
  await directory(runtime.state);
  const root = join(runtime.state, id); await directory(root);
  const task = await privateJSON(join(root, 'task.json'));
  if (task.version !== 1 || task.id !== id || task.directory !== root || task.branch !== `delegate/${id}`
    || !ownerValid(task.owner) || !isAbsolute(task.repo) || !isAbsolute(task.worktree)
    || task.worktree === task.repo || await realpath(task.repo) !== task.repo
    || resolve(task.worktree, '..') !== task.repo + '.worktrees' || !task.worktree.endsWith(id)) throw new Error('Retained task identity/path mismatch');
  // V1 intentionally handles original attempts only. Never select a convenient
  // ancestor while a revision, finalization or admission may remain uncertain.
  const names = await boundedNames(root);
  if (names.some(name => name === 'revisions' || name === 'finalization' || name === 'finalized.json')) throw new Error('Revision/finalization history requires separate reconciliation');
  const submission = await privateJSON(join(root, 'submission.json'));
  if (!uuid.test(submission.nonce)) throw new Error('Exact submission nonce required');
  const common = async path => realpath(resolve(path, (await git(runtime, path, ['rev-parse', '--git-common-dir'])).trim()));
  if (await common(task.repo) !== await common(task.worktree)) throw new Error('Retained worktree repository changed');
  return { ...task, nonce: submission.nonce };
}
async function observeArchive(archive, observe) {
  // The callback is internal, never tool-supplied: it checks the configured
  // namespace and projects a complete fresh backend snapshot before matching.
  const current = await observe(archive.job);
  if (current !== null && (current.nonce !== archive.job.nonce || current.phase !== 'EXITED'
    || current.exitCode !== archive.status.exitCode)) throw new Error('Live backend contradicts archived terminal evidence');
  return current;
}
export async function assessReconciliation(runtime, input, who, observe, stopped = assertStopped) {
  if (!ownerValid(who)) throw new Error('Persistent receiving session required');
  const task = await retained(runtime, input.task), archive = await archived(task, task.nonce);
  const worker = await privateJSON(join(task.directory, 'result.json'));
  if (!same(worker, archive.worker) || worker.code !== archive.status.exitCode || worker.signal
    || worker.integrityError || worker.workerError || !hash.test(worker.fingerprint)) throw new Error('Worker result differs from archived terminal evidence');
  const current = await observeArchive(archive, observe), proof = await stopped(task);
  const fingerprint = await snapshot(task, runtime);
  let receipt = null;
  if (!await missing(receiptPath(task))) {
    receipt = await privateJSON(receiptPath(task));
    await assertCustody({ ...task, reconciliationId: receipt.id, custodian: who }, who);
  } else if (!await missing(claimPath(task))) throw new Error('Continuation already claimed or reconciliation interrupted; no automatic claim release');
  const evidence = { kind: 'original-session-terminal-review-v1', session: task.owner.session, file: task.owner.file,
    entry: archive.entry, historyHash: archive.historyHash, job: archive.job, terminal: archive.status,
    resultHash: digest(JSON.stringify(worker)), taskHash: taskHash(task),
    containmentHash: digest(JSON.stringify(await privateJSON(join(task.directory, 'containment.json')))) };
  const evidenceDigest = digest(JSON.stringify([evidence, fingerprint, identity(who), receipt?.id ?? null]));
  return { task, fingerprint, evidenceDigest, evidence, current, stopped: proof, receipt };
}
export async function assertCustody(task, who) {
  if (!await missing(receiptPath(task))) {
    const receipt = await privateJSON(receiptPath(task)), claim = await privateJSON(claimPath(task));
    if (receipt.version !== 1 || !uuid.test(receipt.id) || receipt.task !== task.id || receipt.nonce !== task.nonce
      || receipt.id !== task.reconciliationId || !equalOwner(receipt.to, who) || !equalOwner(task.custodian, who)
      || !equalOwner(receipt.from, task.owner) || claim.reconciliation !== receipt.id
      || receipt.authority !== 'foreground-only' || claim.previousNonce !== task.nonce || receipt.evidence?.taskHash !== taskHash(task)
      || claim.expectedEvidence !== digest(JSON.stringify([receipt.evidence, receipt.fingerprint, identity(receipt.to), null]))
      || !equalOwner(claim.to, receipt.to) || receipt.authorization?.id !== receipt.id
      || receipt.authorization?.evidence !== claim.expectedEvidence || receipt.authorization?.task !== task.id
      || receipt.authorization?.nonce !== task.nonce || receipt.authorization?.fingerprint !== receipt.fingerprint
      || !equalOwner(receipt.authorization?.to, receipt.to)) {
      throw new Error('Task custody transferred or reconciliation binding changed');
    }
    return receipt;
  }
  if (task.reconciliationId || !equalOwner(task.owner, who)) throw new Error('Task is not owned by this session');
  if (task.nonce && !await missing(claimPath(task)) && (await privateJSON(claimPath(task))).reconciliation) throw new Error('Reconciliation pending; retain evidence, no automatic takeover');
  return null;
}
export function reconciliationAuthorization(input, who) {
  return { id: randomUUID(), task: input.task, nonce: input.expectedNonce, fingerprint: input.expectedFingerprint,
    evidence: input.expectedEvidence, to: identity(who), confirmedAt: new Date().toISOString() };
}
export async function transferReconciliation(runtime, input, who, observe, authorization, guard = () => {}, stopped = assertStopped) {
  const gate = await assessReconciliation(runtime, input, who, observe, stopped);
  if (input.expectedNonce !== gate.task.nonce || input.expectedFingerprint !== gate.fingerprint
    || input.expectedEvidence !== gate.evidenceDigest) throw new Error('Reconciliation assessment/source changed; inspect again');
  if (!authorization || !uuid.test(authorization.id) || !Number.isFinite(Date.parse(authorization.confirmedAt))
    || authorization.task !== input.task || authorization.nonce !== input.expectedNonce
    || authorization.fingerprint !== input.expectedFingerprint || authorization.evidence !== input.expectedEvidence
    || !equalOwner(authorization.to, who)) throw new Error('Fresh bound interactive reconciliation authorization required');
  guard();
  if (gate.receipt) return { task: { ...gate.task, custodian: gate.receipt.to, reconciliationId: gate.receipt.id }, receipt: gate.receipt, restored: true };
  const id = authorization.id;
  // This is the SAME exclusive claim used by revise/resume/finalize. Losing a
  // race, a failed fsync, abort or partial receipt never releases it automatically.
  await durable(claimPath(gate.task), { reconciliation: id, previousNonce: gate.task.nonce,
    expectedEvidence: input.expectedEvidence, to: identity(who) });
  guard();
  // Recheck source, all original evidence, containment and backend after claiming.
  // Receipt not yet present: assess would reject the pending claim intentionally.
  const archive = await archived(gate.task, gate.task.nonce);
  await observeArchive(archive, observe); await stopped(gate.task);
  if (archive.historyHash !== gate.evidence.historyHash || await snapshot(gate.task, runtime) !== gate.fingerprint
    || !same(await retained(runtime, input.task), gate.task)
    || digest(JSON.stringify(await privateJSON(join(gate.task.directory, 'result.json')))) !== gate.evidence.resultHash
    || digest(JSON.stringify(await privateJSON(join(gate.task.directory, 'containment.json')))) !== gate.evidence.containmentHash) throw new Error('Evidence changed after claim; retain pending reconciliation');
  guard();
  const receipt = { version: 1, id, task: gate.task.id, nonce: gate.task.nonce, from: identity(gate.task.owner), to: identity(who),
    authority: 'foreground-only', confirmedAt: authorization.confirmedAt, authorization, fingerprint: gate.fingerprint,
    evidence: gate.evidence, stopped: gate.stopped, accepted: false };
  await durable(receiptPath(gate.task), receipt);
  return { task: { ...gate.task, custodian: receipt.to, reconciliationId: id }, receipt, restored: false };
}
export async function reconciledStatus(task, runtime, who, observe, stopped = assertStopped) {
  const receipt = await assertCustody(task, who);
  if (!receipt) throw new Error('No reconciled foreground grant');
  const original = await retained(runtime, task.id);
  if (!taskEqual(original, task) || original.nonce !== task.nonce) throw new Error('Retained manifest changed after reconciliation');
  if (digest(JSON.stringify(await privateJSON(join(task.directory, 'result.json')))) !== receipt.evidence.resultHash
    || digest(JSON.stringify(await privateJSON(join(task.directory, 'containment.json')))) !== receipt.evidence.containmentHash) throw new Error('Reconciled evidence changed');
  await observeArchive({ job: receipt.evidence.job, status: receipt.evidence.terminal }, observe);
  await stopped(task);
  return { ...receipt.evidence.terminal, phase: 'RECONCILED_EXITED', reconciliationId: receipt.id,
    provenance: receipt.evidence.kind, backendAuthority: false };
}
export function reconciliationSummary(gate) {
  return { task: gate.task.id, expectedNonce: gate.task.nonce, expectedFingerprint: gate.fingerprint, expectedEvidence: gate.evidenceDigest,
    originalOwner: identity(gate.task.owner), worktree: gate.task.worktree, artifacts: gate.task.directory,
    terminal: gate.evidence.terminal, provenance: gate.evidence.kind, backendPresent: gate.current !== null,
    stopped: gate.stopped.observed, authority: 'foreground-only', alreadyTransferred: !!gate.receipt,
    instruction: 'Review the assessment, then call again with all three expected fields for fresh interactive confirmation. No worker retry, acceptance, cleanup, integration or publication is authorized.' };
}
