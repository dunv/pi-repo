// Local fixtures only: no models, live jobs, activation or real cgroup mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepare, prepareRevision, snapshot, save, json, digest, attemptDirectory, ENTRY } from '../core.mjs';
import { scopeName } from '../containment.mjs';
import { finalizationGate, finalizationAuthorization, finalizeTask } from '../finalize.mjs';
import { disposalGate, disposalAuthorization, disposeTask, assertNoPayloadMounts } from '../dispose.mjs';
import { inventory } from '../../../skills/delegate-cleanup/scripts/inventory.mjs';

const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const who = { session: 'finalize-session', file: '/fixture/session.jsonl' };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-finalize-')), repo = join(dir, 'repo');
  const g = (...args) => execFileSync(git, ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    execFileSync(git, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    await writeFile(join(repo, '.gitignore'), '*.ignored\n');
    g('add', '.'); g('-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial');
    // Dirty inherited baseline is deliberately NOT merged into the parent.
    await writeFile(join(repo, 'inherited.txt'), 'inherited source\n');
    const runtime = { git, node: process.execPath, pi: '/fixture/pi', claude: '/fixture/claude', flock: '/fixture/flock',
      ssh: '/fixture/ssh', home: dir, state: join(dir, 'state'), launcher: '/fixture/launcher', path: process.env.PATH,
      revisionProtocol: 1, containmentProtocol: 1, finalizationProtocol: 1, systemdRun: '/fixture/systemd-run',
      profiles: { fixture: { command: '/fixture/check', args: ['{kind}', '{targets}'] } } };
    const task = { ...await prepare({ repo, model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [], brief: 'Fixture.' }, runtime, who), nonce: 'initial-job' };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce });
    const contain = async (attempt) => save(join(attemptDirectory(task, attempt), 'containment.json'), {
      version: 1, task: task.id, attempt: attempt ?? null, scope: scopeName(task.id, attempt),
      cgroup: `/user.slice/user-${process.getuid()}.slice/fixture/${scopeName(task.id, attempt)}`,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), inode: 123, device: 27,
    }); // Production assertStopped sees this unique fixture cgroup is absent.
    await contain();
    await writeFile(join(task.worktree, 'source.txt'), 'worker change\n');
    await writeFile(join(task.worktree, 'binary.dat'), Buffer.from([0, 255, 1]));
    await writeFile(join(task.worktree, 'secret.ignored'), 'ignored data must survive\n');
    await symlink('/outside/target', join(task.worktree, 'link'));
    await mkdir(join(task.directory, 'feedback'));
    const feedbackPath = join(task.directory, 'feedback', randomUUID() + '.json');
    const input = { task: task.id, expectedNonce: task.nonce, expectedFingerprint: await snapshot(task, runtime), disposition: 'integrated' };
    const feedback = async (currentTask = task, currentInput = input) => writeFile(feedbackPath, JSON.stringify({ task: task.id,
      nonce: currentTask.nonce, attempt: currentTask.attempt ?? null, reviewedFingerprint: currentInput.expectedFingerprint,
      assessment: { reviewStatus: 'reviewed', correctness: 'good' } }));
    await feedback();
    const rows = [{ nonce: task.nonce, phase: 'EXITED', exitCode: 0 }];
    const authorize = async (t = task, i = input, statuses = rows) => finalizationAuthorization(t, i, await finalizationGate(t, i, runtime, statuses));
    await fn({ dir, repo, g, runtime, task, input, rows, feedback, contain, authorize, feedbackPath });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function disposable(f) {
  f.runtime.disposalProtocol = 1;
  const output = join(f.task.directory, 'build-output');
  await mkdir(output); await mkdir(join(output, 'nested'));
  await writeFile(join(output, 'nested', 'cache'), 'build cache');
  const outside = join(f.dir, 'shared-sdk'); await mkdir(outside);
  await writeFile(join(outside, 'protected'), 'never remove shared targets');
  await symlink(outside, join(output, 'sdk'));
  const receipt = await finalizeTask(f.task, f.input, f.runtime, f.rows, await f.authorize());
  const task = { ...f.task, finalized: receipt };
  const input = { task: task.id, expectedNonce: task.nonce, expectedFinalization: digest(JSON.stringify(receipt)), selections: ['build-output', 'recovery'] };
  const context = { who, statuses: async () => f.rows };
  const gate = await disposalGate(task, input, f.runtime, context);
  return { task, input, context, gate, outside, output, authorization: disposalAuthorization(task, input, gate) };
}

test('mount inventory rejects same-device bind mounts, nested mounts and escaped mount paths without live mount mutation', () => {
  const row = path => `42 1 8:1 / ${path} rw - ext4 /dev/fixture rw\n`;
  for (const mount of ['/state/task/build-output', '/state/task/build-output/nested', '/state/task/finalization', '/state/task']) {
    assert.throws(() => assertNoPayloadMounts('/state/task', ['/state/task/build-output', '/state/task/finalization/source.bundle'], row(mount)), /Mounted payload/);
  }
  assert.throws(() => assertNoPayloadMounts('/state/task name', ['/state/task name/build-output'], row('/state/task\\040name/build-output')), /Mounted payload/);
  assertNoPayloadMounts('/state/task', ['/state/task/build-output'], row('/state') + row('/state/unrelated'));
  assert.throws(() => assertNoPayloadMounts('/state/task', ['/state/task/build-output'], 'invalid'), /Invalid mount/);
});

test('inventory is read-only, reports worktree/branch allocation and never follows shared symlinks or declares disposable state', () => fixture(async f => {
  const root = join(f.task.directory, 'build-output'), outside = join(f.dir, 'outside');
  await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'protected'), 'shared');
  await symlink(outside, join(root, 'shared-sdk'));
  await mkdir(join(f.task.directory, 'bazel-output'));
  await writeFile(join(f.task.directory, 'bazel-output', 'legacy'), 'legacy cache');
  const before = await readdir(f.task.directory), status = f.g('status', '--porcelain');
  const report = await inventory(f.runtime), row = report.tasks[0];
  assert.equal(row.task, f.task.id); assert.equal(row.classification, 'unassessed');
  assert.equal(row.branchExists, true); assert.equal(row.branchRegistered, true); assert.equal(row.worktreeRegistered, true);
  assert.ok(row.worktreeAllocatedBytes > 0); assert.ok(row.allocatedBytes.legacyBuild > 0);
  assert.match(row.blockers.join(' '), /No live terminal/);
  assert.deepEqual(await readdir(f.task.directory), before); assert.equal(f.g('status', '--porcelain'), status);
  assert.equal(await readFile(join(outside, 'protected'), 'utf8'), 'shared');
}));

test('unsafe lifecycle symlinks, noncanonical parents and special payload files block disposal without deleting', async () => {
  for (const mode of ['receipt-symlink', 'parent-symlink', 'fifo']) await fixture(async f => {
    const d = await disposable(f);
    if (mode === 'receipt-symlink') {
      const path = join(f.task.directory, 'finalized.json');
      await writeFile(join(f.dir, 'aliased-receipt'), await readFile(path), { mode: 0o600 });
      await rm(path); await symlink(join(f.dir, 'aliased-receipt'), path);
    }
    if (mode === 'parent-symlink') {
      const path = join(f.task.directory, 'finalization');
      const { rename } = await import('node:fs/promises');
      await rename(path, join(f.dir, 'archive')); await symlink(join(f.dir, 'archive'), path);
    }
    if (mode === 'fifo') execFileSync('/bin/sh', ['-c', 'mkfifo "$1"', 'fixture', join(d.output, 'fifo')]);
    await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization));
    assert.ok(await lstat(join(d.output, 'nested', 'cache')));
    await assert.rejects(lstat(join(f.task.directory, 'disposal-claim.json')), { code: 'ENOENT' });
  });
});

test('an intermediate symlink replacement after claiming cannot redirect deletion outside the held output directory', () => fixture(async f => {
  const d = await disposable(f); let calls = 0;
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization, () => {
    if (++calls === 4) {
      renameSync(join(d.output, 'nested'), join(d.output, 'nested-moved'));
      symlinkSync(d.outside, join(d.output, 'nested'));
    }
  }), /Payload changed/);
  assert.equal(await readFile(join(d.outside, 'protected'), 'utf8'), 'never remove shared targets');
  assert.ok(await lstat(join(d.output, 'nested-moved', 'cache')));
  assert.ok(await lstat(join(f.task.directory, 'disposal-claim.json')));
  await assert.rejects(lstat(join(f.task.directory, 'disposed.json')), { code: 'ENOENT' });
}));

test('pre-existing interrupted archives are never overwritten or treated as permission to remove a worktree', () => fixture(async f => {
  await mkdir(join(f.task.directory, 'finalization'));
  await writeFile(join(f.task.directory, 'finalization', 'source.bundle'), 'interrupted recovery data');
  await assert.rejects(f.authorize(), /Existing\/interrupted/);
  assert.equal(await readFile(join(f.task.directory, 'finalization', 'source.bundle'), 'utf8'), 'interrupted recovery data');
  assert.ok(await lstat(f.task.worktree));
  assert.ok(!(await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
}));

test('backend movement after finalization/disposal claims preserves payloads and permanent failure evidence', () => fixture(async f => {
  const d = await disposable(f); let queries = 0;
  d.context.statuses = async () => ++queries === 1 ? f.rows : [{ ...f.rows[0], phase: 'UNKNOWN' }];
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), /Uncertain/);
  assert.ok(await lstat(d.output)); assert.ok(await lstat(join(f.task.directory, 'disposal-claim.json')));
  await assert.rejects(lstat(join(f.task.directory, 'disposed.json')), { code: 'ENOENT' });
}));

test('permanent payload disposal makes no new archive, protects symlink targets and retains identity/audit data', () => fixture(async f => {
  const d = await disposable(f);
  const receipt = await disposeTask(d.task, d.input, f.runtime, d.context, d.authorization);
  await assert.rejects(lstat(d.output), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.task.directory, 'finalization', 'source.bundle')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.task.directory, 'finalization', 'local-files.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(d.outside, 'protected'), 'utf8'), 'never remove shared targets');
  for (const path of ['task.json', 'submission.json', 'containment.json', 'finalized.json', 'disposal-claim.json', 'disposed.json', 'finalization/intent.json', 'finalization/ready.json']) assert.ok(await lstat(join(f.task.directory, path)));
  assert.ok(receipt.unlinkedAllocatedBytes > 0);
  assert.match(receipt.accounting, /not a filesystem free-space guarantee/);
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), /already claimed/);
}));

test('disposal is selection-bound and requires explicit opt-in, custody, complete finalization and fresh terminal/stopped proof', async () => {
  for (const mode of ['disabled', 'nonce', 'digest', 'owner', 'running', 'absent', 'stopped', 'worktree', 'ref', 'receipt', 'unknown-selection', 'authorization']) await fixture(async f => {
    const d = await disposable(f);
    if (mode === 'disabled') delete f.runtime.disposalProtocol;
    if (mode === 'nonce') d.input.expectedNonce = 'other';
    if (mode === 'digest') d.input.expectedFinalization = '0'.repeat(64);
    if (mode === 'owner') d.context.who = { ...who, session: 'other' };
    if (mode === 'running') d.context.statuses = async () => [{ ...f.rows[0], phase: 'RUNNING' }];
    if (mode === 'absent') d.context.statuses = async () => [];
    if (mode === 'stopped') d.context.stopped = async () => { throw new Error('uncertain descendants'); };
    if (mode === 'worktree') await mkdir(f.task.worktree, { recursive: true });
    if (mode === 'ref') f.g('branch', f.task.branch, f.task.base);
    if (mode === 'receipt') await rm(join(f.task.directory, 'finalization', 'ready.json'));
    if (mode === 'unknown-selection') d.input.selections = ['../shared-sdk'];
    if (mode === 'authorization') d.authorization.selections = ['recovery'];
    await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), undefined, mode);
    assert.ok(await lstat(join(d.output, 'nested', 'cache')));
    await assert.rejects(lstat(join(f.task.directory, 'disposal-claim.json')), { code: 'ENOENT' });
  });
});

test('selection excludes recovery; stale data and interrupted disposal never permit silent retries', () => fixture(async f => {
  const d = await disposable(f);
  await writeFile(join(d.output, 'nested', 'cache'), 'changed during confirmation');
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), /authorization/);
  d.input.selections = ['build-output'];
  const gate = await disposalGate(d.task, d.input, f.runtime, d.context);
  let calls = 0;
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, disposalAuthorization(d.task, d.input, gate), () => {
    if (++calls === 5) throw new Error('interrupted');
  }), /interrupted/);
  assert.ok(await lstat(join(f.task.directory, 'disposal-claim.json')));
  assert.ok(await lstat(join(f.task.directory, 'finalization', 'source.bundle')));
  await assert.rejects(lstat(join(f.task.directory, 'disposed.json')), { code: 'ENOENT' });
  await assert.rejects(disposalGate(d.task, d.input, f.runtime, d.context), /already claimed/);
}));

test('concurrent disposals have one winner and symlink replacement cannot redirect removal', () => fixture(async f => {
  const d = await disposable(f);
  const results = await Promise.allSettled([disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), disposeTask(d.task, d.input, f.runtime, d.context, d.authorization)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await readFile(join(d.outside, 'protected'), 'utf8'), 'never remove shared targets');
}));

test('build symlinks are unlinked, never traversed; changed parent links and same-task ref reuse block disposal', () => fixture(async f => {
  const d = await disposable(f);
  await rm(join(d.output, 'nested'), { recursive: true });
  await symlink(d.outside, join(d.output, 'nested'));
  await assert.rejects(disposeTask(d.task, d.input, f.runtime, d.context, d.authorization), /authorization/);
  const gate = await disposalGate(d.task, d.input, f.runtime, d.context);
  await disposeTask(d.task, d.input, f.runtime, d.context, disposalAuthorization(d.task, d.input, gate));
  assert.ok(await lstat(join(d.outside, 'protected')));
}));

test('finalization archives inherited baseline, binary/untracked/ignored files and symlinks; keeps evidence and parent untouched', () => fixture(async f => {
  await mkdir(join(f.task.directory, 'build-output')); await writeFile(join(f.task.directory, 'build-output', 'cache'), 'retained');
  const parentStatus = f.g('status', '--porcelain');
  const receipt = await finalizeTask(f.task, f.input, f.runtime, f.rows, await f.authorize());
  await assert.rejects(lstat(f.task.worktree), { code: 'ENOENT' });
  assert.equal(f.g('branch', '--list', f.task.branch), '');
  assert.equal(f.g('status', '--porcelain'), parentStatus);
  const archive = await json(join(receipt.directory, 'local-files.json'));
  assert.equal(archive.base, f.task.base);
  assert.match(archive.patch, /worker change/);
  assert.deepEqual(Buffer.from(archive.files.find(x => x.name === 'binary.dat').base64, 'base64'), Buffer.from([0, 255, 1]));
  assert.equal(Buffer.from(archive.files.find(x => x.name === 'secret.ignored').base64, 'base64').toString(), 'ignored data must survive\n');
  assert.equal(archive.files.find(x => x.name === 'link').symlink, '/outside/target');
  assert.equal((await lstat(join(receipt.directory, 'source.bundle'))).mode & 0o777, 0o600);
  const restore = join(f.dir, 'restore'); execFileSync(git, ['init', '-q', restore]);
  execFileSync(git, ['-C', restore, 'fetch', '-q', join(receipt.directory, 'source.bundle'), `refs/heads/${f.task.branch}:refs/heads/restored`]);
  assert.equal(execFileSync(git, ['-C', restore, 'show', 'restored:inherited.txt'], { encoding: 'utf8' }), 'inherited source\n');
  assert.equal(await readFile(join(f.task.directory, 'build-output', 'cache'), 'utf8'), 'retained');
  assert.equal((await json(join(f.task.directory, 'finalized.json'))).nonce, f.task.nonce);
  assert.equal(receipt.containerRemoved, true);
  await assert.rejects(prepareRevision(f.task, { ...f.input, model: f.task.model, thinking: f.task.thinking, brief: 'Too late' }, f.runtime));
}));

test('uncertainty, no authorization, stale fingerprints, bad identity, missing review and legacy containment never delete', () => fixture(async f => {
  for (const rows of [[], ...['RUNNING', 'QUEUED', 'PAUSED', 'UNKNOWN', 'ADMISSION_UNKNOWN'].map(phase => [{ ...f.rows[0], phase }]),
    [{ ...f.rows[0], nonce: 'other' }], [{ nonce: f.task.nonce, phase: 'EXITED' }]]) {
    await assert.rejects(finalizationGate(f.task, f.input, f.runtime, rows));
  }
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows), /authorization/);
  await assert.rejects(finalizationGate(f.task, { ...f.input, expectedFingerprint: '0'.repeat(64) }, f.runtime, f.rows), /fingerprint changed/);
  await assert.rejects(finalizationGate({ ...f.task, branch: 'main' }, f.input, f.runtime, f.rows), /identity mismatch/);
  await assert.rejects(finalizationGate(f.task, f.input, { ...f.runtime, finalizationProtocol: undefined }, f.rows), /runtime/);
  await rm(f.feedbackPath);
  await assert.rejects(finalizationGate(f.task, f.input, f.runtime, f.rows), /review\/feedback/);
  await f.feedback();
  await rm(join(f.task.directory, 'containment.json'));
  await assert.rejects(finalizationGate(f.task, f.input, f.runtime, f.rows), /containment evidence/);
  assert.ok(await lstat(f.task.worktree));
  assert.ok(!(await readdir(f.task.directory)).some(x => x.startsWith('revision-after-')));
}));

test('rechecks ignored data and current check evidence; discarded work still requires feedback and archives', () => fixture(async f => {
  const authorization = await f.authorize();
  await writeFile(join(f.task.worktree, 'secret.ignored'), 'changed during confirmation');
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, authorization), /authorization/);
  const task = { ...f.task, checks: [{ kind: 'test', targets: ['unit'] }] };
  await assert.rejects(finalizationGate(task, f.input, f.runtime, f.rows), /check plan changed/);
  const manifest = await json(join(task.directory, 'task.json'));
  await writeFile(join(task.directory, 'task.json'), JSON.stringify({ ...manifest, checks: task.checks }));
  await assert.rejects(finalizationGate(task, f.input, f.runtime, f.rows), /passing evidence/);
  await save(join(task.directory, `check-0-${randomUUID()}.json`), { index: 0, passed: true, after: '0'.repeat(64) });
  await assert.rejects(finalizationGate(task, f.input, f.runtime, f.rows), /passing evidence/);
  await save(join(task.directory, `check-0-${randomUUID()}.json`), { index: 0, passed: true, after: f.input.expectedFingerprint });
  assert.ok(await finalizationGate(task, f.input, f.runtime, f.rows));
  const input = { ...f.input, disposition: 'discarded' };
  assert.ok(await finalizationGate(task, input, f.runtime, f.rows));
  const receipt = await finalizeTask(task, input, f.runtime, f.rows, await f.authorize(task, input));
  assert.equal(receipt.disposition, 'discarded');
}));

test('every retained attempt must be terminal and independently stopped', () => fixture(async f => {
  const revision = { ...await prepareRevision(f.task, { ...f.input, model: f.task.model, thinking: f.task.thinking, brief: 'Revision' }, f.runtime), nonce: 'revision-job' };
  await save(join(attemptDirectory(revision, revision.attempt), 'submission.json'), { nonce: revision.nonce });
  await f.contain(revision.attempt);
  const input = { ...f.input, expectedNonce: revision.nonce };
  await f.feedback(revision, input);
  const rows = [...f.rows, { nonce: revision.nonce, phase: 'EXITED', exitCode: 0 }];
  await assert.rejects(finalizationGate(revision, input, f.runtime, rows.slice(1)), /Every attempt/);
  const seen = [];
  await finalizationGate(revision, input, f.runtime, rows, async (task, attempt) => { seen.push([task.attempt, attempt]); return { stopped: true }; });
  assert.deepEqual(seen, [[undefined, undefined], [revision.attempt, revision.attempt]]);
  await rm(join(f.task.directory, 'containment.json'));
  await assert.rejects(finalizationGate(revision, input, f.runtime, rows), /containment evidence/);
}));

test('competing revision claims block cleanup; partial failures retain archive, branch and claim without retry', () => fixture(async f => {
  const authorization = await f.authorize(); let calls = 0;
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, authorization, () => {
    if (++calls === 3) throw new Error('Session changed after worktree removal');
  }), /Session changed/);
  assert.equal(f.g('branch', '--list', f.task.branch).includes(f.task.branch), true);
  assert.ok(await lstat(join(f.task.directory, 'finalization', 'local-files.json')));
  assert.ok(await lstat(join(f.task.directory, `revision-after-${digest(f.task.nonce)}.json`)));
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, authorization));
}));

test('a live competing revision wins the shared permanent claim', () => fixture(async f => {
  const authorization = await f.authorize();
  await prepareRevision(f.task, { ...f.input, model: f.task.model, thinking: f.task.thinking, brief: 'Next attempt' }, f.runtime);
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, authorization));
  assert.ok(await lstat(f.task.worktree));
}));

test('superseded good feedback cannot override a correction that reports issues', () => fixture(async f => {
  const old = await json(f.feedbackPath), id = randomUUID();
  await save(join(f.task.directory, 'feedback', id + '.json'), { ...old,
    supersedes: f.feedbackPath.split('/').at(-1).slice(0, -5), assessment: { reviewStatus: 'reviewed', correctness: 'issues' } });
  await assert.rejects(finalizationGate(f.task, f.input, f.runtime, f.rows), /review\/feedback/);
  assert.ok(await finalizationGate(f.task, { ...f.input, disposition: 'discarded' }, f.runtime, f.rows));
}));

test('locked worktrees are never force-unlocked and retain verified archives on failure', () => fixture(async f => {
  f.g('worktree', 'lock', f.task.worktree);
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, await f.authorize()), /locked/);
  assert.ok(await lstat(f.task.worktree));
  assert.ok(await lstat(join(f.task.directory, 'finalization', 'source.bundle')));
}));

test('a branch reused in another checkout after removal is never deleted', () => fixture(async f => {
  let calls = 0;
  await assert.rejects(finalizeTask(f.task, f.input, f.runtime, f.rows, await f.authorize(), () => {
    if (++calls === 3) f.g('worktree', 'add', '-q', join(f.dir, 'reused'), f.task.branch);
  }), /checked out elsewhere/);
  assert.ok(f.g('branch', '--list', f.task.branch).includes(f.task.branch));
}));

test('assume-unchanged flags cannot hide local changes from recovery', () => fixture(async f => {
  execFileSync(git, ['-C', f.task.worktree, 'update-index', '--assume-unchanged', 'source.txt']);
  const input = { ...f.input, expectedFingerprint: await snapshot(f.task, f.runtime) };
  await assert.rejects(finalizationGate(f.task, input, f.runtime, f.rows), /assume-unchanged/);
  assert.ok(await lstat(f.task.worktree));
}));

test('oversized ignored files block deletion without claiming the task', () => fixture(async f => {
  const { truncate } = await import('node:fs/promises');
  await truncate(join(f.task.worktree, 'secret.ignored'), 64 * 1024 * 1024 + 1);
  await assert.rejects(finalizationGate(f.task, f.input, f.runtime, f.rows), /oversized/);
  assert.ok(!(await readdir(f.task.directory)).some(x => x.startsWith('revision-after-')));
}));

async function host(f, confirm = async () => true) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const entries = [{ type: 'custom', customType: ENTRY, data: f.task }], calls = [], api = createExtensionRuntime();
  api.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, api);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map([...loaded.extensions[0].tools.values()].map(x => [x.definition.name, x.definition]));
  let rows = f.rows;
  const ctx = { hasUI: true, ui: { confirm: async (...args) => { calls.push('confirm'); return confirm(...args); } },
    sessionManager: { getSessionFile: () => who.file, getSessionId: () => who.session, getBranch: () => entries },
    executeTool: async name => { calls.push(name); assert.equal(name, 'pueue_status'); return { result: { content: [{ type: 'text', text: JSON.stringify(rows) }] } }; } };
  const old = process.env.PI_DELEGATE_RUNTIME, path = join(f.dir, 'runtime.json');
  await writeFile(path, JSON.stringify(f.runtime)); process.env.PI_DELEGATE_RUNTIME = path;
  return { ctx, entries, calls, rows: value => { rows = value; },
    invoke: signal => tools.get('delegate_finalize').execute('finalize', f.input, signal, undefined, ctx),
    dispose: (input, signal) => tools.get('delegate_dispose').execute('dispose', input, signal, undefined, ctx),
    close: () => { if (old === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = old; } };
}

test('disposal tool assesses without confirmation and denies no-UI/denied/aborted/stale/session changes', async () => {
  for (const mode of ['assess', 'success', 'denied', 'no-ui', 'aborted', 'source', 'status', 'session']) await fixture(async f => {
    const d = await disposable(f), controller = new AbortController(); let h;
    h = await host(f, async () => {
      if (mode === 'source') await writeFile(join(d.output, 'nested', 'cache'), 'changed');
      if (mode === 'status') h.rows([{ nonce: f.task.nonce, phase: 'RUNNING' }]);
      if (mode === 'session') h.entries.length = 0;
      if (mode === 'aborted') controller.abort();
      return mode !== 'denied';
    });
    if (mode === 'no-ui') h.ctx.hasUI = false;
    try {
      if (mode === 'assess') {
        const result = JSON.parse((await h.dispose({ task: f.task.id, expectedNonce: f.task.nonce })).content[0].text);
        assert.equal(result.expectedFinalization, d.input.expectedFinalization);
        assert.ok(!h.calls.includes('confirm'));
        assert.ok(await lstat(d.output));
      } else if (mode === 'success') {
        const result = JSON.parse((await h.dispose(d.input)).content[0].text);
        assert.ok(result.entriesRemoved > 0); assert.ok(h.calls.includes('confirm'));
      } else {
        await assert.rejects(h.dispose(d.input, controller.signal));
        assert.ok(await lstat(d.output));
        await assert.rejects(lstat(join(f.task.directory, 'disposal-claim.json')), { code: 'ENOENT' });
      }
    } finally { h.close(); }
  });
});

test('tool requires fresh UI approval, rechecks backend and records finalization on the active session branch', () => fixture(async f => {
  const h = await host(f);
  try {
    const result = JSON.parse((await h.invoke()).content[0].text);
    assert.equal(result.finalized, true);
    assert.deepEqual(h.calls, ['pueue_status', 'confirm', 'pueue_status', 'pueue_status']);
    assert.equal(h.entries.at(-1).data.finalized.task, f.task.id);
  } finally { h.close(); }
}));

test('denied/no-UI/aborted/source/ignored/status/session changes during confirmation cannot delete', async () => {
  for (const mode of ['denied', 'no-ui', 'aborted', 'source', 'ignored', 'status', 'session']) await fixture(async f => {
    let h; const controller = new AbortController();
    h = await host(f, async () => {
      if (mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'new work');
      if (mode === 'ignored') await writeFile(join(f.task.worktree, 'secret.ignored'), 'new ignored data');
      if (mode === 'status') h.rows([{ nonce: f.task.nonce, phase: 'RUNNING' }]);
      if (mode === 'session') h.entries.length = 0;
      if (mode === 'aborted') controller.abort();
      return mode !== 'denied';
    });
    if (mode === 'no-ui') h.ctx.hasUI = false;
    try {
      await assert.rejects(h.invoke(controller.signal));
      assert.ok(await lstat(f.task.worktree));
      assert.ok(!(await readdir(f.task.directory)).some(x => x.startsWith('revision-after-')));
    } finally { h.close(); }
  });
});
