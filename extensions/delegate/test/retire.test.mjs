// Synthetic retained worktrees and fake backend observations. Never retire real
// tasks, start models, mutate cgroups, or weaken ordinary stopped-worker gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, symlink, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { prepare, prepareRevision, snapshot, save, json, digest, ENTRY, writable, runtimeFrom } from '../core.mjs';
import { assertCustody } from '../reconcile.mjs';
import { assertStopped } from '../containment.mjs';
import { assessRetirement, retirementAuthorization, retireTask, observeRetirementProcesses } from '../retire.mjs';

const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
async function fixture(fn, { linked = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-retire-')), main = join(dir, 'main'), repo = linked ? join(dir, 'source') : main;
  try {
    execFileSync(git, ['init', '-q', main]);
    await writeFile(join(main, 'source.txt'), 'original\n'); await writeFile(join(main, '.gitignore'), 'ignored\n');
    execFileSync(git, ['-C', main, 'add', '.']);
    execFileSync(git, ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    if (linked) execFileSync(git, ['-C', main, 'worktree', 'add', '-qb', 'source', repo]);
    const runtime = { git, node: process.execPath, pi: '/fixture/pi', flock: '/fixture/flock', ssh: '/fixture/ssh', home: dir,
      state: join(dir, 'state'), launcher: '/fixture/launcher', path: process.env.PATH, revisionProtocol: 1, retirementProtocol: 1,
      profiles: { fixture: { command: '/fixture/check', args: ['{targets}'] } } };
    const from = { session: randomUUID(), file: join(dir, 'origin.jsonl') }, who = { session: randomUUID(), file: join(dir, 'receiver.jsonl') };
    let task = { ...await prepare({ repo, model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [], brief: 'Synthetic obsolete draft.' }, runtime, from), nonce: randomUUID() };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce });
    await writeFile(join(task.worktree, 'source.txt'), 'obsolete change\n');
    const entries = [{ type: 'session', version: 3, id: from.session, cwd: repo }], namespace = randomUUID();
    const append = data => entries.push({ id: randomUUID(), parentId: entries.length === 1 ? null : entries.at(-1).id, ...data });
    const addJob = current => {
      append({ type: 'custom', customType: ENTRY, data: current });
      append({ type: 'custom', customType: 'pi-repo.pueue.job.v1', data: { session: from.session, file: from.file,
        namespace, nonce: current.nonce, id: entries.length, created: '2026-11-10T08:00:00Z', admitted: true, label: `pi:${namespace}:${current.nonce}` } });
    };
    const persist = () => writeFile(from.file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    addJob(task); await persist();
    const input = { task: task.id, repository: main, reason: 'Obsolete draft superseded by the parent implementation.' };
    const observe = async () => null;
    const assess = () => assessRetirement(runtime, input, who, observe);
    const retire = async (guard, observer = observe) => {
      const gate = await assessRetirement(runtime, input, who, observer);
      const request = { ...input, expectedEvidence: gate.evidence, expectedFingerprint: gate.fingerprint };
      return retireTask(runtime, request, who, observer, retirementAuthorization(gate, who, input.reason), guard);
    };
    const revise = async () => {
      const revised = await prepareRevision(task, { expectedNonce: task.nonce, expectedFingerprint: await snapshot(task, runtime),
        model: 'fixture/model', thinking: 'low', brief: 'Synthetic revision.' }, runtime);
      task = { ...revised, nonce: randomUUID() };
      await save(join(task.directory, 'revisions', task.attempt, 'submission.json'), { nonce: task.nonce });
      addJob(task); await persist(); return task;
    };
    await fn({ dir, main, repo, runtime, task, who, from, entries, addJob, persist, input, observe, assess, retire, revise });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('assessment is read-only and explicitly distinguishes operator abandonment from stopped/terminal proof', () => fixture(async f => {
  const before = await readdir(f.task.directory), gate = await f.assess();
  assert.deepEqual(await readdir(f.task.directory), before);
  assert.equal(gate.authority, 'operator-attested-retirement'); assert.equal(gate.terminalVerified, false); assert.equal(gate.stoppedProof, false);
  assert.equal(gate.attempts[0].backend, 'absent-not-terminal-proof');
  assert.equal(gate.attempts[0].containment, null); assert.equal(gate.attempts[0].result, null);
  await assert.rejects(assertStopped(f.task), /No trusted/); // Ordinary lifecycle is not relaxed.
}));

test('confirmed retirement archives uncontained drafts without rewriting history/results and leaves shared targets/builds intact', () => fixture(async f => {
  const external = join(f.dir, 'external'); await writeFile(external, 'shared');
  await symlink(external, join(f.task.worktree, 'ignored'));
  await mkdir(join(f.task.directory, 'build-output')); await writeFile(join(f.task.directory, 'build-output', 'keep'), 'build');
  const history = await readFile(f.from.file), manifest = await readFile(join(f.task.directory, 'task.json'));
  const receipt = await f.retire();
  assert.equal(receipt.disposition, 'discarded'); assert.equal(receipt.terminalVerified, false); assert.equal(receipt.stoppedProof, false);
  await assert.rejects(lstat(f.task.worktree), { code: 'ENOENT' });
  assert.equal(execFileSync(git, ['-C', f.main, 'branch', '--list', f.task.branch], { encoding: 'utf8' }), '');
  execFileSync(git, ['-C', f.main, 'bundle', 'verify', join(receipt.directory, 'source.bundle')], { stdio: 'pipe' });
  const archive = await json(join(receipt.directory, 'local-files.json'));
  assert.ok(archive.files.some(file => file.name === 'source.txt' && Buffer.from(file.base64, 'base64').toString() === 'obsolete change\n'));
  assert.ok(archive.files.some(file => file.name === 'ignored' && file.symlink === external));
  assert.equal(await readFile(external, 'utf8'), 'shared');
  assert.equal(await readFile(join(f.task.directory, 'build-output', 'keep'), 'utf8'), 'build');
  assert.deepEqual(await readFile(f.from.file), history); assert.deepEqual(await readFile(join(f.task.directory, 'task.json')), manifest);
  await assert.rejects(assertCustody(f.task, f.from), /Retirement claimed/);
  await assert.rejects(writable(f.task, 'source.txt'), /Retirement claimed/);
  await assert.rejects(f.assess(), /interrupted retirement/);
}));

test('complete revision chains retire together and preserve every old continuation claim', () => fixture(async f => {
  await f.revise(); const latest = await f.revise();
  const paths = (await readdir(f.task.directory)).filter(name => name.startsWith('revision-after-'));
  const before = await Promise.all(paths.map(name => readFile(join(f.task.directory, name), 'utf8')));
  assert.equal((await f.assess()).task.nonce, latest.nonce);
  assert.equal((await f.assess()).attempts.length, 3);
  const receipt = await f.retire(); assert.equal(receipt.attempts.length, 3);
  assert.deepEqual(await Promise.all(paths.map(name => readFile(join(f.task.directory, name), 'utf8'))), before);
  await assert.rejects(prepareRevision(latest, { model: 'fixture/model', thinking: 'low' }, f.runtime), /Retirement claimed/);
}));

test('removed linked sources need no reconstruction; worker and main must still prove identical Git repository', () => fixture(async f => {
  execFileSync(git, ['-C', f.main, 'worktree', 'remove', f.repo]);
  const receipt = await f.retire(); assert.equal(receipt.repository.main, f.main);
}, { linked: true }));

test('old boot evidence remains untouched and is never upgraded into current stopped proof', () => fixture(async f => {
  const evidence = { version: 1, task: f.task.id, bootId: randomUUID(), original: 'retained' };
  await save(join(f.task.directory, 'containment.json'), evidence);
  const receipt = await f.retire(); assert.equal(receipt.stoppedProof, false);
  assert.deepEqual(await json(join(f.task.directory, 'containment.json')), evidence);
}));

test('runtime opt-in, private identity, exact admission, protected content and resolved lifecycle gates fail closed', async () => {
  for (const mode of ['runtime', 'history-mode', 'history-link', 'history-task', 'admission', 'claim', 'finalized', 'protected', 'repository', 'mount-symlink', 'staged', 'locked']) await fixture(async f => {
    if (mode === 'runtime') delete f.runtime.retirementProtocol;
    if (mode === 'history-mode') await chmod(f.from.file, 0o644);
    if (mode === 'history-link') { const data = await readFile(f.from.file); await rm(f.from.file); await writeFile(join(f.dir, 'alias'), data); await symlink(join(f.dir, 'alias'), f.from.file); }
    if (mode === 'history-task') { f.entries[1].data = { ...f.task, base: '0'.repeat(40) }; await f.persist(); }
    if (mode === 'admission') { f.entries[2].data.admitted = false; await f.persist(); }
    if (mode === 'claim') await save(join(f.task.directory, `revision-after-${digest(f.task.nonce)}.json`), { attempt: randomUUID(), previousNonce: f.task.nonce });
    if (mode === 'finalized') await mkdir(join(f.task.directory, 'finalization'), { mode: 0o700 });
    if (mode === 'protected') await writeFile(join(f.task.worktree, 'plan.json'), 'mailhub approved set');
    if (mode === 'repository') f.input.repository = f.dir;
    if (mode === 'mount-symlink') { await symlink(f.main, join(f.dir, 'main-alias')); f.input.repository = join(f.dir, 'main-alias'); }
    if (mode === 'staged') execFileSync(git, ['-C', f.task.worktree, 'add', '.']);
    if (mode === 'locked') execFileSync(git, ['-C', f.main, 'worktree', 'lock', f.task.worktree]);
    await assert.rejects(f.retire(), undefined, mode);
    assert.ok(await lstat(f.task.worktree));
    // Assessment-stage errors must not leave a retirement claim.
    assert.ok(!(await readdir(f.task.directory)).includes('retirement-claim.json'), mode);
  });
});

test('active, queued, UNKNOWN, contradictory and failed backend queries never become permission', async () => {
  for (const phase of ['RUNNING', 'QUEUED', 'PAUSED', 'UNKNOWN', 'ADMISSION_UNKNOWN', 'contradiction', 'error']) await fixture(async f => {
    if (phase === 'contradiction') await save(join(f.task.directory, 'result.json'), { code: 0 });
    const observe = async job => {
      if (phase === 'error') throw new Error('backend unavailable');
      return { nonce: job.nonce, phase: phase === 'contradiction' ? 'EXITED' : phase, exitCode: 9 };
    };
    await assert.rejects(f.retire(undefined, observe)); assert.ok(await lstat(f.task.worktree));
    assert.ok(!(await readdir(f.task.directory)).includes('retirement-claim.json'));
  });
});

test('KILLED is recorded only as an observation, not stopped proof', () => fixture(async f => {
  const receipt = await f.retire(undefined, async job => ({ nonce: job.nonce, phase: 'KILLED' }));
  assert.equal(receipt.stoppedProof, false);
  assert.equal((await json(join(receipt.directory, 'intent.json'))).attempts[0].backend, 'KILLED');
}));

test('stale assessment/caller/reason/source/ignored content and forged authorization are rejected before claiming', async () => {
  for (const mode of ['caller', 'reason', 'source', 'ignored', 'authorization', 'missing-expected']) await fixture(async f => {
    const gate = await f.assess(), input = { ...f.input, expectedEvidence: gate.evidence, expectedFingerprint: gate.fingerprint };
    const auth = retirementAuthorization(gate, f.who, f.input.reason);
    let who = f.who;
    if (mode === 'caller') who = { ...who, session: randomUUID() };
    if (mode === 'reason') input.reason = 'Different disposition reason';
    if (mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'changed');
    if (mode === 'ignored') await writeFile(join(f.task.worktree, 'ignored'), 'local config');
    if (mode === 'authorization') auth.stoppedProof = true;
    if (mode === 'missing-expected') delete input.expectedEvidence;
    await assert.rejects(retireTask(f.runtime, input, who, f.observe, auth));
    assert.ok(!(await readdir(f.task.directory)).includes('retirement-claim.json'));
  });
});

test('process cwd, open files, and command-line task references block retirement without signaling processes', async () => {
  for (const mode of ['cwd', 'fd', 'argv']) await fixture(async f => {
    const script = mode === 'fd' ? "require('fs').openSync(process.argv[1], 'r'); console.log('ready'); setInterval(()=>{},1000)" : "console.log('ready'); setInterval(()=>{},1000)";
    const child = spawn(process.execPath, ['-e', script, ...(mode === 'fd' ? [join(f.task.worktree, 'source.txt')] : mode === 'argv' ? [f.task.id] : [])],
      { cwd: mode === 'cwd' ? f.task.worktree : f.main, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      await assert.rejects(observeRetirementProcesses(f.task), /references|file open/);
      await assert.rejects(f.retire(), /references|file open/);
      assert.equal(child.exitCode, null);
    } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
});

test('exclusive claim fences simultaneous retirement; interruption retains claims and prevents retry', async () => {
  await fixture(async f => {
    const results = await Promise.allSettled([f.retire(), f.retire()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  });
  await fixture(async f => {
    let calls = 0;
    await assert.rejects(f.retire(() => { if (++calls === 2) throw new Error('interrupted'); }), /interrupted/);
    assert.ok(await lstat(f.task.worktree));
    await assert.rejects(f.retire(), /[Cc]laim|continuation/);
    await assert.rejects(snapshot(f.task, f.runtime), /Retirement claimed/);
  });
});

test('a newly active backend or local mutation after claim blocks removal and retains recovery/evidence', async () => {
  for (const mode of ['backend', 'local']) await fixture(async f => {
    let calls = 0;
    const observe = async job => (++calls > 2 && mode === 'backend' ? { nonce: job.nonce, phase: 'RUNNING' } : null);
    let guards = 0;
    await assert.rejects(f.retire(() => {
      if (++guards === 2 && mode === 'local') execFileSync(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], 'changed')", join(f.task.worktree, 'ignored')]);
    }, observe));
    assert.ok(await lstat(f.task.worktree));
    assert.ok((await readdir(f.task.directory)).includes('retirement-claim.json'));
  });
});

async function host(f, confirm) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const api = createExtensionRuntime(), entries = [], calls = [];
  api.appendEntry = (...args) => entries.push(args);
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.main, undefined, api);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map([...loaded.extensions[0].tools.values()].map(value => [value.definition.name, value.definition]));
  const binary = join(f.dir, 'fake-pueue'), status = join(f.dir, 'backend.json'), runtimePath = join(f.dir, 'runtime.json');
  await writeFile(status, JSON.stringify({ tasks: {} }));
  await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('pueue 4.0.4');else if(process.argv.includes('status'))console.log(require('node:fs').readFileSync(${JSON.stringify(status)},'utf8'));else process.exitCode=99;\n`, { mode: 0o700 });
  await writeFile(runtimePath, JSON.stringify(f.runtime));
  const env = { PI_DELEGATE_RUNTIME: runtimePath, PI_PUEUE_BINARY: binary, PI_PUEUE_CONFIG: join(f.dir, 'config'), PI_PUEUE_DATA: f.dir,
    PI_PUEUE_NAMESPACE: f.entries[2].data.namespace, PI_PUEUE_PATH: process.env.PATH };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const ctx = { hasUI: true, ui: { confirm: async (...args) => { calls.push(args); return confirm(...args); } },
    sessionManager: { getSessionFile: () => f.who.file, getSessionId: () => f.who.session, getBranch: () => [] },
    executeTool: () => { throw new Error('No nested worker/publication tool permitted'); } };
  return { ctx, calls, entries, runtimePath, status,
    emit: async name => { for (const handler of loaded.extensions[0].handlers.get(name) ?? []) await handler({}); },
    invoke: (input, signal) => tools.get('delegate_retire').execute('retire', input, signal, undefined, ctx),
    close: () => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test('real Pi tool assessment is read-only, confirmation is exact and retirement creates no custody/session reference', () => fixture(async f => {
  const h = await host(f, async (title, body) => {
    assert.match(title, /WITHOUT verified historical stopped proof/);
    assert.match(body, /permission-limited observation/);
    assert.match(body, /old clients/);
    return true;
  });
  try {
    const before = await readdir(f.task.directory), assessed = JSON.parse((await h.invoke(f.input)).content[0].text);
    assert.deepEqual(await readdir(f.task.directory), before); assert.equal(h.calls.length, 0);
    assert.equal(assessed.stoppedProof, false); assert.ok(Array.isArray(assessed.observation.uninspectablePids));
    const receipt = JSON.parse((await h.invoke({ ...f.input, expectedEvidence: assessed.expectedEvidence, expectedFingerprint: assessed.expectedFingerprint })).content[0].text);
    assert.equal(receipt.authority, 'operator-attested-retirement'); assert.equal(h.calls.length, 1); assert.deepEqual(h.entries, []);
    await assert.rejects(lstat(f.task.worktree), { code: 'ENOENT' });
  } finally { h.close(); }
}));

test('real Pi confirmation denies no-UI, denied/aborted/stale/session/backend/runtime/incomplete assessments without claims', async () => {
  for (const mode of ['no-ui', 'denied', 'abort', 'source', 'ignored', 'reason', 'session', 'tree', 'backend', 'runtime', 'incomplete']) await fixture(async f => {
    const controller = new AbortController();
    const h = await host(f, async () => {
      if (mode === 'abort') controller.abort();
      if (mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'changed');
      if (mode === 'ignored') await writeFile(join(f.task.worktree, 'ignored'), 'local');
      if (mode === 'session') h.ctx.sessionManager.getSessionId = () => randomUUID();
      if (mode === 'tree') await h.emit('session_tree');
      if (mode === 'backend') {
        const job = f.entries[2].data;
        await writeFile(h.status, JSON.stringify({ tasks: { [job.id]: { id: job.id, created_at: job.created, label: job.label, status: { Running: {} } } } }));
      }
      return mode !== 'denied';
    });
    try {
      const assessed = JSON.parse((await h.invoke(f.input)).content[0].text);
      const request = { ...f.input, expectedEvidence: assessed.expectedEvidence, expectedFingerprint: assessed.expectedFingerprint };
      if (mode === 'no-ui') h.ctx.hasUI = false;
      if (mode === 'reason') request.reason = 'changed';
      if (mode === 'runtime') await writeFile(h.runtimePath, JSON.stringify({ ...f.runtime, retirementProtocol: undefined }));
      if (mode === 'incomplete') delete request.expectedEvidence;
      await assert.rejects(h.invoke(request, controller.signal), undefined, mode);
      assert.ok(await lstat(f.task.worktree)); assert.deepEqual(h.entries, []);
      assert.ok(!(await readdir(f.task.directory)).includes('retirement-claim.json'), mode);
    } finally { h.close(); }
  });
});

test('runtime parser rejects unreviewed protocol values', () => fixture(async f => {
  const path = join(f.dir, 'runtime.json');
  await writeFile(path, JSON.stringify({ ...f.runtime, retirementProtocol: 2 }));
  await assert.rejects(runtimeFrom(path), /Invalid delegate retirement runtime/);
}));
