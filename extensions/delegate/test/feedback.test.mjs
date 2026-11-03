import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENTRY, privateDir, save } from '../core.mjs';
import { validateFeedback, feedbackTask, writeFeedback } from '../feedback.mjs';

const who = { session: 'caller', file: '/caller.jsonl' };
const input = (task = randomUUID()) => ({ task, expectedNonce: 'job-nonce', reviewStatus: 'not_reviewed',
  usefulness: 'not_assessed', correctness: 'not_assessed', instructionFollowing: 'not_assessed',
  reviewEffort: 'not_assessed', wouldDelegateAgain: 'unsure', rationale: 'Worker failed before producing reviewable changes.',
  evidence: ['Job failed with exit 7.'], problems: ['Provider failure'], improvements: [] });
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'delegate-feedback-'));
  try {
    const runtime = { state: join(root, 'state') }, id = randomUUID();
    const task = { id, directory: join(runtime.state, id), owner: who, nonce: 'job-nonce',
      repo: '/not/a/live/repository', base: 'a'.repeat(40), model: 'fixture/model', thinking: 'low',
      profile: 'fixture', checks: [{ kind: 'test', targets: ['unit:test'] }] };
    await privateDir(task.directory); await save(join(task.directory, 'task.json'), task);
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce });
    await fn({ root, runtime, task, assessment: input(id), terminal: [{ nonce: task.nonce, phase: 'EXITED', exitCode: 7 }] });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('bounded explicit feedback validates unknowns without defaults or arbitrary field copying', () => {
  const value = input();
  for (const patch of [{ task: '../escape' }, { expectedNonce: '' }, { supersedes: '../escape' }, { reviewedFingerprint: 'bad' },
    { correctness: undefined }, { usefulness: 'great' }, { rationale: ' ' }, { rationale: 'x'.repeat(4001) },
    { evidence: [''] }, { problems: Array(13).fill('problem') }, { improvements: ['x'.repeat(1001)] }]) {
    assert.throws(() => validateFeedback({ ...value, ...patch }));
  }
  const assessment = validateFeedback({ ...value, prompt: 'SECRET', accepted: true });
  assert.equal(assessment.usefulness, 'not_assessed');
  assert.doesNotMatch(JSON.stringify(assessment), /SECRET|accepted/);
});
test('exact historical nonce ownership excludes forks, abandoned branches and unbound attempts', () => {
  const value = input(), old = { id: value.task, owner: who, nonce: value.expectedNonce };
  const entry = data => ({ type: 'custom', customType: ENTRY, data });
  assert.deepEqual(feedbackTask([entry(old), entry({ ...old, attempt: randomUUID(), nonce: 'new' })], who, value), old);
  for (const entries of [[], [entry({ ...old, nonce: undefined })], [entry({ ...old, owner: { ...who, session: 'fork' } })],
    [entry({ ...old, owner: { ...who, file: '/different.jsonl' } })]]) {
    assert.throws(() => feedbackTask(entries, who, value), /not owned/);
  }
});
test('failed attempts need no worker result/worktree; immutable records retain automatic metadata and private modes', () => fixture(async f => {
  const first = await writeFeedback(f.runtime, f.task, f.assessment, f.terminal, { session: who.session, model: 'caller/model' });
  const text = await readFile(first.path, 'utf8'), record = JSON.parse(text);
  assert.equal(record.schemaVersion, 1); assert.equal(record.accepted, false); assert.equal(record.attempt, null);
  assert.equal(record.caller.model, 'caller/model'); assert.equal(record.execution.exitCode, 7);
  assert.equal(record.invocation.base, f.task.base); assert.equal(record.invocation.thinking, 'low');
  assert.deepEqual(record.invocation.checks, f.task.checks);
  assert.equal(record.assessment.correctness, 'not_assessed');
  assert.equal(record.artifacts.metrics, join(f.task.directory, 'metrics.jsonl'));
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.task.directory, 'feedback'))).mode & 0o777, 0o700);
  const second = await writeFeedback(f.runtime, f.task, { ...f.assessment, supersedes: first.id, rationale: 'Corrected observation.' }, f.terminal, who);
  assert.notEqual(second.id, first.id); assert.equal(JSON.parse(await readFile(second.path, 'utf8')).supersedes, first.id);
  assert.equal(await readFile(first.path, 'utf8'), text);
  assert.equal((await readdir(join(f.task.directory, 'feedback'))).length, 2);
}));
test('unknown, absent and active status never creates an assessment; KILLED is only a diagnostic state', () => fixture(async f => {
  for (const rows of [[], [{ nonce: 'other', phase: 'EXITED' }], ...['UNKNOWN', 'ADMISSION_UNKNOWN', 'RUNNING', 'QUEUED', 'PAUSED'].map(phase => [{ nonce: f.task.nonce, phase }])]) {
    await assert.rejects(writeFeedback(f.runtime, f.task, f.assessment, rows, who), /known terminal/);
  }
  await assert.rejects(readdir(join(f.task.directory, 'feedback')), /ENOENT/);
  const killed = await writeFeedback(f.runtime, f.task, f.assessment, [{ nonce: f.task.nonce, phase: 'KILLED', cancellationRequested: true }], who);
  const record = JSON.parse(await readFile(killed.path, 'utf8'));
  assert.deepEqual(record.execution, { phase: 'KILLED', exitCode: null, cancellationRequested: true });
  assert.equal(record.accepted, false);
}));
test('submission/manifest bindings and cancellation guard block writes; feedback symlinks are rejected', () => fixture(async f => {
  const write = (task = f.task, value = f.assessment, guard) => writeFeedback(f.runtime, task, value, f.terminal, who, guard);
  await assert.rejects(write({ ...f.task, directory: f.root }), /identity mismatch/);
  await assert.rejects(write({ ...f.task, owner: { ...who, session: 'foreign' } }), /manifest identity/);
  await assert.rejects(write(f.task, { ...f.assessment, supersedes: randomUUID() }), /ENOENT/);
  await assert.rejects(write(f.task, f.assessment, () => { throw new Error('cancelled'); }), /cancelled/);
  assert.deepEqual(await readdir(join(f.task.directory, 'feedback')), []);
  await rm(join(f.task.directory, 'feedback'), { recursive: true });
  const outside = join(f.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(f.task.directory, 'feedback'));
  await assert.rejects(write(), /not a symlink/);
  assert.deepEqual(await readdir(outside), []);
}));
