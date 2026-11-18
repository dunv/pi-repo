// Temporary repositories and explicit fake clocks/backend/process observations.
// Never enroll/delete real retained tasks, start daemons/models, or activate Nix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepare, snapshot, save, json, ENTRY, digest } from '../core.mjs';
import { assessRetirement, retirementAuthorization, retireTask } from '../retire.mjs';
import { finalizationGate, finalizationAuthorization, finalizeTask } from '../finalize.mjs';
import { recordContainment, scopeName } from '../containment.mjs';
import { disposalGate } from '../dispose.mjs';
import { automaticPolicy, assessAutomaticEnrollment, automaticEnrollmentAuthorization, enrollAutomaticRetention, runAutomaticRetention } from '../automatic-retention.mjs';

const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const DAY = 86400000;
async function fixture(fn, { finalized = false, largeTool = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-auto-retention-')), repo = join(dir, 'repo');
  try {
    execFileSync(git, ['init', '-q', repo]); await writeFile(join(repo, 'source.txt'), 'initial\n');
    if (largeTool) await writeFile(join(repo, '.gitignore'), '.cache/\n');
    execFileSync(git, ['-C', repo, 'add', '.']);
    execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const runtime = { git, node: process.execPath, pi: '/fixture/pi', flock: '/fixture/flock', ssh: '/fixture/ssh', home: dir, state: join(dir, 'state'),
      launcher: '/fixture/launcher', path: process.env.PATH, retirementProtocol: 1, automaticRetentionProtocol: 1,
      finalizationProtocol: 1, disposalProtocol: 1, containmentProtocol: 1, systemdRun: '/fixture/systemd-run',
      profiles: { fixture: { command: '/fixture/check', args: ['{targets}'] } },
      automaticRetention: { version: 1, id: randomUUID(), repositories: [repo], buildDays: 7, recoveryDays: 30 } };
    const from = { session: randomUUID(), file: join(dir, 'origin.jsonl') }, who = { session: randomUUID(), file: join(dir, 'receiver.jsonl') };
    const task = { ...await prepare({ repo, brief: 'Synthetic expired draft.', model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [] }, runtime, from), nonce: randomUUID() };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce }); await writeFile(join(task.worktree, 'source.txt'), 'obsolete\n');
    if (largeTool) {
      const directory = join(task.worktree, '.cache', 'gobin'); await mkdir(directory, { recursive: true });
      const path = join(directory, 'golangci-lint'); await writeFile(path, 'synthetic rebuildable tool', { mode: 0o700 }); await truncate(path, 69 * 1024 * 1024);
    }
    const job = { session: from.session, file: from.file, namespace: randomUUID(), nonce: task.nonce, id: 5, admitted: true, created: '2026-11-01T00:00:00Z' };
    job.label = `pi:${job.namespace}:${job.nonce}`;
    const entries = [{ type: 'session', version: 3, id: from.session, cwd: repo },
      { type: 'custom', id: 'task', parentId: null, customType: ENTRY, data: task },
      { type: 'custom', id: 'job', parentId: 'task', customType: 'pi-repo.pueue.job.v1', data: job }];
    await writeFile(from.file, entries.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await mkdir(join(task.directory, 'build-output'), { mode: 0o700 }); await writeFile(join(task.directory, 'build-output', 'cache'), 'reproducible cache');
    await save(join(task.directory, 'result.json'), { code: 0, signal: null, backend: 'pi', fingerprint: await snapshot(task, runtime), accepted: false });
    const bootId = randomUUID();
    const processes = async () => ({ bootId, hostIdentity: 'a'.repeat(64), observation: 'current-user-process-reference-scan', uninspectablePids: [777],
      visibilityRecords: [{ pid: 777, startTime: '12345', commandSha256: 'b'.repeat(64), cgroupSha256: 'c'.repeat(64) }], stoppedProof: false });
    const observe = async () => ({ namespace: job.namespace, tasks: [] });
    if (finalized) {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const cgroup = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${scopeName(task.id)}`;
      await recordContainment(task, undefined, { readFile: async path => path.endsWith('boot_id') ? boot : `0::${cgroup}\n`,
        realpath: async path => path, lstat: async () => ({ ino: 123, dev: 27, isDirectory: () => true, isSymbolicLink: () => false }) });
      await mkdir(join(task.directory, 'feedback'), { mode: 0o700 });
      await save(join(task.directory, 'feedback', randomUUID() + '.json'), { task: task.id, nonce: task.nonce, attempt: null, assessment: { reviewStatus: 'partial' } });
      const request = { task: task.id, expectedNonce: task.nonce, expectedFingerprint: await snapshot(task, runtime), disposition: 'discarded' };
      const statuses = [{ nonce: task.nonce, phase: 'EXITED', exitCode: 0 }];
      const gate = await finalizationGate(task, request, runtime, statuses);
      await finalizeTask(task, request, runtime, statuses, finalizationAuthorization(task, request, gate));
    } else {
      const input = { task: task.id, repository: repo, reason: 'Obsolete synthetic draft.' };
      const gate = await assessRetirement(runtime, input, who, async () => null, undefined, processes);
      await retireTask(runtime, { ...input, expectedEvidence: gate.evidence, expectedFingerprint: gate.fingerprint }, who, async () => null,
        retirementAuthorization(gate, who, input.reason), undefined, processes);
    }
    const kind = finalized ? 'finalization' : 'retirement', closedReceipt = await json(join(task.directory, finalized ? 'finalized.json' : 'retired.json'));
    const closedAt = Date.parse(finalized ? closedReceipt.finalizedAt : closedReceipt.retiredAt), now = Date.now();
    const input = { task: task.id, repository: repo, selections: ['build-output', 'recovery'] };
    const assess = () => assessAutomaticEnrollment(runtime, input, who, observe, now, processes);
    const enroll = async (guard, observer = observe) => {
      const gate = await assessAutomaticEnrollment(runtime, input, who, observer, now, processes);
      return enrollAutomaticRetention(runtime, { ...input, expectedEvidence: gate.evidence }, who, observer,
        automaticEnrollmentAuthorization(gate, who), guard, now, processes);
    };
    const run = (time, apply = true, observer = observe, processObserver = processes, guard) => runAutomaticRetention(runtime, { apply }, observer, time, processObserver, guard);
    await fn({ dir, repo, runtime, task, who, from, job, entries, kind, closedAt, now, input, processes, observe, assess, enroll, run });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('policy is explicit, repository-scoped and fixed to approved 7/30-day horizons', async () => {
  for (const change of [{ automaticRetentionProtocol: undefined }, { automaticRetentionProtocol: 2 },
    { automaticRetention: {} }, { automaticRetention: { buildDays: 0 } }]) await fixture(async f => {
    Object.assign(f.runtime, change); await assert.rejects(f.assess());
  });
  await fixture(async f => {
    assert.equal(automaticPolicy(f.runtime).buildDays, 7);
    f.input.repository = f.dir; await assert.rejects(f.assess(), /repository-outside-policy/);
  });
});

test('assessment is read-only; one-time enrollment creates no deletion or fabricated ordinary disposal', () => fixture(async f => {
  const before = await readdir(f.task.directory), gate = await f.assess();
  assert.deepEqual(await readdir(f.task.directory), before);
  assert.equal(gate.deadlines.recovery, new Date(f.closedAt + 30 * DAY).toISOString());
  await f.enroll();
  assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
  assert.equal((await json(join(f.task.directory, 'disposal-claim.json'))).kind, 'automatic-retention-enrollment');
  await assert.rejects(lstat(join(f.task.directory, 'disposed.json')), { code: 'ENOENT' });
  await assert.rejects(f.enroll(), /already-claimed/);
}));

test('weekly expiry removes builds at 7 days and recovery at 30, preserving sessions/logs/claims and original evidence', async () => {
  for (const finalized of [false, true]) await fixture(async f => {
    const original = await readFile(join(f.task.directory, 'task.json')), history = await readFile(f.from.file);
    await writeFile(join(f.task.directory, 'worker.log'), 'retained evidence');
    await f.enroll();
    assert.equal((await f.run(f.closedAt + 7 * DAY - 1)).removedGroups, 0);
    const dry = await f.run(f.closedAt + 7 * DAY, false);
    assert.equal(dry.tasks[0].status, 'eligible'); assert.ok(await lstat(join(f.task.directory, 'build-output')));
    const build = await f.run(f.closedAt + 7 * DAY);
    assert.equal(build.removedGroups, 1); assert.deepEqual(build.tasks[0].removed, ['build-output']);
    await assert.rejects(lstat(join(f.task.directory, 'build-output')), { code: 'ENOENT' });
    assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
    const recovery = await f.run(f.closedAt + 30 * DAY);
    assert.equal(recovery.removedGroups, 1); assert.deepEqual(recovery.tasks[0].removed, ['recovery']);
    await assert.rejects(lstat(join(f.task.directory, f.kind, 'source.bundle')), { code: 'ENOENT' });
    assert.ok(await lstat(join(f.task.directory, f.kind, 'intent.json')));
    assert.equal(await readFile(join(f.task.directory, 'worker.log'), 'utf8'), 'retained evidence');
    assert.deepEqual(await readFile(join(f.task.directory, 'task.json')), original); assert.deepEqual(await readFile(f.from.file), history);
    assert.equal((await f.run(f.closedAt + 60 * DAY)).removedGroups, 0);
  }, { finalized });
});

test('unenrolled tasks are never swept by age and enrollment rejection writes no claim', async () => {
  await fixture(async f => {
    const before = await readdir(f.task.directory);
    assert.deepEqual((await f.run(f.closedAt + 365 * DAY)).tasks, []);
    assert.deepEqual(await readdir(f.task.directory), before);
  });
  for (const mode of ['stale', 'caller', 'policy', 'source-ref', 'receipt', 'protected', 'hardlink', 'missing-group', 'backend', 'namespace', 'cancel', 'recovery-link', 'oversized']) await fixture(async f => {
    const gate = await f.assess(), input = { ...f.input, expectedEvidence: gate.evidence }, authorization = automaticEnrollmentAuthorization(gate, f.who);
    let who = f.who, observe = f.observe;
    if (mode === 'stale') await writeFile(join(f.task.directory, 'build-output', 'cache'), 'changed');
    if (mode === 'caller') who = { ...who, session: randomUUID() };
    if (mode === 'policy') f.runtime.automaticRetention.id = randomUUID();
    if (mode === 'source-ref') execFileSync(git, ['-C', f.repo, 'branch', f.task.branch, f.task.base]);
    if (mode === 'receipt') await writeFile(join(f.task.directory, 'retired.json'), JSON.stringify({}));
    if (mode === 'protected') await writeFile(join(f.task.directory, 'build-output', 'plan'), 'Mailhub approved set');
    if (mode === 'hardlink') await link(f.from.file, join(f.task.directory, 'build-output', 'alias'));
    if (mode === 'missing-group') await rm(join(f.task.directory, 'build-output'), { recursive: true });
    if (mode === 'recovery-link') {
      const bundle = join(f.task.directory, f.kind, 'source.bundle'), external = join(f.dir, 'shared-bundle');
      await writeFile(external, await readFile(bundle)); await rm(bundle); await symlink(external, bundle);
    }
    if (mode === 'oversized') {
      const path = join(f.task.directory, 'build-output', 'oversized'); await writeFile(path, ''); await truncate(path, 16 * 1024 ** 3 + 1);
    }
    if (mode === 'backend') observe = async () => ({ namespace: f.job.namespace, tasks: [{ ...f.job, phase: 'RUNNING' }] });
    if (mode === 'namespace') observe = async () => ({ namespace: randomUUID(), tasks: [] });
    await assert.rejects(enrollAutomaticRetention(f.runtime, input, who, observe, authorization,
      mode === 'cancel' ? () => { throw new Error('canceled'); } : undefined, f.now, f.processes), undefined, mode);
    assert.ok(!(await readdir(f.task.directory)).includes('disposal-claim.json'), mode);
  });
});

test('enrollment reserves the same exclusive disposal slot and cannot be mistaken for completed ordinary disposal', () => fixture(async f => {
  await f.enroll();
  await assert.rejects(disposalGate(f.task, { task: f.task.id, expectedNonce: f.task.nonce,
    expectedFinalization: '0'.repeat(64), selections: ['build-output'] }, f.runtime, {}), /Disposal already claimed/);
  await assert.rejects(lstat(join(f.task.directory, 'disposed.json')), { code: 'ENOENT' });
}, { finalized: true }));

test('enrollment interruption leaves the shared disposal claim, never an automatic retry/enrollment', () => fixture(async f => {
  let guards = 0;
  await assert.rejects(f.enroll(() => { if (++guards === 2) throw new Error('interrupted'); }), /interrupted/);
  assert.ok(await lstat(join(f.task.directory, 'disposal-claim.json')));
  await assert.rejects(f.enroll(), /already-claimed/);
  const report = await f.run(f.closedAt + 365 * DAY);
  assert.equal(report.tasks[0].status, 'skipped');
  assert.equal(report.tasks[0].reason, 'incomplete-enrollment-no-retry');
}));

test('automatic expiry reports active/unknown jobs, changed data, new visibility gaps, boots and incomplete histories as skips', async () => {
  for (const mode of ['active', 'unknown', 'backend-error', 'job-label-reused', 'contradiction', 'boot', 'visibility', 'payload', 'policy', 'pending', 'fake-receipt', 'alias']) await fixture(async f => {
    await f.enroll(); let observe = f.observe, processes = f.processes;
    if (mode === 'active' || mode === 'unknown') observe = async () => ({ namespace: f.job.namespace, tasks: [{ ...f.job, phase: mode === 'active' ? 'RUNNING' : 'UNKNOWN' }] });
    if (mode === 'job-label-reused') observe = async () => ({ namespace: f.job.namespace, tasks: [{ ...f.job, id: 999, phase: 'EXITED', exitCode: 0 }] });
    if (mode === 'contradiction') observe = async () => ({ namespace: f.job.namespace, tasks: [{ ...f.job, phase: 'EXITED', exitCode: 7 }] });
    if (mode === 'backend-error') observe = async () => { throw new Error('secret backend diagnostics must not escape'); };
    if (mode === 'boot') processes = async () => ({ ...await f.processes(), bootId: randomUUID(), hostIdentity: 'd'.repeat(64) });
    if (mode === 'visibility') processes = async () => ({ ...await f.processes(), visibilityRecords: [{ ...((await f.processes()).visibilityRecords[0]), startTime: '54321' }] });
    if (mode === 'payload') await writeFile(join(f.task.directory, 'build-output', 'cache'), 'changed');
    if (mode === 'policy') f.runtime.automaticRetention.id = randomUUID();
    if (mode === 'pending') await save(join(f.task.directory, 'automatic-retention-build-output-claim.json'), { pending: true });
    if (mode === 'fake-receipt') await save(join(f.task.directory, 'automatic-retention-recovery-receipt.json'), { fake: true });
    if (mode === 'alias') await link(f.from.file, join(f.task.directory, 'build-output', 'alias'));
    const report = await f.run(f.closedAt + 31 * DAY, true, observe, processes);
    assert.equal(report.removedGroups, 0, mode); assert.equal(report.tasks[0].status, 'skipped', mode);
    assert.ok(!JSON.stringify(report).includes('secret backend diagnostics'), mode);
    assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
  });
});

test('a real later boot on the independently enrolled host preserves expiry capability without fabricating stopped-worker evidence', () => fixture(async f => {
  await f.enroll();
  const processes = async () => ({ ...await f.processes(), bootId: 'ffffffff-ffff-4fff-afff-ffffffffffff' });
  const report = await f.run(f.closedAt + 30 * DAY, true, f.observe, processes);
  assert.equal(report.removedGroups, 2);
  assert.equal((await json(join(f.task.directory, 'retired.json'))).stoppedProof, false);
}));

test('unrelated recycled numeric job IDs do not acquire original identity or stopped authority', () => fixture(async f => {
  await f.enroll();
  const observe = async () => ({ namespace: f.job.namespace, tasks: [{ id: f.job.id, label: 'unrelated', created: '2026-12-01T00:00:00Z', phase: 'RUNNING' }] });
  assert.equal((await f.run(f.closedAt + 7 * DAY, true, observe)).removedGroups, 1);
}));

test('symlinks are unlinked without following external shared cache targets', () => fixture(async f => {
  const external = join(f.dir, 'shared'); await writeFile(external, 'must stay');
  await symlink(external, join(f.task.directory, 'build-output', 'link'));
  await f.enroll(); assert.equal((await f.run(f.closedAt + 7 * DAY)).removedGroups, 1);
  assert.equal(await readFile(external, 'utf8'), 'must stay');
}));

test('reappeared payloads and changed completed receipts block all subsequent groups', async () => {
  for (const mode of ['reappeared', 'receipt']) await fixture(async f => {
    await f.enroll(); assert.equal((await f.run(f.closedAt + 7 * DAY)).removedGroups, 1);
    if (mode === 'reappeared') await mkdir(join(f.task.directory, 'build-output'));
    else {
      const path = join(f.task.directory, 'automatic-retention-build-output-receipt.json'), row = await json(path);
      row.entriesRemoved++; await writeFile(path, JSON.stringify(row));
    }
    const report = await f.run(f.closedAt + 30 * DAY);
    assert.equal(report.removedGroups, 0); assert.equal(report.tasks[0].status, 'skipped');
    assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
  });
});

test('a partial automatic operation is permanent evidence, not permission to retry', () => fixture(async f => {
  await f.enroll(); let guards = 0;
  const first = await f.run(f.closedAt + 7 * DAY, true, f.observe, f.processes, () => { if (++guards === 2) throw new Error('interrupted'); });
  assert.equal(first.tasks[0].status, 'skipped'); assert.ok(await lstat(join(f.task.directory, 'automatic-retention-build-output-claim.json')));
  const second = await f.run(f.closedAt + 30 * DAY);
  assert.equal(second.removedGroups, 0); assert.equal(second.tasks[0].reason, 'interrupted-automatic-disposal-no-retry');
  assert.ok(await lstat(join(f.task.directory, 'build-output')));
}));

async function host(f, confirm) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo);
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions[0].tools.get('delegate_retention_enroll').definition;
  const runtimePath = join(f.dir, 'runtime.json'), binary = join(f.dir, 'fake-pueue'), backendFile = join(f.dir, 'backend.json');
  await writeFile(runtimePath, JSON.stringify(f.runtime)); await writeFile(backendFile, JSON.stringify({ tasks: {} }));
  await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('pueue 4.0.4');else if(process.argv.includes('status'))console.log(require('node:fs').readFileSync(${JSON.stringify(backendFile)},'utf8'));else process.exitCode=99;\n`, { mode: 0o700 });
  const values = { PI_DELEGATE_RUNTIME: runtimePath, PI_PUEUE_BINARY: binary, PI_PUEUE_CONFIG: join(f.dir, 'config'), PI_PUEUE_DATA: f.dir,
    PI_PUEUE_NAMESPACE: f.job.namespace, PI_PUEUE_PATH: process.env.PATH };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  let confirmations = 0;
  const ctx = { hasUI: true, ui: { confirm: async (...args) => { confirmations++; return confirm(...args); } },
    sessionManager: { getSessionId: () => f.who.session, getSessionFile: () => f.who.file } };
  return { ctx, runtimePath, backendFile, confirmations: () => confirmations,
    invoke: (input, signal) => tool.execute('enrollment', input, signal, undefined, ctx),
    emit: async name => { for (const handler of loaded.extensions[0].handlers.get(name) ?? []) await handler({}); },
    close: () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test('real Pi one-time enrollment assessment is read-only and confirmation explicitly authorizes future unattended irreversible loss', () => fixture(async f => {
  const h = await host(f, async (title, body) => {
    assert.match(title, /automatic expiry/); assert.match(body, /WITHOUT ANOTHER DIALOG/); assert.match(body, /Already overdue/); return true;
  });
  try {
    const before = await readdir(f.task.directory), assessed = JSON.parse((await h.invoke({ ...f.input, inventoryLimit: 1 })).content[0].text);
    assert.equal(h.confirmations(), 0); assert.deepEqual(await readdir(f.task.directory), before);
    assert.equal(assessed.inventoryEntries.length, 1); assert.equal(assessed.nextInventoryOffset, 1);
    const next = JSON.parse((await h.invoke({ ...f.input, inventoryOffset: assessed.nextInventoryOffset, inventoryLimit: 1 })).content[0].text);
    assert.equal(next.expectedEvidence, assessed.expectedEvidence); assert.equal(next.inventoryEntries.length, 1);
    const enrolled = JSON.parse((await h.invoke({ ...f.input, expectedEvidence: assessed.expectedEvidence })).content[0].text);
    assert.equal(enrolled.authority, 'explicit-enrollment-for-automatic-expiry'); assert.equal(h.confirmations(), 1);
    assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
    const cli = execFileSync(process.execPath, [new URL('../automatic-retention.mjs', import.meta.url).pathname, '--runtime', h.runtimePath],
      { encoding: 'utf8', env: process.env });
    assert.equal(JSON.parse(cli).mode, 'dry-run'); assert.equal(JSON.parse(cli).removedGroups, 0);
  } finally { h.close(); }
}));

test('real Pi enrollment denies absent UI, denial, abort, changed caller/source/policy and tree navigation without claims', async () => {
  for (const mode of ['no-ui', 'denied', 'abort', 'caller', 'data', 'tree', 'stale-policy', 'incomplete']) await fixture(async f => {
    const controller = new AbortController();
    const h = await host(f, async () => {
      if (mode === 'abort') controller.abort();
      if (mode === 'caller') h.ctx.sessionManager.getSessionId = () => randomUUID();
      if (mode === 'data') await writeFile(join(f.task.directory, 'build-output', 'cache'), 'changed during dialog');
      if (mode === 'tree') await h.emit('session_tree');
      return mode !== 'denied';
    });
    try {
      const assessed = JSON.parse((await h.invoke(f.input)).content[0].text), request = { ...f.input, expectedEvidence: assessed.expectedEvidence };
      if (mode === 'no-ui') h.ctx.hasUI = false;
      if (mode === 'incomplete') request.expectedEvidence = '0'.repeat(64);
      if (mode === 'stale-policy') await writeFile(h.runtimePath, JSON.stringify({ ...f.runtime, automaticRetention: { ...f.runtime.automaticRetention, id: randomUUID() } }));
      await assert.rejects(h.invoke(request, controller.signal), undefined, mode);
      assert.ok(!(await readdir(f.task.directory)).includes('disposal-claim.json'), mode);
      assert.ok(await lstat(join(f.task.directory, f.kind, 'source.bundle')));
    } finally { h.close(); }
  });
});

test('real-clock runs record actual phase times and recheck later groups against a fresh time', () => fixture(async f => {
  await f.enroll();
  const originalNow = Date.now; let clock = f.closedAt + 31 * DAY;
  Date.now = () => { clock += 100; return clock; };
  try {
    const report = await runAutomaticRetention(f.runtime, { apply: true }, f.observe, undefined, f.processes);
    assert.equal(report.removedGroups, 2);
    const claim = await json(join(f.task.directory, 'automatic-retention-build-output-claim.json'));
    const receipt = await json(join(f.task.directory, 'automatic-retention-build-output-receipt.json'));
    assert.ok(Date.parse(claim.claimedAt) > Date.parse(report.checkedAt));
    assert.ok(Date.parse(receipt.completedAt) > Date.parse(claim.claimedAt));
  } finally { Date.now = originalNow; }
}));

test('demonstrated Go cache markers are sealed with exact exception audit and hashes, not a binary whitelist', () => fixture(async f => {
  const directory = join(f.task.directory, 'build-output', 'external', 'gazelle++non_module_deps+bazel_gazelle_go_repository_cache', 'gocache', 'aa');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'a'.repeat(64) + '-d');
  const body = '!<arch>\n__.PKGDEF       0           0     0     644     12654     `\ngo object linux amd64 go1.27.1 GOAMD64=v1\nRecordNonApprovedsetIndicatorcrypto/internal/fips140';
  await writeFile(path, body);
  const gate = await f.assess(), sealed = gate.seals['build-output'].find(row => row.path.endsWith('-d'));
  assert.deepEqual(sealed.contentExceptions, [{ rule: 'go-fips140-symbol-v1', matches: 1 }]);
  assert.equal(sealed.sha256, digest(body));
  await f.enroll();
  const claim = await json(join(f.task.directory, 'disposal-claim.json'));
  assert.deepEqual(claim.seals['build-output'].find(row => row.path.endsWith('-d')).contentExceptions, sealed.contentExceptions);
  assert.equal((await f.run(f.closedAt + 7 * DAY)).removedGroups, 1);
}));

test('protected operational data in otherwise recognized Go cache bytes blocks before enrollment and leaves no claim', () => fixture(async f => {
  const directory = join(f.task.directory, 'build-output', 'external', 'gazelle++non_module_deps+bazel_gazelle_go_repository_cache', 'gocache', 'aa');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'a'.repeat(64) + '-d');
  await writeFile(path, 'go index v2\ncrypto/tls requires FIPS-approved settings.\nfipstls.go\nfips140tls\0Mailhub Trash-journal unknown-outcome');
  await assert.rejects(f.enroll(), /potential-protected-operational-content/);
  assert.ok(await lstat(path)); assert.ok(!(await readdir(f.task.directory)).includes('disposal-claim.json'));
}));

test('oversized ignored tool is fully preserved through retirement and independently sealable for recovery expiry', () => fixture(async f => {
  const archive = await json(join(f.task.directory, 'retirement', 'local-files.json'));
  const tool = archive.files.find(row => row.name === '.cache/gobin/golangci-lint');
  assert.equal(Buffer.from(tool.base64, 'base64').length, 69 * 1024 * 1024);
  assert.equal(Buffer.from(tool.base64, 'base64').subarray(0, Buffer.byteLength('synthetic rebuildable tool')).toString(), 'synthetic rebuildable tool');
  assert.ok(archive.bytes > 64 * 1024 * 1024 && archive.bytes < 80 * 1024 * 1024);
  const gate = await f.assess(); assert.ok(gate.seals.recovery.some(row => row.path.endsWith('local-files.json')));
  assert.ok(!(await readdir(f.task.directory)).includes('disposal-claim.json'));
}, { largeTool: true }));

test('two concurrent automatic runs have at most one deleting winner and preserve audit receipts', () => fixture(async f => {
  await f.enroll(); const reports = await Promise.all([f.run(f.closedAt + 7 * DAY), f.run(f.closedAt + 7 * DAY)]);
  assert.equal(reports.reduce((sum, report) => sum + report.removedGroups, 0), 1);
  assert.ok(await lstat(join(f.task.directory, 'automatic-retention-build-output-receipt.json')));
}));
