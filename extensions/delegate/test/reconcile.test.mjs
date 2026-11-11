// Synthetic retained jobs/history only. No live daemon, model calls or cgroup
// mutation. As in recovery tests, fixture startup records are made via the real
// recorder with a fake kernel view, for unique absent scopes on this boot.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prepare, prepareRevision, snapshot, save, json, digest, ENTRY } from '../core.mjs';
import { recordContainment, scopeName } from '../containment.mjs';
import { assessReconciliation, reconciliationSummary, reconciliationAuthorization, transferReconciliation, assertCustody, reconciledStatus } from '../reconcile.mjs';
import { feedbackTask, writeFeedback } from '../feedback.mjs';
import { finalizationGate, finalizationAuthorization, finalizeTask } from '../finalize.mjs';
import { disposalGate, disposalAuthorization, disposeTask } from '../dispose.mjs';

const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-reconcile-')), repo = join(dir, 'repo');
  try {
    execFileSync(git, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    execFileSync(git, ['-C', repo, 'add', '.']);
    execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const runtime = { git, node: process.execPath, pi: '/fixture/pi', flock: '/fixture/flock', ssh: '/fixture/ssh', home: dir,
      state: join(dir, 'state'), launcher: '/fixture/launcher', path: process.env.PATH, revisionProtocol: 1,
      containmentProtocol: 1, reconciliationProtocol: 1, systemdRun: '/fixture/systemd-run', profiles: { fixture: { command: '/fixture/check', args: ['{targets}'] } } };
    const from = { session: randomUUID(), file: join(dir, 'origin.jsonl') }, to = { session: randomUUID(), file: join(dir, 'receiver.jsonl') };
    const task = { ...await prepare({ repo, model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [], brief: 'Synthetic task.' }, runtime, from), nonce: randomUUID() };
    await save(join(task.directory, 'submission.json'), { nonce: task.nonce });
    await writeFile(join(task.worktree, 'source.txt'), 'worker change\n');
    const worker = { code: 0, signal: null, backend: 'pi', fingerprint: await snapshot(task, runtime), accepted: false };
    await save(join(task.directory, 'result.json'), worker);
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const cgroup = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/app.slice/${scopeName(task.id)}`;
    await recordContainment(task, undefined, { readFile: async path => path.endsWith('boot_id') ? boot : `0::${cgroup}\n`,
      realpath: async path => path, lstat: async () => ({ ino: 123, dev: 27, isDirectory: () => true, isSymbolicLink: () => false }) });
    const job = { session: from.session, file: from.file, namespace: randomUUID(), nonce: task.nonce, id: 47,
      created: '2026-11-11T08:46:00Z', admitted: true };
    job.label = `pi:${job.namespace}:${task.nonce}`;
    const status = { nonce: task.nonce, id: 47, phase: 'EXITED', exitCode: 0 };
    const entries = [{ type: 'session', version: 3, id: from.session, cwd: repo }];
    const append = data => { const entry = { id: randomUUID(), parentId: entries.length === 1 ? null : entries.at(-1).id, ...data }; entries.push(entry); return entry; };
    append({ type: 'custom', customType: 'pi-repo.pueue.job.v1', data: job });
    append({ type: 'custom', customType: ENTRY, data: task });
    const call = append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-review', name: 'delegate_review', arguments: { task: task.id } }] } });
    const review = { task: task.id, status, worker, fingerprint: worker.fingerprint, baseline: { base: task.base }, worktree: task.worktree };
    const result = append({ type: 'message', message: { role: 'toolResult', toolName: 'delegate_review', toolCallId: 'call-review', isError: false,
      content: [{ type: 'text', text: JSON.stringify(review) }] } });
    const persist = () => writeFile(from.file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    await persist();
    const observe = async () => null;
    const assess = () => assessReconciliation(runtime, { task: task.id }, to, observe);
    const input = async () => { const summary = reconciliationSummary(await assess()); return { task: task.id, expectedNonce: summary.expectedNonce,
      expectedFingerprint: summary.expectedFingerprint, expectedEvidence: summary.expectedEvidence }; };
    const transfer = async (args = awaitInput) => {
      const request = args === awaitInput ? await input() : args;
      return transferReconciliation(runtime, request, to, observe, reconciliationAuthorization(request, to));
    };
    const awaitInput = Symbol('assess');
    await fn({ dir, repo, runtime, from, to, task, worker, job, status, entries, call, result, append, persist, observe, assess, input, transfer });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function cleanupFixture(f, recipient = f.to) {
  f.runtime.finalizationProtocol = 1; f.runtime.disposalProtocol = 1;
  const gate = await assessReconciliation(f.runtime, { task: f.task.id }, recipient, f.observe);
  const request = { task: f.task.id, expectedNonce: f.task.nonce, expectedFingerprint: gate.fingerprint, expectedEvidence: gate.evidenceDigest };
  const moved = await transferReconciliation(f.runtime, request, recipient, f.observe, reconciliationAuthorization(request, recipient));
  const task = moved.task, input = { task: task.id, expectedNonce: task.nonce, expectedFingerprint: gate.fingerprint, disposition: 'integrated' };
  await mkdir(join(task.directory, 'feedback'));
  await save(join(task.directory, 'feedback', randomUUID() + '.json'), { task: task.id, nonce: task.nonce,
    attempt: null, reviewedFingerprint: gate.fingerprint, assessment: { reviewStatus: 'reviewed', correctness: 'good' } });
  const context = { who: recipient, observe: f.observe };
  const current = await finalizationGate(task, input, f.runtime, [], undefined, undefined, context);
  return { task, input, context, authorization: finalizationAuthorization(task, input, current) };
}

test('reconciled originals finalize with bound archived provenance then permit separately authorized payload disposal', async () => {
  for (const sameSession of [false, true]) await fixture(async f => {
    const c = await cleanupFixture(f, sameSession ? f.from : f.to);
    const before = await readFile(join(c.task.directory, `revision-after-${digest(c.task.nonce)}.json`), 'utf8');
    const receipt = await finalizeTask(c.task, c.input, f.runtime, [], c.authorization, undefined, undefined, c.context);
    assert.equal(await readFile(join(c.task.directory, `revision-after-${digest(c.task.nonce)}.json`), 'utf8'), before);
    const intent = await json(join(receipt.directory, 'intent.json'));
    assert.equal(intent.statuses[0].phase, 'RECONCILED_EXITED'); assert.equal(intent.statuses[0].backendAuthority, false);
    assert.equal(intent.reconciliationId, c.task.reconciliationId);
    await assert.rejects(assertCustody(c.task, c.context.who), /Finalization claimed/);
    if (sameSession) {
      f.append({ type: 'custom', customType: ENTRY, data: { ...c.task, finalized: receipt } }); await f.persist();
    }
    const input = { task: c.task.id, expectedNonce: c.task.nonce, expectedFinalization: digest(JSON.stringify(receipt)), selections: ['recovery'] };
    const gate = await disposalGate(c.task, input, f.runtime, c.context);
    const disposed = await disposeTask(c.task, input, f.runtime, c.context, disposalAuthorization(c.task, input, gate));
    assert.equal(disposed.entriesRemoved, 2);
    assert.deepEqual(await json(join(c.task.directory, 'result.json')), f.worker);
  });
});

test('reconciled finalization rejects stale archived evidence, wrong custody, unknown backend and occupied workers without deleting', async () => {
  for (const mode of ['history', 'result', 'source', 'backend', 'stopped', 'owner', 'forged-status']) await fixture(async f => {
    const c = await cleanupFixture(f);
    if (mode === 'history') { f.call.message.content[0].arguments.openDiff = true; await f.persist(); }
    if (mode === 'result') await writeFile(join(c.task.directory, 'result.json'), JSON.stringify({ ...f.worker, code: 7 }));
    if (mode === 'source') await writeFile(join(c.task.worktree, 'source.txt'), 'unreviewed');
    if (mode === 'backend') c.context.observe = async () => ({ ...f.status, phase: 'UNKNOWN' });
    if (mode === 'owner') c.context.who = f.from;
    if (mode === 'forged-status') delete c.context.observe;
    const stopped = mode === 'stopped' ? async () => { throw new Error('populated cgroup'); } : undefined;
    await assert.rejects(finalizeTask(c.task, c.input, f.runtime, [{ ...f.status, phase: 'RECONCILED_EXITED', backendAuthority: false }], c.authorization, undefined, stopped, c.context), undefined, mode);
    assert.ok(await readdir(c.task.worktree));
    assert.ok(!(await readdir(c.task.directory)).some(n => n.startsWith('finalization-after-')));
  });
});

test('reconciled finalization has an exclusive second lifecycle claim, preserves custody claims and blocks interrupted retries', () => fixture(async f => {
  const c = await cleanupFixture(f);
  let calls = 0;
  await assert.rejects(finalizeTask(c.task, c.input, f.runtime, [], c.authorization, () => {
    if (++calls === 2) throw new Error('interrupted before worktree removal');
  }, undefined, c.context), /interrupted/);
  assert.ok(await readdir(c.task.worktree));
  assert.ok((await readdir(c.task.directory)).some(n => n.startsWith('finalization-after-')));
  await assert.rejects(assertCustody(c.task, f.to), /Finalization claimed/);
  await assert.rejects(finalizeTask(c.task, c.input, f.runtime, [], c.authorization, undefined, undefined, c.context), /claimed/);
}));

test('assessment is read-only; confirmed foreground transfer retains provenance, original files and blocks the old owner', () => fixture(async f => {
  const before = await readdir(f.task.directory), manifest = await readFile(join(f.task.directory, 'task.json'), 'utf8'), history = await readFile(f.from.file, 'utf8');
  const gate = await f.assess(), summary = reconciliationSummary(gate);
  assert.deepEqual(await readdir(f.task.directory), before);
  assert.equal(summary.backendPresent, false); assert.equal(summary.authority, 'foreground-only');
  assert.equal(summary.provenance, 'original-session-terminal-review-v1');
  assert.equal(gate.stopped.observed, 'removed-cgroup');
  const moved = await f.transfer();
  assert.equal(moved.receipt.accepted, false); assert.deepEqual(moved.task.owner, f.from); assert.deepEqual(moved.task.custodian, f.to);
  await assertCustody(moved.task, f.to);
  await assert.rejects(assertCustody(f.task, f.from), /custody transferred/);
  await assert.rejects(assertCustody(moved.task, { ...f.to, session: randomUUID() }), /custody transferred/);
  const status = await reconciledStatus(moved.task, f.runtime, f.to, f.observe);
  assert.equal(status.phase, 'RECONCILED_EXITED'); assert.equal(status.backendAuthority, false);
  assert.equal(status.exitCode, 0); assert.equal(status.provenance, summary.provenance);
  assert.equal(await readFile(join(f.task.directory, 'task.json'), 'utf8'), manifest);
  assert.equal(await readFile(f.from.file, 'utf8'), history);
  assert.deepEqual(await json(join(f.task.directory, 'result.json')), f.worker);
  await assert.rejects(prepareRevision(f.task, { expectedNonce: f.task.nonce, expectedFingerprint: gate.fingerprint,
    model: 'fixture/model', thinking: 'low', brief: 'Never run.' }, f.runtime), /EEXIST/);
  // Lost append/reload: the same confirmed receiver may restore the immutable
  // receipt into its branch. Another session cannot adopt it by knowing IDs.
  const restored = await f.transfer();
  assert.equal(restored.restored, true); assert.equal(restored.receipt.id, moved.receipt.id);
  await assert.rejects(assessReconciliation(f.runtime, { task: f.task.id }, f.from, f.observe), /custody transferred/);
}));

test('same-session orphan reconciliation survives its own appended calls/results and subsequent foreground collections', () => fixture(async f => {
  const gate = await assessReconciliation(f.runtime, { task: f.task.id }, f.from, f.observe);
  const input = { task: f.task.id, expectedNonce: gate.task.nonce, expectedFingerprint: gate.fingerprint, expectedEvidence: gate.evidenceDigest };
  f.append({ type: 'message', message: { role: 'toolResult', toolName: 'delegate_reconcile', toolCallId: 'assessment', isError: false,
    content: [{ type: 'text', text: JSON.stringify(reconciliationSummary(gate)) }] } });
  f.append({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'transfer', name: 'delegate_reconcile', arguments: input }] } });
  await f.persist();
  const moved = await transferReconciliation(f.runtime, input, f.from, f.observe, reconciliationAuthorization(input, f.from));
  await assertCustody(moved.task, f.from);
  f.append({ type: 'custom', customType: ENTRY, data: moved.task });
  f.append({ type: 'message', message: { role: 'toolResult', toolName: 'delegate_review', toolCallId: 'later-review', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ task: f.task.id, status: await reconciledStatus(moved.task, f.runtime, f.from, f.observe) }) }] } });
  await f.persist();
  const current = await assessReconciliation(f.runtime, { task: f.task.id }, f.from, f.observe);
  const restore = { task: f.task.id, expectedNonce: current.task.nonce, expectedFingerprint: current.fingerprint, expectedEvidence: current.evidenceDigest };
  assert.equal((await transferReconciliation(f.runtime, restore, f.from, f.observe, reconciliationAuthorization(restore, f.from))).restored, true);
}));

test('existing live terminal identity is allowed but active/unknown/contradictory backend and query failures block', () => fixture(async f => {
  assert.ok(await assessReconciliation(f.runtime, { task: f.task.id }, f.to, async () => f.status));
  for (const status of [{ ...f.status, phase: 'RUNNING' }, { ...f.status, phase: 'UNKNOWN' }, { ...f.status, phase: 'KILLED' },
    { ...f.status, exitCode: 7 }, { ...f.status, nonce: randomUUID() }]) {
    await assert.rejects(assessReconciliation(f.runtime, { task: f.task.id }, f.to, async () => status), /contradicts/);
  }
  await assert.rejects(assessReconciliation(f.runtime, { task: f.task.id }, f.to, async () => { throw new Error('backend unavailable'); }), /backend unavailable/);
}));

test('result alone, handoff-like text, copied sessions, forged call ancestry and unadmitted history never establish terminal evidence', async () => {
  for (const mode of ['no-review', 'error', 'copied', 'call', 'sibling', 'task', 'unadmitted', 'nonce', 'result', 'partial', 'symlink', 'public']) await fixture(async f => {
    if (mode === 'no-review') f.entries.pop();
    if (mode === 'error') f.result.message.isError = true;
    if (mode === 'copied') f.entries[0].id = randomUUID();
    if (mode === 'call') f.call.message.content[0].arguments.task = randomUUID();
    if (mode === 'sibling') f.result.parentId = f.entries[2].id;
    if (mode === 'task') f.entries[2].data = { ...f.task, thinking: 'high' };
    if (mode === 'unadmitted') f.job.admitted = false;
    if (mode === 'nonce') f.job.nonce = randomUUID();
    await f.persist();
    if (mode === 'result') await writeFile(join(f.task.directory, 'result.json'), JSON.stringify({ ...f.worker, code: 7 }));
    if (mode === 'partial') await writeFile(f.from.file, '{partial history\n');
    if (mode === 'symlink') { const old = f.from.file + '.old'; await writeFile(old, await readFile(f.from.file), { mode: 0o600 }); await rm(f.from.file); await symlink(old, f.from.file); }
    if (mode === 'public') await chmod(f.from.file, 0o644);
    await assert.rejects(f.assess(), undefined, mode);
    assert.ok(!(await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
  });
});

test('stopped proof, manifest/worktree binding, revisions, existing claims and fresh expected fields are mandatory', async () => {
  for (const mode of ['boot', 'containment', 'revision', 'claim', 'manifest', 'head', 'fingerprint', 'evidence', 'authorization', 'disabled']) await fixture(async f => {
    const input = await f.input();
    if (mode === 'disabled') delete f.runtime.reconciliationProtocol;
    if (mode === 'boot') { const file = join(f.task.directory, 'containment.json'); const data = await json(file); await writeFile(file, JSON.stringify({ ...data, bootId: randomUUID() })); }
    if (mode === 'containment') await rm(join(f.task.directory, 'containment.json'));
    if (mode === 'revision') await mkdir(join(f.task.directory, 'revisions'));
    if (mode === 'claim') await save(join(f.task.directory, `revision-after-${digest(f.task.nonce)}.json`), { attempt: randomUUID() });
    if (mode === 'manifest') { const file = join(f.task.directory, 'task.json'); const data = await json(file); await writeFile(file, JSON.stringify({ ...data, checks: [{ kind: 'test', targets: ['changed'] }] })); }
    if (mode === 'head') execFileSync(git, ['-C', f.task.worktree, 'symbolic-ref', 'HEAD', 'refs/heads/moved']);
    if (mode === 'fingerprint') await writeFile(join(f.task.worktree, 'source.txt'), 'not reviewed\n');
    if (mode === 'evidence') { f.call.message.content[0].arguments.openDiff = true; await f.persist(); }
    await assert.rejects(transferReconciliation(f.runtime, input, f.to, f.observe,
      mode === 'authorization' ? undefined : reconciliationAuthorization(input, f.to)), undefined, mode);
  });
});

test('exclusive claim fences concurrent transfer, revision and interrupted transfer; pending claims are never cleared', () => fixture(async f => {
  const input = await f.input();
  const outcomes = await Promise.allSettled([f.transfer(input), f.transfer(input)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await readdir(f.task.directory)).filter(name => name.startsWith('revision-after-')).length, 1);
}));

test('transfer races with an ordinary revision on the same permanent continuation claim', () => fixture(async f => {
  const input = await f.input();
  const outcomes = await Promise.allSettled([f.transfer(input), prepareRevision(f.task, { ...input,
    model: 'fixture/model', thinking: 'low', brief: 'Synthetic revision, never submitted.' }, f.runtime)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const claim = await json(join(f.task.directory, `revision-after-${digest(f.task.nonce)}.json`));
  assert.equal(Boolean(claim.reconciliation) !== Boolean(claim.attempt), true);
}));

test('partial receipt/persistence failures never silently release the claim or grant custody', () => fixture(async f => {
  const input = await f.input(); let guards = 0;
  await assert.rejects(transferReconciliation(f.runtime, input, f.to, f.observe, reconciliationAuthorization(input, f.to), () => {
    if (++guards === 2) writeFileSync(join(f.task.directory, 'reconciliation.json'), '{partial receipt', { mode: 0o600 });
  }), /EEXIST/);
  await assert.rejects(f.assess(), /Invalid\/private/);
  await assert.rejects(assertCustody(f.task, f.from), /Invalid\/private/);
  assert.ok((await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
}));

test('receipt tampering is rejected against the exclusive claim and bound authorization', () => fixture(async f => {
  const moved = await f.transfer(), file = join(f.task.directory, 'reconciliation.json');
  for (const mutate of [r => { r.evidence.terminal.exitCode = 7; }, r => { r.to.session = randomUUID(); },
    r => { r.authority = 'worker-retry'; }, r => { r.fingerprint = '0'.repeat(64); }, r => { r.authorization.evidence = 'a'.repeat(64); }]) {
    const receipt = structuredClone(moved.receipt); mutate(receipt);
    await writeFile(file, JSON.stringify(receipt));
    await assert.rejects(assertCustody(moved.task, f.to), /custody transferred|binding changed/);
  }
}));

test('abort after claiming leaves a fail-closed pending record and no receiving grant', () => fixture(async f => {
  const input = await f.input(); let guards = 0;
  await assert.rejects(transferReconciliation(f.runtime, input, f.to, f.observe, reconciliationAuthorization(input, f.to), () => {
    if (++guards === 2) throw new Error('aborted after claim');
  }), /aborted after claim/);
  assert.ok(!(await readdir(f.task.directory)).includes('reconciliation.json'));
  await assert.rejects(assertCustody(f.task, f.from), /pending/);
  await assert.rejects(f.assess(), /already claimed|interrupted/);
}));

test('foreground edits require fresh review; feedback records archived provenance, never live backend success', () => fixture(async f => {
  const moved = await f.transfer();
  await writeFile(join(f.task.worktree, 'source.txt'), 'reviewed foreground fixes\n');
  const fingerprint = await snapshot(moved.task, f.runtime), status = await reconciledStatus(moved.task, f.runtime, f.to, f.observe);
  const entries = [{ type: 'custom', customType: ENTRY, data: moved.task }];
  const input = { task: f.task.id, expectedNonce: f.task.nonce, reviewStatus: 'reviewed', usefulness: 'useful', correctness: 'good',
    instructionFollowing: 'good', reviewEffort: 'moderate', wouldDelegateAgain: 'yes', rationale: 'Synthetic review.',
    evidence: ['Synthetic checks only.'], problems: [], improvements: [], reviewedFingerprint: fingerprint };
  assert.equal(feedbackTask(entries, f.to, input), moved.task);
  await assert.rejects(async () => feedbackTask(entries, f.from, input), /not owned/);
  const record = await writeFeedback(f.runtime, moved.task, input, [status], f.to);
  const saved = await json(record.path);
  assert.equal(saved.execution.phase, 'RECONCILED_EXITED'); assert.equal(saved.execution.backendAuthority, false);
  assert.equal(saved.reviewedFingerprint, fingerprint); assert.equal(saved.accepted, false);
  await writeFile(join(f.task.directory, 'result.json'), JSON.stringify({ ...f.worker, code: 7 }));
  await assert.rejects(reconciledStatus(moved.task, f.runtime, f.to, f.observe), /evidence changed/);
}));

async function host(f, confirm = async () => true) {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const entries = [], api = createExtensionRuntime(), calls = [];
  api.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, api);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map([...loaded.extensions[0].tools.values()].map(x => [x.definition.name, x.definition]));
  const binary = join(f.dir, 'fake-pueue'), backendFile = join(f.dir, 'backend.json');
  await writeFile(backendFile, JSON.stringify({ tasks: {} }));
  await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('pueue 4.0.4');else if(process.argv.includes('status'))console.log(require('node:fs').readFileSync(${JSON.stringify(backendFile)},'utf8'));else process.exitCode=99;\n`, { mode: 0o700 });
  const runtimePath = join(f.dir, 'runtime.json'); await writeFile(runtimePath, JSON.stringify(f.runtime));
  const values = { PI_DELEGATE_RUNTIME: runtimePath, PI_PUEUE_BINARY: binary, PI_PUEUE_CONFIG: join(f.dir, 'config'), PI_PUEUE_DATA: f.dir,
    PI_PUEUE_NAMESPACE: f.job.namespace, PI_PUEUE_PATH: process.env.PATH, PI_PUEUE_CONFIRM_SUBMIT: '0' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  const ctx = { hasUI: true, ui: { confirm: async (...args) => { calls.push('confirm'); return confirm(...args); } },
    sessionManager: { getSessionFile: () => f.to.file, getSessionId: () => f.to.session, getBranch: () => entries },
    executeTool: async name => { calls.push(name); throw new Error('No Pueue mutation or foreign ownership workaround allowed'); } };
  return { ctx, entries, tools, calls,
    backend: tasks => writeFile(backendFile, JSON.stringify({ tasks })),
    emit: async name => { for (const fn of loaded.extensions[0].handlers.get(name) ?? []) await fn({}); },
    invoke: (name, input, signal) => tools.get(name).execute(name, input, signal, undefined, ctx),
    close: () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } } };
}
const data = result => JSON.parse(result.content[0].text);

test('real Pi loader registers assessment, confirmation, collection/feedback and denies workers or unconfigured cleanup', () => fixture(async f => {
  const h = await host(f);
  try {
    const assessed = data(await h.invoke('delegate_reconcile', { task: f.task.id }));
    assert.deepEqual(h.calls, []); assert.equal(h.entries.length, 0);
    const input = { task: f.task.id, expectedNonce: assessed.expectedNonce, expectedFingerprint: assessed.expectedFingerprint, expectedEvidence: assessed.expectedEvidence };
    const transferred = data(await h.invoke('delegate_reconcile', input));
    assert.equal(transferred.authority, 'foreground-only'); assert.deepEqual(h.calls, ['confirm']);
    assert.equal(h.entries.length, 1);
    const review = data(await h.invoke('delegate_review', { task: f.task.id }));
    assert.equal(review.status.phase, 'RECONCILED_EXITED'); assert.equal(review.accepted, false);
    assert.equal(review.finalization.tool, 'delegate_finalize');
    const feedback = data(await h.invoke('delegate_feedback', { task: f.task.id, expectedNonce: f.task.nonce,
      reviewStatus: 'partial', usefulness: 'not_assessed', correctness: 'not_assessed', instructionFollowing: 'not_assessed',
      reviewEffort: 'low', wouldDelegateAgain: 'unsure', rationale: 'Fixture partial review only.', problems: [], improvements: [], evidence: [] }));
    assert.equal((await json(feedback.path)).execution.phase, 'RECONCILED_EXITED');
    assert.equal(feedback.finalization.tool, 'delegate_finalize');
    assert.equal(await readFile(review.trackedPatch, 'utf8'), execFileSync(git, ['-C', f.task.worktree, 'diff', '--binary', 'HEAD'], { encoding: 'utf8' }));
    assert.equal(data(await h.invoke('delegate_review', {}))[0].task, f.task.id);
    for (const name of ['delegate_revise', 'delegate_resume']) {
      await assert.rejects(h.invoke(name, { ...input, model: 'fixture/model', thinking: 'low', brief: 'Never start.', disposition: 'discarded' }), /foreground review\/editing only/);
    }
    await assert.rejects(h.invoke('delegate_finalize', { ...input, disposition: 'discarded' }), /runtime/);
    const originCtx = { ...h.ctx, sessionManager: { getSessionFile: () => f.from.file, getSessionId: () => f.from.session, getBranch: () => f.entries } };
    for (const name of ['delegate_review', 'delegate_revise', 'delegate_resume', 'delegate_finalize']) {
      await assert.rejects(h.tools.get(name).execute(name, { ...input, model: 'fixture/model', thinking: 'low', brief: 'Never run.', disposition: 'discarded' }, undefined, undefined, originCtx), /custody transferred/);
    }
    assert.deepEqual(h.calls, ['confirm']);
  } finally { h.close(); }
}));

test('real backend projection rejects reused identities and malformed snapshots, accepts only exact terminal binding', () => fixture(async f => {
  const h = await host(f);
  const raw = { id: f.job.id, created_at: f.job.created, label: f.job.label, status: { Done: { result: 'Success' } } };
  try {
    await h.backend({ [raw.id]: raw });
    assert.equal(data(await h.invoke('delegate_reconcile', { task: f.task.id })).backendPresent, true);
    for (const task of [{ ...raw, label: 'different-job' }, { ...raw, created_at: '2026-11-11T09:00:00Z' },
      { ...raw, status: { Done: { result: { Failed: 7 } } } }, { ...raw, status: { Done: { result: 'Killed' } } },
      { ...raw, status: {} }, { ...raw, created_at: null }]) {
      await h.backend({ [raw.id]: task });
      await assert.rejects(h.invoke('delegate_reconcile', { task: f.task.id }));
    }
    assert.equal(h.entries.length, 0); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
}));

test('no UI, denied approval, abort, namespace mismatch and changed-during-dialog state create no grant', async () => {
  for (const mode of ['no-ui', 'denied', 'abort', 'source', 'history', 'namespace', 'session', 'tree', 'backend']) await fixture(async f => {
    const controller = new AbortController();
    const h = await host(f, async () => {
      if (mode === 'source') await writeFile(join(f.task.worktree, 'source.txt'), 'changed during dialog\n');
      if (mode === 'history') { f.call.message.content[0].arguments.openDiff = true; await f.persist(); }
      if (mode === 'abort') controller.abort();
      if (mode === 'session') h.ctx.sessionManager.getSessionId = () => randomUUID();
      if (mode === 'tree') await h.emit('session_tree');
      if (mode === 'backend') await h.backend({ [f.job.id]: { id: f.job.id, created_at: f.job.created, label: f.job.label, status: { Running: {} } } });
      return mode !== 'denied';
    });
    try {
      const input = await f.input();
      if (mode === 'no-ui') h.ctx.hasUI = false;
      if (mode === 'namespace') process.env.PI_PUEUE_NAMESPACE = randomUUID();
      await assert.rejects(h.invoke('delegate_reconcile', input, controller.signal));
      assert.equal(h.entries.length, 0);
      assert.ok(!(await readdir(f.task.directory)).some(name => name.startsWith('revision-after-')));
    } finally { h.close(); }
  });
});
