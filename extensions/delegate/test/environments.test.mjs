// Contract and tool-boundary tests only; no model/network/service operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environments, selectEnvironment, assertTaskEnvironment, workerTools, readable } from '../environments.mjs';
import { prepare, prepareRevision, save, writeTask, json, snapshot, writable, runtimeFrom } from '../core.mjs';
import { createTools } from '../claude-tools.mjs';
import { run } from '../run.mjs';
import { check } from '../check.mjs';
import { environmentFixture } from './environment-fixture.mjs';
import { loadExtensions, createExtensionRuntime } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const executable = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const git = executable('git');
function config() {
  const runtime = { path: process.env.PATH, profiles: { fixture: { command: '/fixture/check', args: ['{targets}'] } } };
  return { ...runtime, ...environmentFixture(runtime, executable('env')) };
}
const spec = (repo, environment = 'source-review') => ({ repo, environment, brief: 'Read source and report facts.', model: 'fixture/model', thinking: 'low', checks: [],
  ...(environment === 'implementation-checked' ? { profile: 'fixture' } : {}) });
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-environment-')), repo = join(dir, 'repo');
  try {
    execFileSync(git, ['init', '-q', repo]); await writeFile(join(repo, 'source.txt'), 'original\n');
    execFileSync(git, ['-C', repo, 'add', '.']);
    execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const pi = join(dir, 'fake-pi');
    await writeFile(pi, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'argv.json'))},JSON.stringify(process.argv.slice(2)));console.log('Source reviewed.');\n`, { mode: 0o700 });
    const runtime = { ...config(), git, pi, node: process.execPath, flock: executable('flock'), ssh: '/fixture/ssh', launcher: '/fixture/launcher',
      home: dir, state: join(dir, 'state'), revisionProtocol: 1 };
    const runtimePath = join(dir, 'runtime.json'); await save(runtimePath, runtime);
    await fn({ dir, repo, runtime, runtimePath, prepare: environment => prepare(spec(repo, environment), runtime, { session: 'fixture', file: '/fixture/main.jsonl' }) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('contract v1 advertises three exact capability profiles, with honest isolation limits', () => {
  const runtime = config(), entries = environments(runtime);
  assert.deepEqual(entries.map(e => e.id), ['source-review', 'implementation', 'implementation-checked']);
  assert.deepEqual(workerTools({ execution: entries[0] }), ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(workerTools({ execution: entries[1] }), ['read', 'grep', 'find', 'ls', 'edit', 'write']);
  assert.equal(workerTools({ execution: entries[2] }).at(-1), 'delegate_check');
  assert.deepEqual(entries[0].isolation, { filesystem: 'tool-boundary', network: 'host', credentials: 'host-home' });
  entries[0].capabilities.source = 'changed';
  assert.equal(runtime.environments['source-review'].capabilities.source, 'read-only');
});

test('contract refuses unsupported versions, capabilities, sandbox claims, malformed launchers and profiles', () => {
  for (const mutate of [r => r.environmentProtocol = 3, r => delete r.environments.implementation,
    r => r.environments['source-review'].capabilities.checks = true,
    r => r.environments['source-review'].isolation.network = 'offline',
    r => r.environments['source-review'].isolation.credentials = 'model-only',
    r => r.environments['source-review'].launcher = 'env',
    r => r.environments['source-review'].path = '/bin:',
    r => r.environments['source-review'].verificationProfiles = ['fixture'],
    r => r.environments['implementation-checked'].verificationProfiles = ['missing'],
    r => r.environments['implementation-checked'].verificationProfiles = [],
    r => r.environments['implementation-checked'].verificationProfiles = ['constructor'],
    r => r.environments['implementation-checked'].extra = true]) {
    const runtime = config(); mutate(runtime); assert.throws(() => environments(runtime), /contract|Invalid environment/);
  }
});

test('selection is explicit, cannot add checks to a no-check environment, and never silently upgrades', () => {
  const runtime = config();
  for (const input of [{}, { environment: 'unknown' }, { environment: 'source-review', checks: [{}] },
    { environment: 'implementation', profile: 'fixture', checks: [] }, { environment: 'implementation-checked', profile: 'unknown' }]) {
    assert.throws(() => selectEnvironment(input, runtime), /explicit environment|forbids|not approved/);
  }
  assert.throws(() => selectEnvironment({ environment: 'source-review' }, {}), /unavailable/);
});

test('invalid selection fails before source/state preparation; frozen environments reject drift and follow-up upgrades', () => fixture(async f => {
  await assert.rejects(prepare({ ...spec(f.repo), environment: 'missing', profile: 'fixture' }, f.runtime, {}), /explicit environment/);
  await assert.rejects(readdir(f.runtime.state), /ENOENT/);
  const task = await f.prepare('source-review');
  assert.equal(task.verification, undefined); assert.equal(task.profile, undefined);
  assertTaskEnvironment(task, f.runtime);
  const changed = structuredClone(f.runtime); changed.environments['source-review'].launcher = '/fixture/other';
  assert.throws(() => assertTaskEnvironment(task, changed), /Frozen environment/);
  assert.throws(() => assertTaskEnvironment({ ...task, execution: undefined }, f.runtime), /Frozen environment/);
  await assert.rejects(writable(task, 'source.txt'), /forbids tool/);
  const current = { ...task, nonce: 'previous' }; await writeTask(current);
  await assert.rejects(prepareRevision(current, { ...spec(f.repo), environment: 'implementation', expectedNonce: 'previous', expectedFingerprint: await snapshot(task, f.runtime) }, f.runtime), /frozen/);
  await writeFile(f.runtimePath, JSON.stringify({ ...f.runtime, environmentProtocol: 3 }));
  await assert.rejects(runtimeFrom(f.runtimePath), /contract/);
}));

test('Claude advertises and enforces the same read-only boundary, including direct hidden tool calls and external symlinks', () => fixture(async f => {
  const task = await f.prepare('source-review'), call = await createTools(f.runtimePath, task.id);
  assert.deepEqual(call.tools.map(t => t.name), ['read', 'ls', 'find', 'grep']);
  assert.equal((await call('read', { path: 'source.txt' })).content[0].text, 'original\n');
  await symlink(f.dir, join(task.worktree, 'outside'));
  for (const [tool, args] of [['write', { path: 'source.txt', content: 'bad' }], ['edit', { path: 'source.txt', oldText: 'original', newText: 'bad' }], ['delegate_check', { index: 0 }]]) {
    await assert.rejects(call(tool, args), /forbids tool/);
  }
  await assert.rejects(call('read', { path: 'outside/runtime.json' }), /outside worktree/);
  await assert.rejects(readable(task, '..'), /outside worktree/);
  assert.equal(await readFile(join(task.worktree, 'source.txt'), 'utf8'), 'original\n');
}));

test('environment discovery exposes guarantees and API selection without worker or backend calls', () => fixture(async f => {
  const prior = process.env.PI_DELEGATE_RUNTIME; process.env.PI_DELEGATE_RUNTIME = f.runtimePath;
  try {
    const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo);
    assert.deepEqual(loaded.errors, []);
    const tools = loaded.extensions[0].tools;
    const reply = await tools.get('delegate_environments').definition.execute('discovery', {});
    const data = JSON.parse(reply.content[0].text);
    assert.equal(data.interfaceVersion, 1); assert.equal(data.readinessVerified, false);
    assert.equal(data.environments.length, 3);
    assert.equal(data.environments[0].isolation.network, 'host');
    const schema = tools.get('delegate_task').definition.parameters;
    assert.ok(schema.required.includes('environment')); assert.ok(!schema.required.includes('profile'));
    await assert.rejects(readdir(f.runtime.state), /ENOENT/);
  } finally { if (prior === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = prior; }
}));

test('Pi worker registers only permitted tools and blocks mutation/read escapes in its tool-call boundary', () => fixture(async f => {
  const task = await f.prepare('source-review');
  const variables = { PI_DELEGATE_RUNTIME: f.runtimePath, PI_DELEGATE_TASK: task.id };
  const prior = Object.fromEntries(Object.keys(variables).map(k => [k, process.env[k]])); Object.assign(process.env, variables);
  try {
    const api = createExtensionRuntime(), active = []; api.setActiveTools = tools => active.push(tools);
    const loaded = await loadExtensions([new URL('../worker.ts', import.meta.url).pathname], task.worktree, undefined, api);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0]; assert.equal(extension.tools.has('delegate_check'), false);
    for (const handler of extension.handlers.get('session_start') ?? []) await handler({});
    assert.deepEqual(active.at(-1), ['read', 'grep', 'find', 'ls']);
    const guard = extension.handlers.get('tool_call').at(-1);
    assert.equal((await guard({ toolName: 'write', input: { path: 'source.txt' } })).block, true);
    assert.equal((await guard({ toolName: 'read', input: { path: f.runtimePath } })).block, true);
    assert.equal(await guard({ toolName: 'read', input: { path: 'source.txt' } }), undefined);
  } finally { for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}));

test('operator launcher is used by both model backends and approved checks; launcher failures never fall back', () => fixture(async f => {
  const launcher = join(f.dir, 'launch'), marker = join(f.dir, 'launched');
  await writeFile(launcher, `#!/bin/sh\nprintf 'launched\\n' >> '${marker}'\nexec "$@"\n`, { mode: 0o700 });
  for (const value of Object.values(f.runtime.environments)) value.launcher = launcher;
  f.runtime.profiles.fixture = { command: process.execPath, args: ['-e', "console.log('check passed')", '{targets}'] };
  f.runtime.claude = join(f.dir, 'fake-claude');
  await writeFile(f.runtime.claude, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Reviewed.'}));\n`, { mode: 0o700 });
  await writeFile(f.runtimePath, JSON.stringify(f.runtime));
  const pi = await f.prepare('source-review'); assert.equal(await run(f.runtimePath, pi.id), 0);
  const claude = await prepare({ ...spec(f.repo), backend: 'claude', model: 'claude-sonnet-4-6' }, f.runtime, { session: 'fixture' });
  assert.equal(await run(f.runtimePath, claude.id), 0);
  const checked = await prepare({ ...spec(f.repo, 'implementation-checked'), checks: [{ kind: 'test', targets: ['unit'] }] }, f.runtime, { session: 'fixture' });
  assert.equal(await check(f.runtimePath, checked.id, 0), 0);
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 3);
  const failed = await f.prepare('source-review');
  await writeFile(launcher, '#!/bin/sh\nexit 19\n', { mode: 0o700 });
  assert.equal(await run(f.runtimePath, failed.id), 19);
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 3);
}));

test('runner uses the selected launcher/tool set and detects source-review mutation; implementation cannot execute checks', () => fixture(async f => {
  const review = await f.prepare('source-review'); assert.equal(await run(f.runtimePath, review.id), 0);
  const argv = JSON.parse(await readFile(join(f.dir, 'argv.json'), 'utf8'));
  assert.equal(argv[argv.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.match(await readFile(join(review.directory, 'worker-policy.md'), 'utf8'), /Source access: read-only/);
  const edit = await f.prepare('implementation');
  assert.equal((await createTools(f.runtimePath, edit.id)).tools.some(t => t.name === 'delegate_check'), false);
  await assert.rejects(check(f.runtimePath, edit.id, 0), /Unplanned/);
  const corrupt = await f.prepare('source-review');
  await writeFile(f.runtime.pi, `#!${process.execPath}\nrequire('node:fs').writeFileSync('source.txt','mutated');\n`, { mode: 0o700 });
  assert.equal(await run(f.runtimePath, corrupt.id), 1);
  assert.match((await json(join(corrupt.directory, 'result.json'))).integrityError, /Read-only source changed/);
}));
