// Local fixtures only: no models, live jobs, activation or real cgroup mutation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepare, prepareRevision, snapshot, save, json, digest, attemptDirectory, ENTRY } from '../core.mjs';
import { scopeName } from '../containment.mjs';
import { finalizationGate, finalizationAuthorization, finalizeTask } from '../finalize.mjs';

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
    close: () => { if (old === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = old; } };
}

test('tool requires fresh UI approval, rechecks backend and records finalization on the active session branch', () => fixture(async f => {
  const h = await host(f);
  try {
    const result = JSON.parse((await h.invoke()).content[0].text);
    assert.equal(result.finalized, true);
    assert.deepEqual(h.calls, ['pueue_status', 'confirm', 'pueue_status']);
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
