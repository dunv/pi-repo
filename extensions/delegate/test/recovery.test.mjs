// Temporary Git repositories, synthetic trusted startup records and a fake
// backend only. Never mutate real cgroups, signal workers or call a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepare, prepareRevision, snapshot, save, json, attemptDirectory, ENTRY, tasksFrom } from '../core.mjs';
import { recordContainment, assertStopped, assertContained, scopeName } from '../containment.mjs';
import { recoveryGate, prepareRecovery, recoveryAuthorization, assertRecoveryHandoff } from '../recovery.mjs';
import { run } from '../run.mjs';
import { scopedRun } from '../scope.mjs';

const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const who = { session: 'recovery-session', file: '/fixture/session.jsonl' };
async function fixture(fn, backend = 'claude') {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-recovery-')), repo = join(dir, 'repo');
  try {
    execFileSync(git, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    execFileSync(git, ['-C', repo, 'add', '.']);
    execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const runtime = { git, node: process.execPath, pi: '/fixture/pi', claude: '/fixture/claude', flock: '/fixture/flock',
      ssh: '/fixture/ssh', home: dir, state: join(dir, 'state'), launcher: '/fixture/launcher', path: process.env.PATH,
      revisionProtocol: 1, containmentProtocol: 1, systemdRun: '/fixture/systemd-run',
      profiles: { fixture: { command: '/fixture/check', args: ['{worktree}', '{outputBase}', '{kind}', '{targets}'] } } };
    const task = { ...await prepare({ repo, backend, model: backend === 'claude' ? 'claude-sonnet-4-6' : 'fixture/model',
      thinking: backend === 'claude' ? 'high' : 'low', profile: 'fixture',
      checks: [{ kind: 'test', targets: ['unit:test'] }], brief: 'Original brief.' }, runtime, who), nonce: 'old-job' };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce });
    await writeFile(join(task.worktree, 'source.txt'), 'reviewed foreground fix\n');
    const input = { task: task.id, expectedNonce: task.nonce, expectedFingerprint: await snapshot(task, runtime), brief: 'Recover with reviewed fixes.' };
    const rows = [{ nonce: task.nonce, phase: 'KILLED', cancellationRequested: true }];
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const cgroup = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${scopeName(task.id)}`;
    // Simulate the startup recorder, not a caller liveness assertion. Production
    // always uses kernel /proc and /sys paths, with no tool-selectable overrides.
    const fs = {
      readFile: async path => path === '/proc/self/cgroup' ? `0::${cgroup}\n` : path === '/proc/sys/kernel/random/boot_id' ? bootId : 'populated 0\nfrozen 0\n',
      realpath: async path => path,
      lstat: async () => ({ ino: 123, dev: 27, isDirectory: () => true, isSymbolicLink: () => false }),
    };
    await recordContainment(task, undefined, fs);
    await fn({ dir, repo, runtime, task, input, rows, fs, bootId, cgroup });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('containment verifies the entire cgroup subtree and identity, never PID absence or KILLED', () => fixture(async f => {
  assert.equal((await assertStopped(f.task, undefined, f.fs)).observed, 'empty-cgroup');
  await assertContained(f.task, undefined, f.fs);
  for (const contents of ['populated 1\nfrozen 0\n', 'frozen 0\n', 'populated 0\npopulated 1\n']) {
    await assert.rejects(assertStopped(f.task, undefined, { ...f.fs,
      readFile: async path => path.endsWith('cgroup.events') ? contents : f.fs.readFile(path) }), /still present|uncertain/);
  }
  await assert.rejects(assertStopped(f.task, undefined, { ...f.fs, lstat: async () => ({ ...await f.fs.lstat(), ino: 456 }) }), /replaced/);
  await assert.rejects(assertStopped(f.task, undefined, { ...f.fs,
    readFile: async path => path.endsWith('boot_id') ? randomUUID() : f.fs.readFile(path) }), /Boot changed/);
  const absent = Object.assign(new Error('absent'), { code: 'ENOENT' });
  const fs = { ...f.fs, realpath: async () => { throw absent; }, lstat: async () => { throw absent; } };
  assert.equal((await assertStopped(f.task, undefined, fs)).observed, 'removed-cgroup');
  await assert.rejects(assertStopped(f.task, undefined, { ...f.fs,
    readFile: async path => { if (path.endsWith('cgroup.events')) throw absent; return f.fs.readFile(path); } }), /unavailable/);
  await assert.rejects(recordContainment(f.task, undefined, f.fs), /EEXIST/);
}));

test('recovery keeps frozen invocation, foreground fixes, artifacts, cancellation and build state; claim is shared with revise', () => fixture(async f => {
  const oldResult = { code: null, signal: 'SIGTERM', accepted: false };
  await save(join(f.task.directory, 'result.json'), oldResult);
  await mkdir(join(f.task.directory, 'build-output'));
  await writeFile(join(f.task.directory, 'build-output', 'cache'), 'retained');
  const authorized = recoveryAuthorization(f.task, f.input);
  const resumed = await prepareRecovery(f.task, f.input, f.runtime, f.rows, authorized);
  assert.equal(resumed.worktree, f.task.worktree); assert.equal(resumed.base, f.task.base); assert.equal(resumed.branch, f.task.branch);
  assert.equal(resumed.nonce, undefined); assert.equal(resumed.previousNonce, f.task.nonce);
  for (const key of ['backend', 'model', 'thinking', 'profile', 'checks', 'verification', 'route']) assert.deepEqual(resumed[key], f.task[key]);
  const directory = attemptDirectory(resumed, resumed.attempt), plan = await json(join(directory, 'attempt.json'));
  assert.equal(plan.expectedFingerprint, f.input.expectedFingerprint);
  assert.equal(plan.recovery.execution.phase, 'KILLED'); assert.equal(plan.recovery.execution.cancellationRequested, true);
  assert.equal(plan.recovery.authorization.id, authorized.id);
  assert.equal(plan.recovery.previousAttempt, null);
  await assertRecoveryHandoff(f.task, plan, f.runtime);
  await assert.rejects(assertRecoveryHandoff(f.task, { ...plan, thinking: 'low' }, f.runtime), /invocation changed/);
  await writeFile(join(directory, 'brief.md'), 'changed after authorization');
  await assert.rejects(assertRecoveryHandoff(f.task, plan, f.runtime), /authorization\/binding changed/);
  await writeFile(join(directory, 'brief.md'), f.input.brief);
  assert.deepEqual(await json(join(f.task.directory, 'result.json')), oldResult);
  assert.equal(await readFile(join(f.task.directory, 'brief.md'), 'utf8'), 'Original brief.');
  assert.equal(await readFile(join(directory, 'brief.md'), 'utf8'), f.input.brief);
  assert.equal(await readFile(join(f.task.directory, 'build-output', 'cache'), 'utf8'), 'retained');
  await assert.rejects(prepareRecovery(f.task, f.input, f.runtime, f.rows, recoveryAuthorization(f.task, f.input)), /EEXIST/);
  await assert.rejects(prepareRevision(f.task, { ...f.input, model: f.task.model, thinking: f.task.thinking }, f.runtime), /EEXIST/);
  await assert.rejects(run(await runtimeFile(f), f.task.id, resumed.attempt), /containment evidence/);
  assert.ok(!(await readdir(directory)).includes('started.json'), 'uncontained handoff starts no worker');
}));
async function runtimeFile(f) {
  const path = join(f.dir, 'runtime.json'); await writeFile(path, JSON.stringify(f.runtime)); return path;
}

test('concurrent authorized recoveries compete for one durable claim and do not change old results', () => fixture(async f => {
  const result = await Promise.allSettled(Array.from({ length: 2 }, () =>
    prepareRecovery(f.task, f.input, f.runtime, f.rows, recoveryAuthorization(f.task, f.input))));
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(result.find(value => value.status === 'rejected').reason.message, /EEXIST/);
  assert.equal((await readdir(join(f.task.directory, 'revisions'))).length, 1);
}));

test('recovery rejects uncertainty, stale source, changed plans, legacy evidence and missing authorization without claims', () => fixture(async f => {
  for (const rows of [[], [{ ...f.rows[0], nonce: 'other' }], ...['QUEUED', 'RUNNING', 'PAUSED', 'UNKNOWN', 'ADMISSION_UNKNOWN'].map(phase => [{ ...f.rows[0], phase }]),
    [{ nonce: f.task.nonce, phase: 'EXITED' }]]) {
    await assert.rejects(recoveryGate(f.task, f.input, f.runtime, rows));
  }
  assert.ok(await recoveryGate(f.task, f.input, f.runtime, [{ nonce: f.task.nonce, phase: 'EXITED', exitCode: 7 }]));
  const success = [{ nonce: f.task.nonce, phase: 'EXITED', exitCode: 0 }];
  assert.equal((await recoveryGate(f.task, f.input, f.runtime, success)).execution.workerResult, 'missing');
  await save(join(f.task.directory, 'result.json'), { code: 0, fingerprint: 'a'.repeat(64) });
  await assert.rejects(recoveryGate(f.task, f.input, f.runtime, success), /delegate_revise/);
  await writeFile(join(f.task.directory, 'result.json'), '{partial json');
  assert.equal((await recoveryGate(f.task, f.input, f.runtime, success)).execution.workerResult, 'invalid');
  assert.ok(await recoveryGate(f.task, f.input, f.runtime, [{ nonce: f.task.nonce, phase: 'EXITED', exitCode: 0, cancellationRequested: true }]));
  await assert.rejects(prepareRecovery(f.task, f.input, f.runtime, f.rows), /authorization/);
  await assert.rejects(recoveryGate(f.task, { ...f.input, expectedFingerprint: '0'.repeat(64) }, f.runtime, f.rows), /reviewed fingerprint/);
  await assert.rejects(recoveryGate({ ...f.task, thinking: 'low' }, f.input, f.runtime, f.rows), /Frozen invocation/);
  await assert.rejects(recoveryGate({ ...f.task, checks: [] }, f.input, f.runtime, f.rows), /verification plan/);
  await assert.rejects(recoveryGate(f.task, f.input, { ...f.runtime, containmentProtocol: undefined }, f.rows), /scoped runtime/);
  await rm(join(f.task.directory, 'containment.json'));
  await assert.rejects(recoveryGate(f.task, f.input, f.runtime, f.rows), /legacy\/unrecorded/);
  assert.ok(!(await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
}));

test('real user scope supports failure and a fresh recovery without model calls',
  { skip: process.env.PI_TEST_SCOPES !== '1' }, () => fixture(async f => {
    await rm(join(f.task.directory, 'containment.json'));
    await writeFile(join(f.task.worktree, 'source.txt'), 'original\n');
    const pi = join(f.dir, 'fake-pi');
    await writeFile(pi, `#!${process.execPath}\nconsole.log('Fixture worker, no model'); process.exitCode=7;\n`, { mode: 0o700 });
    f.runtime.systemdRun = '/run/current-system/sw/bin/systemd-run';
    f.runtime.pi = pi;
    const task = f.task;
    const path = await runtimeFile(f);
    assert.equal(await scopedRun(path, task.id), 7);
    assert.equal((await assertStopped(task)).stopped, true);
    await writeFile(join(task.worktree, 'source.txt'), 'reviewed fix after failure\n');
    const input = { ...f.input, expectedFingerprint: await snapshot(task, f.runtime) };
    const rows = [{ nonce: task.nonce, phase: 'EXITED', exitCode: 7 }];
    const resumed = await prepareRecovery(task, input, f.runtime, rows, recoveryAuthorization(task, input));
    assert.equal(await scopedRun(path, task.id, resumed.attempt), 7);
    assert.equal((await assertStopped(resumed)).stopped, true);
    assert.equal((await json(join(task.directory, 'result.json'))).code, 7);
    assert.equal((await json(join(attemptDirectory(resumed, resumed.attempt), 'result.json'))).code, 7);
  }, 'pi'));

async function host(f, confirm = async () => true) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const entries = [{ type: 'custom', customType: ENTRY, data: f.task }], calls = [], api = createExtensionRuntime();
  api.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, api);
  assert.deepEqual(loaded.errors, []);
  const registered = new Map([...loaded.extensions[0].tools.values()].map(value => [value.definition.name, value.definition]));
  let rows = f.rows, submissions = 0;
  const ctx = { hasUI: true, ui: { confirm: async (...args) => { calls.push('confirm'); return confirm(...args); } },
    sessionManager: { getSessionFile: () => who.file, getSessionId: () => who.session, getBranch: () => entries },
    executeTool: async (name, input) => {
      calls.push(name);
      if (name === 'pueue_submit') { submissions++; assert.equal(input.argv.length, 4); assert.equal(input.cwd, f.task.worktree); }
      return { result: { content: [{ type: 'text', text: JSON.stringify(name === 'pueue_status' ? rows : { nonce: 'new-job', phase: 'QUEUED' }) }] } };
    } };
  const old = process.env.PI_DELEGATE_RUNTIME; process.env.PI_DELEGATE_RUNTIME = await runtimeFile(f);
  return { ctx, entries, calls, registered, rows: value => { rows = value; }, submissions: () => submissions,
    invoke: (signal) => registered.get('delegate_resume').execute('resume', f.input, signal, undefined, ctx),
    close: () => { if (old === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = old; } };
}

test('resume requires fresh UI approval, revalidates after dialog and submits exactly one new context', () => fixture(async f => {
  const h = await host(f);
  try {
    const result = JSON.parse((await h.invoke()).content[0].text);
    assert.equal(result.nonce, 'new-job'); assert.equal(result.backend, f.task.backend);
    assert.deepEqual(h.calls, ['pueue_status', 'confirm', 'pueue_status', 'pueue_submit']);
    assert.equal(h.submissions(), 1);
    const latest = tasksFrom(h.entries).get(f.task.id);
    assert.equal(latest.recovery.execution.cancellationRequested, true);
    await assert.rejects(h.invoke(), /binding changed/);
    assert.equal(h.submissions(), 1);
  } finally { h.close(); }
}));

test('denied/no-UI/aborted and changed-during-confirmation recovery creates no continuation', async () => {
  for (const mode of ['denied', 'no-ui', 'aborted', 'source', 'status', 'tree']) await fixture(async f => {
    let h;
    const controller = new AbortController();
    h = await host(f, async () => {
      if (mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'not reviewed');
      if (mode === 'status') h.rows([{ nonce: f.task.nonce, phase: 'RUNNING' }]);
      if (mode === 'tree') h.entries.length = 0;
      if (mode === 'aborted') controller.abort();
      return mode !== 'denied';
    });
    if (mode === 'no-ui') h.ctx.hasUI = false;
    try {
      await assert.rejects(h.invoke(controller.signal));
      assert.equal(h.submissions(), 0);
      assert.ok(!(await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
    } finally { h.close(); }
  });
});
