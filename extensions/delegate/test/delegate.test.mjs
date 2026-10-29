// No daemon, model calls, real project toolchains or live extension/settings changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { initiatorLabel, prepare, prepareRevision, attemptDirectory, validateInput, verificationProfile, snapshot, writable, json, save, envFor, tasksFrom, ENTRY } from '../core.mjs';
import { run } from '../run.mjs';
import { check } from '../check.mjs';
import { toolSummary } from '../progress.mjs';

// Always exercise the real host loader; allow an explicit SDK override.
const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;

const executable = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const gitBin = executable('git'), flock = executable('flock');
const input = repo => ({ repo, brief: 'Mechanical: change source.txt only. Accept when its content is updated. Self-review the diff.',
  model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [{ kind: 'test', targets: ['//:ok'] }] });
const who = { session: 'fixture-session', file: '/fixture/session.jsonl' };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-delegate-')), repo = join(dir, 'repo with spaces');
  const git = (...args) => execFileSync(gitBin, ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    execFileSync(gitBin, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    await writeFile(join(repo, '.gitignore'), 'ignored\n');
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
    const pi = join(dir, 'fake-pi'), verifier = join(dir, 'fake-verifier');
    await writeFile(pi, `#!${process.execPath}\nconst fs=require('node:fs');
const priorSource=fs.readFileSync('source.txt','utf8');
fs.writeFileSync('source.txt','worker changed\\n'); fs.writeFileSync('new.txt','new\\n');
fs.writeFileSync(${JSON.stringify(join(dir, 'pi-argv.json'))}, JSON.stringify({args:process.argv.slice(2),priorSource,secret:process.env.UNAPPROVED_TOKEN,cwd:process.cwd()}));
console.log('Worker self-review: changes made, main-agent review required.');\n`, { mode: 0o700 });
    await writeFile(verifier, `#!${process.execPath}\nconst fs=require('node:fs');
console.log(JSON.stringify({args:process.argv.slice(2),secret:process.env.UNAPPROVED_TOKEN}));
if(process.argv.includes('//:mutate')) fs.writeFileSync('source.txt','check mutated source\\n');
if(process.argv.includes('//:fail')) process.exit(7);\n`, { mode: 0o700 });
    const runtime = { git: gitBin, profiles: { fixture: { command: verifier, args: ['--workspace={worktree}', '--output={outputBase}', '{kind}', '{targets}'] } }, pi, node: process.execPath, flock, ssh: '/fixture/batch-ssh', launcher: '/fixture/launcher', revisionProtocol: 1,
      home: dir, state: join(dir, 'state'), path: process.env.PATH };
    const runtimePath = join(dir, 'runtime.json'); await save(runtimePath, runtime);
    await fn({ dir, repo, git, runtime, runtimePath });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('tool previews show bounded call details without file bodies or terminal controls', () => {
  assert.equal(toolSummary('read', { path: 'docs/file.md', offset: 10, limit: 20, secret: 'HIDDEN' }),
    '{"path":"docs/file.md","offset":10,"limit":20}');
  assert.equal(toolSummary('grep', { pattern: 'TODO', path: 'src', literal: true }),
    '{"pattern":"TODO","path":"src","literal":true}');
  assert.equal(toolSummary('delegate_check', { index: 0 }), '{"index":0}');
  assert.equal(toolSummary('write', { path: 'file', content: 'PRIVATE' }), '{"path":"file","bytes":7}');
  assert.equal(toolSummary('edit', { path: 'file', edits: [{ oldText: 'PRIVATE', newText: 'HIDDEN' }] }),
    '{"path":"file","replacements":1}');
  assert.equal(toolSummary('unknown', { secret: 'HIDDEN' }), '{}');
  const escaped = toolSummary('read', { path: '\n\x1b[31m\u202e' });
  assert.doesNotMatch(escaped, /[\n\x1b\u202e]/);
  assert.ok(toolSummary('grep', { pattern: 'x'.repeat(10000), path: 'y'.repeat(10000), glob: 'z'.repeat(10000) }).length <= 401);
});

test('bounded explicit input: no fuzzy models, shell, flags or missing thinking', () => {
  validateInput(input('/fixture/repo'));
  for (const override of [{ repo: 'relative' }, { model: 'model' }, { thinking: undefined },
    { checks: [{ kind: 'test', targets: ['--run_under=sh'] }] }, { checks: [{ kind: 'test', targets: ['//:ok; touch /tmp/no'] }] },
    { checks: [{ kind: 'shell', targets: ['//:ok'] }] }]) assert.throws(() => validateInput({ ...input('/fixture/repo'), ...override }));
});

test('initiator labels are bounded path-safe names plus stable distinct session identity', () => {
  assert.match(initiatorLabel(who), /^session-s[a-f0-9]{8}$/);
  assert.equal(initiatorLabel({ session: '1234abcd-1234-1234-1234-123456789abc', name: 'Cart fixes' }), 'cart-fixes-s1234abcd');
  const owner = { ...who, name: '  Fix Checkout / Carts!  ' };
  assert.match(initiatorLabel(owner), /^fix-checkout-carts-s[a-f0-9]{8}$/);
  assert.equal(initiatorLabel(owner), initiatorLabel(owner));
  assert.notEqual(initiatorLabel(owner), initiatorLabel({ ...owner, session: 'other-session' }));
  for (const name of ['../outside/$(cmd)\u001b\n', '🚀', 'x'.repeat(500), '.git']) {
    const label = initiatorLabel({ ...who, name });
    assert.match(label, /^[a-z0-9-]+-s[a-f0-9]{8}$/);
    assert.ok(label.length <= 38); assert.doesNotMatch(label, /[/.\s]/);
  }
});

test('new worktree suffix exposes initiator and retains full UUID without renaming revisions', () => fixture(async f => {
  const owner = { ...who, name: 'Fix checkout / totals' }, task = await prepare(input(f.repo), f.runtime, owner);
  assert.equal(task.initiatorLabel, initiatorLabel(owner));
  assert.equal(task.worktree, join(f.repo + '.worktrees', `delegate-${task.initiatorLabel}-${task.id}`));
  assert.deepEqual((await json(join(task.directory, 'task.json'))).owner, owner);
  const revision = await prepareRevision({ ...task, nonce: 'prior' }, { expectedNonce: 'prior',
    expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise.', model: 'fixture/model', thinking: 'low' }, f.runtime);
  assert.equal(revision.worktree, task.worktree); assert.equal(revision.initiatorLabel, task.initiatorLabel);
}));

test('prepare retains isolated uncommitted worktree, exact base and durable identity; parent unchanged', () => fixture(async f => {
  const head = f.git('rev-parse', 'HEAD').trim(), task = await prepare(input(f.repo), f.runtime, who);
  assert.equal(task.base, head); assert.equal(task.worktree.startsWith(f.repo + '.worktrees/'), true);
  assert.deepEqual(await json(join(task.directory, 'task.json')), task);
  assert.equal(await readFile(join(task.directory, 'brief.md'), 'utf8'), input(f.repo).brief);
  assert.equal(f.git('status', '--porcelain'), '');
  await writeFile(join(task.worktree, 'source.txt'), 'worker only\n');
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'original\n');
  assert.notEqual(await snapshot(task, f.runtime), head);
}));

test('verification profiles are explicit, validated and frozen per task', () => fixture(async f => {
  const profile = f.runtime.profiles.fixture;
  for (const invalid of [undefined, { ...profile, command: 'relative' },
    { ...profile, args: ['{targets}', '{targets}'] }, { ...profile, args: ['prefix{targets}'] },
    { ...profile, args: ['{unknown}', '{targets}'] }, { ...profile, args: ['bad\narg', '{targets}'] }]) {
    assert.throws(() => verificationProfile(invalid), /Verification profile/);
  }
  await assert.rejects(prepare({ ...input(f.repo), profile: 'missing' }, f.runtime, who), /Verification profile/);
  assert.equal(f.git('branch', '--list', 'delegate/*'), '');
  const spec = { ...input(f.repo), checks: [{ kind: 'build', targets: ['src/unit.test.ts', 'package:test'] }] };
  const task = await prepare(spec, f.runtime, who);
  assert.deepEqual(task.verification, profile);
  // Later runtime configuration must not replan an admitted task's command.
  const altered = { ...f.runtime, profiles: { fixture: { command: '/missing-command', args: ['{targets}'] } } };
  await writeFile(f.runtimePath, JSON.stringify(altered));
  assert.equal(await check(f.runtimePath, task.id, 0), 0);
  const name = (await readdir(task.directory)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(task.directory, name));
  const log = JSON.parse(await readFile(record.log, 'utf8'));
  assert.deepEqual(log.args.slice(-3), ['build', 'src/unit.test.ts', 'package:test']);
}));

test('source dirty/untracked changes fail before creating a task; ignored caches do not', () => fixture(async f => {
  await writeFile(join(f.repo, 'new.txt'), 'untracked');
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /uncommitted/);
  await rm(join(f.repo, 'new.txt')); await writeFile(join(f.repo, 'ignored'), 'cache');
  await prepare(input(f.repo), f.runtime, who);
}));

test('write boundary rejects traversal, protected configuration and symlink escapes', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await writable(task, 'new/nested/source.go');
  for (const path of ['../other', '.git', '.pi/settings.json', '.agents/policy.md']) await assert.rejects(writable(task, path));
  await symlink(f.dir, join(task.worktree, 'outside'));
  await assert.rejects(writable(task, 'outside/secret'), /symlink/);
  await symlink(join(task.worktree, '.git'), join(task.worktree, 'git-link'));
  await assert.rejects(writable(task, 'git-link'), /symlink/);
}));

test('fake worker: fresh persistent session, explicit model/thinking, minimal environment, one-shot execution', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  process.env.UNAPPROVED_TOKEN = 'fixture-never-forward';
  try { assert.equal(await run(f.runtimePath, task.id), 0); } finally { delete process.env.UNAPPROVED_TOKEN; }
  const invocation = await json(join(f.dir, 'pi-argv.json'));
  assert.equal(invocation.secret, undefined); assert.equal(invocation.cwd, task.worktree);
  for (const flag of ['--no-extensions', '--no-skills', '--no-approve', '--no-mcp', '--session-dir', '--print']) assert.ok(invocation.args.includes(flag));
  assert.equal(invocation.args[invocation.args.indexOf('--thinking') + 1], 'low');
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'model');
  assert.equal(invocation.args.includes('--no-session'), false);
  assert.equal(invocation.args.join(' ').includes('bash,'), false);
  assert.equal((await json(join(task.directory, 'result.json'))).accepted, false);
  assert.equal(f.git('status', '--porcelain'), '');
  await assert.rejects(run(f.runtimePath, task.id), /clean worktree|EEXIST/);
}));

test('worker output is visible before exit and retained in separate artifacts', () => fixture(async f => {
  const release = join(f.dir, 'release');
  await writeFile(f.runtime.pi, `#!${process.execPath}
const fs = require('node:fs');
console.log('early stdout'); console.error('early stderr');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('final report'); } }, 10);
setTimeout(() => process.exit(9), 5000).unref();
`, { mode: 0o700 });
  const task = await prepare(input(f.repo), f.runtime, who);
  const child = spawn(process.execPath, [new URL('../run.mjs', import.meta.url).pathname, f.runtimePath, task.id],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', released = false;
  const releaseWhenLive = () => {
    if (!released && out.includes('early stdout') && err.includes('early stderr')) {
      assert.equal(child.exitCode, null);
      released = true; void writeFile(release, 'continue');
    }
  };
  child.stdout.on('data', data => { out += data; releaseWhenLive(); });
  child.stderr.on('data', data => { err += data; releaseWhenLive(); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, err); assert.equal(released, true);
  assert.match(out, /Worker starting:.*model=fixture\/model requested-thinking=low/);
  assert.equal(await readFile(join(task.directory, 'report.md'), 'utf8'), 'early stdout\nfinal report\n');
  assert.equal(await readFile(join(task.directory, 'worker.log'), 'utf8'), 'early stderr\n');
}));

test('dirty task verification: configured literal command, isolated output, source fingerprint and duration', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await writeFile(join(task.worktree, 'source.txt'), 'uncommitted implementation\n');
  assert.equal(await check(f.runtimePath, task.id, 0), 0);
  const recordPath = (await readdir(task.directory)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(task.directory, recordPath));
  assert.equal(record.passed, true); assert.equal(record.before, record.after); assert.ok(record.elapsedMs >= 0);
  const log = JSON.parse(await readFile(record.log, 'utf8'));
  assert.deepEqual(log.args, ['--workspace=' + task.worktree,
    '--output=' + join(task.directory, 'build-output'), 'test', '//:ok']);
  const before = record.after;
  await writeFile(join(task.worktree, 'new.txt'), 'new file must invalidate check\n');
  assert.notEqual(await snapshot(task, f.runtime), before);
}));

test('mutating/failing checks do not pass, unplanned checks never execute', () => fixture(async f => {
  const spec = input(f.repo); spec.checks = [{ kind: 'test', targets: ['//:mutate'] }, { kind: 'test', targets: ['//:fail'] }];
  const task = await prepare(spec, f.runtime, who);
  assert.equal(await check(f.runtimePath, task.id, 0), 1);
  assert.equal(await check(f.runtimePath, task.id, 1), 1);
  await assert.rejects(check(f.runtimePath, task.id, 2), /Unplanned/);
}));

test('changed worker HEAD is never accepted as verification evidence', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  execFileSync(gitBin, ['-C', task.worktree, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '--allow-empty', '-qm', 'unexpected']);
  await assert.rejects(snapshot(task, f.runtime), /HEAD changed/);
}));

test('explicit revision reuses dirty source and build state, while retaining per-attempt evidence', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const originalResult = await readFile(join(task.directory, 'result.json'), 'utf8');
  const originalReport = await readFile(join(task.directory, 'report.md'), 'utf8');
  await mkdir(join(task.directory, 'build-output'));
  await writeFile(join(task.directory, 'build-output', 'cache-sentinel'), 'retained cache');
  await writeFile(join(task.worktree, 'source.txt'), 'parent review feedback\n');
  const bound = { ...task, nonce: 'previous-job' };
  const spec = { expectedNonce: bound.nonce, expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise the existing changes.', model: 'fixture/model', thinking: 'minimal' };
  const revision = await prepareRevision(bound, spec, f.runtime), artifacts = attemptDirectory(task, revision.attempt);
  assert.equal(revision.worktree, task.worktree); assert.equal(revision.base, task.base); assert.equal(revision.branch, task.branch);
  assert.equal(revision.nonce, undefined); assert.equal(revision.previousNonce, bound.nonce);
  assert.deepEqual(await json(join(task.directory, 'task.json')), task, 'Original manifest stays immutable');
  await assert.rejects(prepareRevision(bound, spec, f.runtime), /EEXIST/, 'Duplicate parent claim never permits another attempt');
  assert.equal(await run(f.runtimePath, task.id, revision.attempt), 0);
  const invocation = await json(join(f.dir, 'pi-argv.json'));
  assert.equal(invocation.priorSource, 'parent review feedback\n');
  assert.equal(invocation.args[invocation.args.indexOf('--thinking') + 1], 'minimal');
  assert.equal(invocation.args[invocation.args.indexOf('--session-dir') + 1], join(artifacts, 'sessions'));
  assert.equal(await readFile(join(task.directory, 'result.json'), 'utf8'), originalResult);
  assert.equal(await readFile(join(task.directory, 'report.md'), 'utf8'), originalReport);
  assert.equal(await readFile(join(task.directory, 'build-output', 'cache-sentinel'), 'utf8'), 'retained cache');
  assert.equal(await check(f.runtimePath, task.id, 0, revision.attempt), 0);
  const name = (await readdir(artifacts)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(artifacts, name));
  const args = JSON.parse(await readFile(record.log, 'utf8')).args;
  assert.ok(args.includes('--output=' + join(task.directory, 'build-output')));
  assert.equal(record.passed, true);
  await writeFile(join(task.worktree, 'source.txt'), 'parent review feedback\n');
  await assert.rejects(run(f.runtimePath, task.id, revision.attempt), /EEXIST/, 'Attempt cannot be launched twice, even at its original fingerprint');
  assert.equal(f.git('status', '--porcelain'), '');
}));

test('revision rejects stale handoffs, staged changes and source movement before worker startup', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const bound = { ...task, nonce: 'previous-job' };
  const spec = { expectedNonce: bound.nonce, expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise.', model: 'fixture/model', thinking: 'low' };
  await assert.rejects(prepareRevision(bound, spec, { ...f.runtime, revisionProtocol: undefined }), /activate the updated runtime/);
  await assert.rejects(prepareRevision(bound, { ...spec, expectedNonce: 'other-job' }, f.runtime), /nonce changed/);
  await assert.rejects(prepareRevision(bound, { ...spec, expectedFingerprint: '0'.repeat(64) }, f.runtime), /fingerprint changed/);
  execFileSync(gitBin, ['-C', task.worktree, 'add', 'source.txt']);
  await assert.rejects(prepareRevision(bound, spec, f.runtime), /unstaged/);
  execFileSync(gitBin, ['-C', task.worktree, 'reset', '-q', 'HEAD', '--', 'source.txt']);
  const revision = await prepareRevision(bound, spec, f.runtime);
  await writeFile(join(task.worktree, 'source.txt'), 'changed after approval\n');
  await assert.rejects(run(f.runtimePath, task.id, revision.attempt), /source changed after handoff/);
  await assert.rejects(json(join(attemptDirectory(task, revision.attempt), 'started.json')), /ENOENT/);
  assert.throws(() => attemptDirectory(task, '../escape'), /UUID/);
}));

test('task restoration follows only supplied branch entries; runtime does not inherit secrets', () => {
  assert.equal(tasksFrom([{ type: 'custom', customType: ENTRY, data: { id: 'a', nonce: 'first' } },
    { type: 'custom', customType: ENTRY, data: { id: 'a', nonce: 'second' } }]).get('a').nonce, 'second');
  assert.deepEqual(Object.keys(envFor({ home: '/home/fixture', path: '/bin' })).sort(), ['GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH']);
});

test('real worker extension forwards revision identity to check artifacts while reusing the task output base', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const revision = await prepareRevision({ ...task, nonce: 'previous-job' }, {
    expectedNonce: 'previous-job', expectedFingerprint: await snapshot(task, f.runtime),
    brief: 'Explicit revision.', model: 'fixture/model', thinking: 'low',
  }, f.runtime);
  const variables = { PI_DELEGATE_RUNTIME: f.runtimePath, PI_DELEGATE_TASK: task.id, PI_DELEGATE_ATTEMPT: revision.attempt };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const { loadExtensions } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
    const instance = await loadExtensions([new URL('../worker.ts', import.meta.url).pathname], task.worktree);
    assert.deepEqual(instance.errors, []);
    const handlers = instance.extensions[0].handlers;
    const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event); };
    let progress = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, callback) => { progress += chunk; callback?.(); return true; };
    try {
      await emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Live answer' } });
      await emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE THINKING' } });
      await emit('message_update', { assistantMessageEvent: { type: 'text_end' } });
      await emit('tool_execution_start', { toolCallId: 'a', toolName: 'read', args: { path: 'first.md', secret: 'PRIVATE ARGUMENT' } });
      await emit('tool_execution_start', { toolCallId: 'b', toolName: 'read', args: { path: 'second.md', offset: 12 } });
      await emit('tool_execution_end', { toolCallId: 'b', toolName: 'read', durationMs: 4.2, isError: false });
      await emit('tool_execution_end', { toolCallId: 'a', toolName: 'read', isError: true, result: 'PRIVATE RESULT' });
    } finally { process.stderr.write = originalWrite; }
    assert.match(progress, /Live answer\n/);
    assert.match(progress, /Tool #1 starting: read.*first.md/);
    assert.match(progress, /Tool #2 starting: read.*second.md.*"offset":12/);
    assert.match(progress, /Tool #2 finished: read \(4ms\)/);
    assert.match(progress, /Tool #1 finished: read \(error\)/);
    assert.doesNotMatch(progress, /PRIVATE/);
    const tool = instance.extensions[0].tools.get('delegate_check').definition;
    const reply = await tool.execute('check', { index: 0 });
    const record = JSON.parse(reply.content[0].text);
    assert.equal(record.passed, true);
    assert.equal(record.log.startsWith(attemptDirectory(task, revision.attempt) + '/'), true);
    assert.ok(JSON.parse(await readFile(record.log, 'utf8')).args.includes('--output=' + join(task.directory, 'build-output')));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}));

test('real Pi loader: nested Pueue workflow, main-agent review, visible submissions and fork ownership', async () => {
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const requireHost = createRequire(join(sdk, 'package.json'));
  const { runToolCall } = await import(pathToFileURL(join(dirname(requireHost.resolve('@earendil-works/pi-agent-core/package.json')), 'dist/index.js')));
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions.flatMap(e => [...e.tools.values()]).map(v => v.definition ?? v);
  assert.deepEqual(tools.map(t => t.name).sort(), ['delegate_models', 'delegate_review', 'delegate_revise', 'delegate_task']);
  const review = tools.find(t => t.name === 'delegate_review');
  await fixture(async f => {
    const entries = [], calls = [];
    const host = createExtensionRuntime();
    host.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
    const instance = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, host);
    assert.deepEqual(instance.errors, []);
    const registered = new Map([...instance.extensions[0].tools.values()].map(v => [v.definition.name, v.definition]));
    let phase = 'RUNNING', submissionFailure = false, serial = 0, exitCode = 0, cancellationRequested = false, absent = false;
    const ctx = { modelRegistry: { find: () => ({ id: 'model' }) }, sessionManager: {
      getSessionFile: () => who.file, getSessionId: () => who.session, getSessionName: () => 'Checkout fixes (GMKtec)', getBranch: () => entries,
    }, executeTool: async (name, args) => {
      calls.push({ name, args });
      // Use Pi's real nested-call envelope, not an approximation of a tool result.
      const tool = { name, label: name, description: 'Fixture backend', parameters: { type: 'object', additionalProperties: true },
        execute: async () => {
          if (submissionFailure && name === 'pueue_submit') throw new Error('Fixture uncertain admission');
          return { content: [{ type: 'text', text: JSON.stringify(name === 'pueue_submit' ? { nonce: `fixture-nonce-${++serial}`, id: serial, phase: 'QUEUED' }
            : name === 'pueue_status' ? absent ? [] : [{ nonce: args.nonce, phase, exitCode, cancellationRequested }] : {}) }], details: undefined };
        } };
      return runToolCall({ type: 'toolCall', id: 'nested-fixture', name, arguments: args }, {
        tools: [tool], assistantMessage: { role: 'assistant', content: [] }, context: { systemPrompt: '', messages: [] },
      });
    } };
    const previous = process.env.PI_DELEGATE_RUNTIME; process.env.PI_DELEGATE_RUNTIME = f.runtimePath;
    try {
      const reply = await registered.get('delegate_task').execute('call', input(f.repo), undefined, undefined, ctx);
      const task = JSON.parse(reply.content[0].text);
      assert.equal(calls[0].name, 'pueue_submit');
      assert.deepEqual(calls[0].args.argv, [f.runtime.launcher, f.runtimePath, task.task]);
      assert.equal(entries.length, 2);
      assert.equal(task.model, 'fixture/model'); assert.equal(task.thinking, 'low');
      assert.equal(task.initiator.name, 'Checkout fixes (GMKtec)');
      assert.match(task.initiator.label, /^checkout-fixes-gmktec-s[a-f0-9]{8}$/);
      assert.ok(task.worktree.endsWith(`delegate-${task.initiator.label}-${task.task}`));
      const theme = { fg: (_color, text) => text, bold: text => text };
      const submitTool = registered.get('delegate_task');
      const callText = submitTool.renderCall(input(f.repo), theme).render(120).join('\n');
      assert.match(callText, /Subagent/); assert.match(callText, /fixture\/model/); assert.match(callText, /thinking: low/);
      const rendered = submitTool.renderResult(reply, { expanded: false, isPartial: false }, theme).render(120).join('\n');
      assert.equal(rendered.trimEnd(), 'Queued · Pueue #1');
      assert.doesNotMatch(callText, /Task:|Artifacts:|Worktree:/);
      const expandedSubmission = submitTool.renderResult(reply, { expanded: true, isPartial: false }, theme).render(160).join('\n');
      assert.match(expandedSubmission, new RegExp(task.nonce));
      assert.match(expandedSubmission, new RegExp(task.task));
      assert.match(expandedSubmission, /Worktree:|Artifacts:/);
      assert.doesNotMatch(expandedSubmission, /fixture\/model|thinking:/);
      const errorResult = { content: [{ type: 'text', text: 'Submission may be UNKNOWN' }] };
      assert.match(submitTool.renderResult(errorResult, { expanded: false }, theme).render(120).join('\n'), /UNKNOWN/);
      assert.doesNotMatch(submitTool.description, /human diff review/);
      assert.match(registered.get('delegate_review').description, /main agent must review/);
      await assert.rejects(registered.get('delegate_review').execute('review', { task: task.task }, undefined, undefined, ctx), /not authoritatively/);
      assert.equal(calls.some(c => c.name === 'worktree_panel_target'), false);
      await run(f.runtimePath, task.task); phase = 'EXITED';
      const reviewTool = registered.get('delegate_review');
      const reviewReply = await reviewTool.execute('review', { task: task.task }, undefined, undefined, ctx);
      const reviewed = JSON.parse(reviewReply.content[0].text);
      const colours = [];
      const reviewTheme = { ...theme, fg: (colour, text) => { colours.push({ colour, text }); return text; } };
      assert.match(reviewTool.renderCall({ task: task.task }, theme).render(120).join('\n'), /collect changes and report/);
      const renderReview = (data, expanded = false) => reviewTool.renderResult(
        { content: [{ type: 'text', text: JSON.stringify(data) }] }, { expanded, isPartial: false }, reviewTheme).render(120).join('\n');
      const reviewText = renderReview(reviewed);
      assert.match(reviewText, /EXITED · exit 0/);
      assert.match(reviewText, /Changes collected · review verdict is separate/);
      assert.doesNotMatch(reviewText, /Evidence collected|review pending|not accepted/);
      assert.equal(colours.some(c => c.text.includes('Changes collected')), false, 'Collection status is plain text, not a warning or an approval signal');
      assert.match(reviewText, /needed for indices: 0/);
      assert.match(reviewText, /New files: 1.*new\.txt/);
      assert.doesNotMatch(reviewText, /fingerprint|tracked.diff|"task":/);
      const expandedReview = renderReview(reviewed, true);
      assert.match(expandedReview, /Tracked diff:.*tracked.diff/);
      assert.match(expandedReview, /Worker report \(untrusted\):/);
      assert.match(expandedReview, /Worker duration:/);
      assert.match(renderReview({ ...reviewed, missingChecks: [], checks: [] }), /Checks: none planned/);
      assert.match(renderReview({ ...reviewed, worker: undefined }), /Worker result evidence unavailable/);
      assert.ok(colours.some(c => c.colour === 'warning' && c.text === 'Worker result evidence unavailable.'));
      assert.match(renderReview({ ...reviewed, worker: { code: 7, integrityError: 'fixture problem' } }), /Integrity error: fixture problem/);
      assert.ok(colours.some(c => c.colour === 'error' && c.text === 'Integrity error: fixture problem'));
      assert.match(renderReview([]), /No delegated tasks/);
      assert.match(renderReview([{ task: task.task, model: task.model, thinking: task.thinking }]), /fixture\/model/);
      const reviewError = reviewTool.renderResult({ content: [{ type: 'text', text: 'Worker is not authoritatively EXITED' }] },
        { expanded: false, isPartial: false }, theme).render(120).join('\n');
      assert.match(reviewError, /not authoritatively EXITED/);
      assert.equal(reviewed.accepted, false); assert.deepEqual(reviewed.untracked, ['new.txt']);
      assert.deepEqual(reviewed.missingChecks, [0]);
      assert.match(await readFile(reviewed.trackedPatch, 'utf8'), /worker changed/);
      assert.equal(reviewed.reviewer, 'main-agent');
      assert.equal(calls.some(c => c.name === 'worktree_panel_target'), false, 'Review does not require opening a human diff panel');
      await registered.get('delegate_review').execute('panel', { task: task.task, openDiff: true }, undefined, undefined, ctx);
      assert.equal(calls.at(-1).name, 'worktree_panel_target');
      const revisionInput = { task: task.task, expectedNonce: task.nonce, expectedFingerprint: reviewed.fingerprint,
        brief: 'Explicit authorized revision; preserve worktree and prior changes.', model: 'fixture/model', thinking: 'low' };
      const revise = registered.get('delegate_revise');
      const submitsBeforeRevision = calls.filter(c => c.name === 'pueue_submit').length;
      for (const state of ['RUNNING', 'QUEUED', 'UNKNOWN', 'ADMISSION_UNKNOWN']) {
        phase = state;
        await assert.rejects(revise.execute('revision', revisionInput, undefined, undefined, ctx), /not confirmed/);
      }
      phase = 'EXITED'; exitCode = 7;
      await assert.rejects(revise.execute('revision', revisionInput, undefined, undefined, ctx), /not confirmed/);
      exitCode = 0; cancellationRequested = true;
      await assert.rejects(revise.execute('revision', revisionInput, undefined, undefined, ctx), /not confirmed/);
      cancellationRequested = false; absent = true;
      await assert.rejects(revise.execute('revision', revisionInput, undefined, undefined, ctx), /not confirmed/);
      absent = false;
      const originalResultPath = join(task.artifacts, 'result.json'), originalResult = await readFile(originalResultPath, 'utf8');
      await writeFile(originalResultPath, JSON.stringify({ code: 0, integrityError: 'fixture integrity failure' }));
      await assert.rejects(revise.execute('revision', revisionInput, undefined, undefined, ctx), /evidence incomplete/);
      await writeFile(originalResultPath, originalResult);
      assert.equal(calls.filter(c => c.name === 'pueue_submit').length, submitsBeforeRevision);
      const revision = JSON.parse((await revise.execute('revision', revisionInput, undefined, undefined, ctx)).content[0].text);
      assert.equal(revision.task, task.task); assert.equal(revision.worktree, task.worktree);
      assert.notEqual(revision.nonce, task.nonce);
      const revisionRender = revise.renderResult({ content: [{ type: 'text', text: JSON.stringify(revision) }] },
        { expanded: true, isPartial: false }, theme).render(160).join('\n');
      assert.match(revisionRender, /Queued · Pueue #2/);
      assert.match(revisionRender, new RegExp(revision.attempt));
      assert.doesNotMatch(revisionRender, /fixture\/model|thinking:/);
      const revisionCall = revise.renderCall(revisionInput, theme).render(160).join('\n');
      assert.match(revisionCall, /Subagent · revision/); assert.match(revisionCall, /fixture\/model/);
      assert.equal(revisionCall.split('\n').map(line => line.trimEnd()).join('\n'), 'Subagent · revision\nfixture/model · requested thinking: low');
      const compactRevision = revise.renderResult({ content: [{ type: 'text', text: JSON.stringify(revision) }] },
        { expanded: false, isPartial: false }, theme).render(160).join('\n');
      assert.equal(compactRevision.trimEnd(), 'Queued · Pueue #2');
      assert.deepEqual(calls.at(-1).args.argv, [f.runtime.launcher, f.runtimePath, task.task, revision.attempt]);
      await assert.rejects(revise.execute('stale', revisionInput, undefined, undefined, ctx), /nonce changed/);
      await run(f.runtimePath, task.task, revision.attempt);
      const revisedReview = JSON.parse((await registered.get('delegate_review').execute('review', { task: task.task, openDiff: false }, undefined, undefined, ctx)).content[0].text);
      assert.equal(revisedReview.attempt, revision.attempt);
      assert.equal(revisedReview.report.path, join(revision.artifacts, 'report.md'));
      assert.equal(revisedReview.accepted, false);
      submissionFailure = true;
      const nextRevision = { ...revisionInput, expectedNonce: revision.nonce, expectedFingerprint: revisedReview.fingerprint };
      const revisionSubmits = calls.filter(c => c.name === 'pueue_submit').length;
      await assert.rejects(revise.execute('uncertain-revision', nextRevision, undefined, undefined, ctx), /UNKNOWN/);
      assert.equal(tasksFrom(entries).get(task.task).nonce, undefined, 'Uncertain revision clears old binding instead of granting another launch');
      await assert.rejects(revise.execute('duplicate-revision', nextRevision, undefined, undefined, ctx), /binding unavailable/);
      assert.equal(calls.filter(c => c.name === 'pueue_submit').length, revisionSubmits + 1);
      const before = calls.filter(c => c.name === 'pueue_submit').length;
      await assert.rejects(registered.get('delegate_task').execute('uncertain', input(f.repo), undefined, undefined, ctx), /UNKNOWN/);
      assert.equal(calls.filter(c => c.name === 'pueue_submit').length, before + 1, 'No automatic retry on a real error envelope');
      assert.equal(entries.at(-1).data.nonce, undefined, 'Failed admission never receives an invented binding');
    } finally {
      if (previous === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = previous;
    }
  });
  await assert.rejects(review.execute('call', { task: 'foreign' }, undefined, undefined, {
    sessionManager: { getSessionFile: () => '/other.jsonl', getSessionId: () => 'fork', getBranch: () => [
      { type: 'custom', customType: ENTRY, data: { id: 'foreign', owner: who } } ] },
  }), /not owned/);
});
