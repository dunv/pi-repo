// Disposable-workspace contract. Temporary repositories/fake backends only;
// no real tasks, provider calls, cgroup mutations or process stopping.
import { test } from 'node:test';
import { watch } from 'node:fs';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir, symlink, lstat, truncate, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepare, save, json, writeTask, snapshot, writable } from '../core.mjs';
import { withTaskLock } from '../lock.mjs';
import { scopeName, recordContainment, assertStopped, assertContained } from '../containment.mjs';
import { loadWorkspace, assertWorkspaceIdle, inspectWorkspace, cleanupWorkspace } from '../workspace.mjs';
import { assertNoPayloadMounts } from '../repository.mjs';
import { project } from '../../pueue/backend.ts';
import { scopedRun } from '../scope.mjs';
import { environmentFixture } from './environment-fixture.mjs';

const executable = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const git = executable('git'), flock = executable('flock');
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-workspace-')), repo = join(dir, 'repo');
  try {
    execFileSync(git, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n'); await writeFile(join(repo, '.gitignore'), '.cache/\n');
    execFileSync(git, ['-C', repo, 'add', '.']);
    execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const namespace = randomUUID(), who = { session: randomUUID(), file: join(dir, 'main-session.jsonl') };
    await writeFile(who.file, 'Main session must survive\n');
    const runtime = { git, flock, node: process.execPath, pi: '/fixture/pi', ssh: '/fixture/ssh', home: dir, state: join(dir, 'state'),
      launcher: '/fixture/launcher', path: process.env.PATH, disposableProtocol: 1, revisionProtocol: 1, containmentProtocol: 1, systemdRun: '/fixture/systemd-run',
      profiles: { fixture: { command: '/fixture/check', args: ['{targets}'] } } };
    Object.assign(runtime, environmentFixture(runtime, executable('env')));
    const spec = { repo, namespace, environment: 'implementation-checked', model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [{ kind: 'test', targets: ['unit:test'] }], brief: 'Synthetic disposable work.' };
    const task = { ...await prepare(spec, runtime, who), nonce: randomUUID() };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce }); await writeTask(task);
    await writeFile(join(task.worktree, 'source.txt'), 'worker change\n');
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const fs = {
      readFile: async path => path.endsWith('boot_id') ? boot : path === '/proc/self/cgroup' ? `0::/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${scopeName(task.id)}\n` : 'populated 0\n',
      realpath: async path => path,
      lstat: async () => ({ ino: 123, dev: 27, isDirectory: () => true, isSymbolicLink: () => false }),
    };
    await recordContainment(task, undefined, fs);
    const observe = async () => ({ namespace, tasks: [] });
    const input = { task: task.id, disposition: 'used', summary: 'Main agent reviewed and retained the useful result.' };
    const clean = (guard, observer = observe) => cleanupWorkspace(runtime, input, who, observer, guard);
    await fn({ dir, repo, runtime, task, who, spec, namespace, observe, input, clean, fs, boot });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const present = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

test('one cleanup removes source/builds/worker records without archives, preserving parent/session/shared targets', () => fixture(async f => {
  const shared = join(f.dir, 'shared-sdk'); await mkdir(shared); await writeFile(join(shared, 'keep'), 'shared');
  await symlink(shared, join(f.task.worktree, 'sdk'));
  await mkdir(join(f.task.worktree, '.cache')); const tool = join(f.task.worktree, '.cache', 'tool');
  await writeFile(tool, ''); await truncate(tool, 90 * 1024 * 1024); // No archival size gate.
  const largeSource = join(f.task.worktree, 'large-discarded-source.bin');
  await writeFile(largeSource, ''); await truncate(largeSource, 90 * 1024 * 1024); // No source-diff serialization gate either.
  await mkdir(join(f.task.directory, 'build-output')); await symlink(shared, join(f.task.directory, 'build-output', 'sdk'));
  await writeFile(join(f.task.directory, 'build-output', 'cache'), 'rebuildable');
  await mkdir(join(f.task.directory, 'sessions')); await writeFile(join(f.task.directory, 'sessions', 'worker.jsonl'), 'disposable worker transcript');
  const before = await readdir(f.task.directory), gate = await inspectWorkspace(f.runtime, f.task.id, f.observe, f.who);
  assert.deepEqual(await readdir(f.task.directory), before); assert.equal(gate.task.id, f.task.id);
  const result = await f.clean();
  assert.equal(result.archived, false); assert.equal(await present(f.task.worktree), false); assert.equal(await present(f.task.directory), false);
  assert.equal(execFileSync(git, ['-C', f.repo, 'branch', '--list', f.task.branch], { encoding: 'utf8' }), '');
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(f.who.file, 'utf8'), 'Main session must survive\n');
  assert.equal(await readFile(join(shared, 'keep'), 'utf8'), 'shared');
  assert.deepEqual((await readdir(f.runtime.state)).filter(name => name !== '.locks'), []);
}));

test('cleanup removes read-only Bazel output directories without chmodding shared symlink targets', () => fixture(async f => {
  const shared = join(f.dir, 'shared'); await mkdir(shared); await writeFile(join(shared, 'keep'), 'shared');
  const output = join(f.task.directory, 'build-output'), nested = join(output, 'readonly');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'asm_amd64.h'), 'rebuildable', { mode: 0o444 });
  await symlink(shared, join(nested, 'shared'));
  await chmod(shared, 0o555); await chmod(nested, 0o500); await chmod(output, 0o555);
  try {
    await f.clean();
    assert.equal(await present(f.task.directory), false);
    assert.equal((await lstat(shared)).mode & 0o777, 0o555);
    assert.equal(await readFile(join(shared, 'keep'), 'utf8'), 'shared');
  } finally {
    await chmod(shared, 0o700);
    // Permit fixture teardown if a regression stopped cleanup before removal.
    for (const path of [output, nested]) if (await present(path)) await chmod(path, 0o700);
  }
}));

test('orphan access has no owner session/history dependency; legacy immutable records are not silently migrated', () => fixture(async f => {
  await rm(f.who.file);
  const other = { session: randomUUID(), file: join(f.dir, 'another-main-session.jsonl') };
  assert.equal((await loadWorkspace(f.runtime, f.task.id)).id, f.task.id);
  assert.equal((await inspectWorkspace(f.runtime, f.task.id, f.observe, other)).task.owner.session, f.who.session);
  await writeTask({ ...f.task, version: 1 });
  await assert.rejects(f.clean(), /Legacy task/);
  assert.equal((await json(join(f.task.directory, 'task.json'))).version, 1);
}));

test('queued/running/paused/unknown jobs, uncertain admissions, backend failures and live descendants block removal', async () => {
  for (const phase of ['RUNNING', 'QUEUED', 'PAUSED', 'STASHED', 'LOCKED', 'UNKNOWN', 'ADMISSION_UNKNOWN']) await fixture(async f => {
    // UUID references also find a current job whose admission reply was lost.
    await rm(join(f.task.directory, 'submission.json'));
    const observe = async () => ({ namespace: f.namespace, tasks: [{ id: 99, label: 'not-known-to-parent', phase, references: [f.task.id] }] });
    await assert.rejects(f.clean(undefined, observe), /running, queued or uncertain/);
    assert.ok(await present(f.task.worktree)); assert.equal((await json(join(f.task.directory, 'task.json'))).closing === true, false);
  });
  await fixture(async f => {
    await assert.rejects(f.clean(undefined, async () => { throw new Error('backend unavailable'); }), /backend unavailable/);
    await assert.rejects(f.clean(undefined, async () => ({ namespace: randomUUID(), tasks: [] })), /backend unavailable/);
    await assert.rejects(assertWorkspaceIdle(f.task, f.runtime, f.observe, async () => { throw new Error('descendants alive'); }), /descendants alive/);
    await rm(join(f.task.directory, 'containment.json')); await save(join(f.task.directory, 'started.json'), {});
    await assert.rejects(f.clean(), /no current stopped-scope evidence/);
  });
});

test('kernel task lock prevents cleanup racing a worker/check, without scanning unrelated processes', () => fixture(async f => {
  await withTaskLock(f.runtime, f.task.id, true, async () => {
    await assert.rejects(f.clean(), /busy/);
    await withTaskLock(f.runtime, f.task.id, true, async () => {});
  });
  // An unrelated short-lived process has no task lock/scope; its host /proc
  // churn must not alter a task's cleanup identity.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal((await f.clean()).archived, false);
}));

test('stale source, session cancellation and newly active backend do not mark the workspace closing', async () => {
  for (const mode of ['source', 'guard', 'backend']) await fixture(async f => {
    let observations = 0;
    const observe = async () => {
      if (++observations === 2 && mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'concurrent change');
      return { namespace: f.namespace, tasks: observations === 2 && mode === 'backend' ? [{ phase: 'RUNNING', references: [f.task.id] }] : [] };
    };
    let checks = 0;
    await assert.rejects(f.clean(mode === 'guard' ? () => { if (++checks > 1) throw new Error('session changed'); } : undefined, observe),
      mode === 'source' ? /Workspace changed/ : mode === 'backend' ? /running, queued or uncertain/ : /session changed/);
    assert.ok(await present(f.task.worktree)); assert.equal((await json(join(f.task.directory, 'task.json'))).closing === true, false);
  });
});

test('interrupted removal keeps a closing flag in its manifest and can be explicitly finished without a recovery protocol', () => fixture(async f => {
  let calls = 0;
  await assert.rejects(f.clean(() => { if (++calls === 3) throw new Error('interrupted after worktree removal'); }), /interrupted/);
  assert.equal(await present(f.task.worktree), false);
  assert.equal((await json(join(f.task.directory, 'task.json'))).closing === true, true);
  await assert.rejects(writable(f.task, 'source.txt'), /cleanup is in progress/);
  await assert.rejects(loadWorkspace(f.runtime, f.task.id), /cleanup is in progress/);
  // Partial task-data removal may already have removed scope records. The
  // closing manifest fences writers; current active jobs still block finishing.
  await rm(join(f.task.directory, 'containment.json'));
  await save(join(f.task.directory, 'started.json'), {});
  await assert.rejects(f.clean(undefined, async () => ({ namespace: f.namespace, tasks: [{ phase: 'RUNNING', references: [f.task.id] }] })), /running, queued/);
  assert.equal((await f.clean()).archived, false);
  assert.equal(await present(f.task.directory), false);
}));

test('main/originating sessions, changed repositories, symlink roots, locked worktrees and mounted payloads stay protected', async () => {
  for (const mode of ['session', 'repository', 'symlink', 'locked']) await fixture(async f => {
    if (mode === 'session') await writeTask({ ...f.task, owner: { ...f.who, file: join(f.task.directory, 'report.md') } });
    if (mode === 'repository') await writeTask({ ...f.task, repository: { ...f.task.repository, commonIdentity: { device: 1, inode: 2 } } });
    if (mode === 'symlink') {
      const source = f.task.worktree + '-retained'; execFileSync(git, ['-C', f.repo, 'worktree', 'move', f.task.worktree, source]); await symlink(source, f.task.worktree);
    }
    if (mode === 'locked') execFileSync(git, ['-C', f.repo, 'worktree', 'lock', f.task.worktree]);
    await assert.rejects(f.clean()); assert.ok(await present(f.task.directory));
  });
  assert.throws(() => assertNoPayloadMounts('/task', ['/task'], '1 2 3:4 / /task/build rw - ext4 /dev/test rw\n'), /Mounted/);
});

test('unsupported local sockets are detected before removing either worktree or task data', () => fixture(async f => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(f.task.directory, 'active.socket'), resolve); });
  try {
    await assert.rejects(f.clean(), /Unsupported workspace file type/);
    assert.ok(await present(f.task.worktree)); assert.equal((await json(join(f.task.directory, 'task.json'))).closing, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('scope liveness checks descendants, same-boot identity and rebooted scopes without reconstructing historical terminal reviews', () => fixture(async f => {
  assert.equal((await assertStopped(f.task, undefined, f.fs)).observed, 'empty-cgroup');
  await assertContained(f.task, undefined, f.fs);
  for (const value of ['populated 1\n', 'frozen 0\n', 'populated 0\npopulated 1\n']) await assert.rejects(assertStopped(f.task, undefined,
    { ...f.fs, readFile: async path => path.endsWith('cgroup.events') ? value : f.fs.readFile(path) }), /still present|uncertain/);
  await assert.rejects(assertStopped(f.task, undefined, { ...f.fs, lstat: async () => ({ ...await f.fs.lstat(), ino: 456 }) }), /replaced/);
  const reboot = randomUUID(), previous = { ...f.fs, readFile: async path => path.endsWith('boot_id') ? reboot : f.fs.readFile(path) };
  assert.equal((await assertStopped(f.task, undefined, previous)).observed, 'empty-current-scope-after-reboot');
  await assert.rejects(assertStopped(f.task, undefined, { ...previous, readFile: async path => path.endsWith('cgroup.events') ? 'populated 1\n' : previous.readFile(path) }), /still present/);
  await assert.rejects(assertStopped(f.task, undefined, { ...f.fs, readFile: async path => path.endsWith('boot_id') ? '' : f.fs.readFile(path) }), /boot identity/);
}));

test('real user scope and task locks cover a fake worker until it exits; cleanup then removes its scratch',
  { skip: process.env.PI_TEST_SCOPES !== '1' }, () => fixture(async f => {
    await rm(join(f.task.directory, 'containment.json'));
    await writeFile(join(f.task.worktree, 'source.txt'), 'original\n');
    const worker = join(f.dir, 'fake-worker'), release = join(f.dir, 'release'), ready = join(f.dir, 'ready');
    await writeFile(worker, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');\nconst timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('Fixture finished');}},10);setTimeout(()=>process.exit(9),5000).unref();\n`, { mode: 0o700 });
    const runtime = { ...f.runtime, pi: worker, systemdRun: '/run/current-system/sw/bin/systemd-run' }, path = join(f.dir, 'runtime.json');
    await writeFile(path, JSON.stringify(runtime));
    let observer, watchdog;
    const started = new Promise((resolve, reject) => {
      observer = watch(f.dir, (_event, name) => { if (String(name) === 'ready') resolve(); });
      watchdog = setTimeout(() => reject(new Error('Fixture worker did not start')), 4000);
    });
    const running = scopedRun(path, f.task.id);
    try {
      await started;
      await assert.rejects(assertStopped(f.task), /still present/);
      await assert.rejects(f.clean(), /busy/);
    } finally {
      clearTimeout(watchdog); observer.close();
      await writeFile(release, 'continue');
      assert.equal(await running, 0);
    }
    assert.equal((await assertStopped(f.task)).stopped, true);
    assert.equal((await f.clean()).archived, false);
  }));

test('Pueue exposes only UUID references, and malformed/contradictory complete snapshots fail closed', () => {
  const id = randomUUID(), row = { id: 1, created_at: '2026-11-01T00:00:00Z', label: null, command: `launcher runtime ${id} SECRET`, status: { Running: {} } };
  const result = project(JSON.stringify({ tasks: { 1: row } }), id);
  assert.deepEqual(result[0].references, [id]); assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(project(JSON.stringify({ tasks: { 1: row } }))[0].references, undefined);
  assert.equal(project(JSON.stringify({ tasks: { 1: row } }), randomUUID())[0].references, undefined);
  for (const status of [{}, { Running: {}, Done: { result: 'Success' } }]) assert.throws(() => project(JSON.stringify({ tasks: { 1: { ...row, status } } })), /schema/);
});

async function host(f) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const api = createExtensionRuntime(), entries = []; api.appendEntry = (type, data) => entries.push({ type, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, api);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map([...loaded.extensions[0].tools.values()].map(value => [value.definition.name, value.definition]));
  const binary = join(f.dir, 'pueue'), status = join(f.dir, 'status.json'), runtimePath = join(f.dir, 'runtime.json');
  await writeFile(status, JSON.stringify({ tasks: {} })); await writeFile(runtimePath, JSON.stringify(f.runtime));
  await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('pueue 4.0.4');else if(process.argv.includes('status'))console.log(require('node:fs').readFileSync(${JSON.stringify(status)},'utf8'));else process.exitCode=99;\n`, { mode: 0o700 });
  const env = { PI_DELEGATE_RUNTIME: runtimePath, PI_PUEUE_BINARY: binary, PI_PUEUE_CONFIG: join(f.dir, 'config'), PI_PUEUE_DATA: f.dir,
    PI_PUEUE_NAMESPACE: f.namespace, PI_PUEUE_PATH: process.env.PATH };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  let submissions = 0, uncertain = false;
  const ctx = { hasUI: true, modelRegistry: { find: () => ({ id: 'model' }) }, ui: { confirm: async () => true },
    sessionManager: { getSessionFile: () => join(f.dir, 'orphan-reader.jsonl'), getSessionId: () => 'another-session', getBranch: () => [] },
    executeTool: async name => {
      if (name === 'worktree_panel_target') return { result: { content: [{ type: 'text', text: '{}' }] } };
      assert.equal(name, 'pueue_submit'); submissions++;
      if (uncertain) return { isError: true };
      return { result: { content: [{ type: 'text', text: JSON.stringify({ nonce: randomUUID(), id: submissions, phase: 'QUEUED' }) }] } };
    } };
  return { ctx, entries, tools, runtimePath, status, submissions: () => submissions, uncertain: () => { uncertain = true; },
    emit: async name => { for (const handler of loaded.extensions[0].handlers.get(name) ?? []) await handler({}); },
    invoke: (name, input, signal) => tools.get(name).execute('fixture', input, signal, undefined, ctx),
    close: () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test('real Pi API: six tools, orphan review/follow-up, current checks, stale/uncertain admission fencing and one-step cleanup', () => fixture(async f => {
  await writeFile(join(f.task.directory, 'report.md'), 'Untrusted worker report');
  const fingerprint = await snapshot(f.task, f.runtime);
  await save(join(f.task.directory, 'result.json'), { code: 0, fingerprint });
  await save(join(f.task.directory, `check-0-${randomUUID()}.json`), { index: 0, passed: true, after: fingerprint });
  const h = await host(f);
  try {
    assert.deepEqual([...h.tools.keys()].sort(), ['delegate_cleanup', 'delegate_environments', 'delegate_models', 'delegate_review', 'delegate_revise', 'delegate_task']);
    const review = JSON.parse((await h.invoke('delegate_review', { task: f.task.id })).content[0].text);
    assert.equal(review.status.phase, 'ABSENT'); assert.equal(review.accepted, false); assert.deepEqual(review.missingChecks, []);
    assert.match(await readFile(review.trackedPatch, 'utf8'), /worker change/); assert.equal(review.cleanup.tool, 'delegate_cleanup');
    const theme = { fg: (_color, text) => text, bold: text => text };
    const rendered = h.tools.get('delegate_review').renderResult({ content: [{ type: 'text', text: JSON.stringify(review) }] }, { expanded: true }, theme).render(120).join('\n');
    assert.match(rendered, /Changes collected · review verdict is separate/); assert.match(rendered, /Worker report \(untrusted\)/);
    const input = { task: f.task.id, expectedNonce: f.task.nonce, expectedFingerprint: review.fingerprint, model: 'fixture/model', thinking: 'low', brief: 'Explicit follow-up, not automatic recovery.' };
    const revised = JSON.parse((await h.invoke('delegate_revise', input)).content[0].text);
    assert.equal(revised.worktree, f.task.worktree); assert.ok(revised.attempt);
    await assert.rejects(h.invoke('delegate_revise', input), /nonce changed/); assert.equal(h.submissions(), 1);
    assert.equal((await readdir(f.task.directory)).some(name => /reconcil|revision-after|finaliz|retire/.test(name)), false);
    const current = await json(join(f.task.directory, 'task.json'));
    // No actual worker was launched by the fake backend. It remains safe to
    // inspect/revise explicit failed work without manufacturing an EXITED result.
    const fresh = JSON.parse((await h.invoke('delegate_review', { task: f.task.id })).content[0].text);
    h.uncertain();
    await assert.rejects(h.invoke('delegate_revise', { ...input, expectedNonce: current.nonce, expectedFingerprint: fresh.fingerprint }), /UNKNOWN/);
    const count = h.submissions();
    await assert.rejects(h.invoke('delegate_revise', { ...input, expectedNonce: current.nonce, expectedFingerprint: fresh.fingerprint }), /nonce changed/);
    assert.equal(h.submissions(), count);
    const cleaned = JSON.parse((await h.invoke('delegate_cleanup', f.input)).content[0].text);
    assert.equal(cleaned.archived, false); assert.equal(await present(f.task.directory), false);
    assert.equal(h.entries.at(-1).type, 'pi.delegate.cleaned.v2');
  } finally { h.close(); }
}));

test('real Pi cleanup needs no UI or confirmation, but inspection alone never removes data', async () => {
  for (const hasUI of [true, false]) await fixture(async f => {
    const h = await host(f);
    h.ctx.hasUI = hasUI;
    h.ctx.ui.confirm = async () => { assert.fail('cleanup must not request user confirmation'); };
    try {
      const inspected = JSON.parse((await h.invoke('delegate_cleanup', { task: f.task.id })).content[0].text);
      assert.equal(inspected.task, f.task.id); assert.equal(inspected.removed, undefined);
      assert.ok(await present(f.task.worktree)); assert.ok(await present(f.task.directory));
      const result = JSON.parse((await h.invoke('delegate_cleanup', f.input)).content[0].text);
      assert.equal(result.archived, false); assert.equal(result.summaryRecorded, true);
      assert.equal(await present(f.task.directory), false); assert.equal(await present(f.task.worktree), false);
      assert.equal(h.entries.at(-1).type, 'pi.delegate.cleaned.v2');
      assert.equal(h.entries.at(-1).data.summary, f.input.summary);
    } finally { h.close(); }
  });
});

test('real Pi cleanup still requires disposition and a nonblank handoff summary', () => fixture(async f => {
  const h = await host(f);
  try {
    for (const input of [
      { task: f.task.id, disposition: 'used' },
      { task: f.task.id, summary: 'Retained outcome' },
      { ...f.input, summary: '   ' },
      { ...f.input, disposition: 'unknown' },
      { ...f.input, summary: 'x'.repeat(2001) },
    ]) {
      await assert.rejects(h.invoke('delegate_cleanup', input), /handoff summary required/);
      assert.ok(await present(f.task.worktree)); assert.equal((await json(join(f.task.directory, 'task.json'))).closing === true, false);
    }
  } finally { h.close(); }
}));

test('real Pi cleanup rejects session navigation and cancellation before deletion without a dialog', async () => {
  for (const mode of ['tree', 'aborted']) await fixture(async f => {
    const h = await host(f), controller = new AbortController();
    h.ctx.ui.confirm = async () => { assert.fail('cleanup must not request user confirmation'); };
    if (mode === 'tree') h.ctx.sessionManager.getSessionFile = () => {
      void h.emit('session_tree');
      return join(f.dir, 'orphan-reader.jsonl');
    };
    else controller.abort();
    try {
      await assert.rejects(h.invoke('delegate_cleanup', f.input, controller.signal), /Operation canceled or session changed/);
      assert.ok(await present(f.task.worktree)); assert.equal((await json(join(f.task.directory, 'task.json'))).closing === true, false);
    } finally { h.close(); }
  });
});
