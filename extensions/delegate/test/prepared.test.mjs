// Contract plumbing only: fake operator data, no sandbox/model/auth/network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { environmentFixture } from './environment-fixture.mjs';
import { environments, selectEnvironment, environmentCommand, assertTaskEnvironment } from '../environments.mjs';
import { validatePolicy, validatePrepared, sealedJSON } from '../prepared.mjs';
import { prepare, verificationProfile, saveWorkerLaunch } from '../core.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-prepared-')), repo = join(dir, 'repo');
  const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const write = async (path, value) => { const text = JSON.stringify(value); await writeFile(path, text, { mode: 0o600 }); return { path, sha256: sha(text) }; };
  try {
    execFileSync(git, ['init', '-q', repo]); await writeFile(join(repo, 'prepare.lock'), 'approved'); await writeFile(join(repo, 'code.txt'), 'source');
    execFileSync(git, ['-C', repo, 'add', '.']); execFileSync(git, ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial']);
    const policy = await write(join(dir, 'policy.json'), { version: 1, operator: 'fixture', settings: {} });
    const manifest = { version: 1, repository: repo, policySha256: policy.sha256, sourceInputs: [{ path: 'prepare.lock', sha256: sha('approved') }],
      checks: [{ kind: 'test', targets: ['//:unit'] }], operator: { type: 'fixture-only' } };
    const prepared = await write(join(dir, 'prepared.json'), manifest);
    const runtime = { git, state: join(dir, 'state'), home: dir, path: process.env.PATH, ssh: '/fixture/ssh',
      profiles: { fixture: { command: '/fixture/check', args: ['{targets}'], prepared } } };
    Object.assign(runtime, environmentFixture(runtime, '/fixture/worker'));
    runtime.environmentProtocol = 2;
    for (const entry of Object.values(runtime.environments)) Object.assign(entry, {
      checkLauncher: entry.capabilities.checks ? '/fixture/check-launcher' : null, policy,
      isolation: { filesystem: 'operator-allowlist', network: 'worker-host/check-none', credentials: 'access-lease-or-none' },
      routes: { pi: ['fixture/model'], claude: ['claude-sonnet-4-6'] },
    });
    const input = { repo, model: 'fixture/model', thinking: 'low', environment: 'implementation-checked', profile: 'fixture',
      checks: [{ kind: 'test', targets: ['//:unit'] }], brief: 'Bounded contract fixture.' };
    await fn({ dir, repo, runtime, input, policy, manifest, prepared, write });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('v2 has explicit purpose launchers, policy seal and model/auth route restrictions', () => fixture(async f => {
  const entries = environments(f.runtime), execution = selectEnvironment(f.input, f.runtime);
  assert.equal(entries.length, 3); assert.equal(execution.interfaceVersion, 2);
  assert.equal(execution.isolation.credentials, 'access-lease-or-none');
  assert.throws(() => selectEnvironment({ ...f.input, model: 'openai/unsupported' }, f.runtime), /unsupported/);
  assert.throws(() => selectEnvironment({ ...f.input, checks: [] }, f.runtime), /nonempty/);
  assert.throws(() => selectEnvironment({ ...f.input, environment: 'source-review' }, f.runtime), /forbids/);
  const task = { ...f.input, id: '11111111-1111-4111-8111-111111111111', execution };
  const worker = environmentCommand(task, f.runtime, '/fixture/pi', ['--print'], { purpose: 'worker', runtimePath: '/fixture/runtime.json' });
  assert.equal(worker.command, '/fixture/worker'); assert.deepEqual(worker.args.slice(0, 6), ['2', 'worker', '/fixture/runtime.json', task.id, '-', '-']);
  const check = environmentCommand(task, f.runtime, '/fixture/check', ['//:unit'], { purpose: 'check', runtimePath: '/fixture/runtime.json', index: 0 });
  assert.equal(check.command, '/fixture/check-launcher'); assert.equal(check.args[5], '0');
  assert.throws(() => environmentCommand(task, f.runtime, '/fixture/pi', []), /Explicit/);
  assert.throws(() => environmentCommand(task, f.runtime, '/fixture/pi', [], { purpose: 'check', runtimePath: '/fixture/runtime.json', index: 9 }), /Explicit/);
  const changed = structuredClone(f.runtime); changed.environments[task.environment].policy.sha256 = '0'.repeat(64);
  assert.throws(() => assertTaskEnvironment(task, changed), /Frozen/);
}));

test('v2 freezes exact worker invocation once, while v1 has no launch record', () => fixture(async f => {
  const task = { id: '11111111-1111-4111-8111-111111111111', execution: selectEnvironment(f.input, f.runtime) };
  const plan = { backend: 'claude', model: 'claude-sonnet-4-6', thinking: 'low' };
  await saveWorkerLaunch({ ...task, execution: { interfaceVersion: 1 } }, plan, f.dir, '/fixture/claude', ['--print']);
  await assert.rejects(readFile(join(f.dir, 'worker-launch.json')), /ENOENT/);
  await saveWorkerLaunch(task, plan, f.dir, '/fixture/claude', ['--print']);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'worker-launch.json'), 'utf8')),
    { task: task.id, attempt: '-', ...plan, command: '/fixture/claude', args: ['--print'] });
  await assert.rejects(saveWorkerLaunch(task, plan, f.dir, '/fixture/claude', ['--other']), /EEXIST/);
}));

test('policy/source/prepared seals fail closed; ordinary code edits remain permitted', () => fixture(async f => {
  const execution = selectEnvironment(f.input, f.runtime), verification = verificationProfile(f.runtime.profiles.fixture);
  const task = { ...f.input, execution, repository: { main: f.repo } };
  await validatePolicy(execution); await validatePrepared(task, f.repo, verification);
  await writeFile(join(f.repo, 'code.txt'), 'allowed implementation change');
  await validatePrepared(task, f.repo, verification);
  await writeFile(join(f.repo, 'prepare.lock'), 'changed dependency declaration');
  await assert.rejects(validatePrepared(task, f.repo, verification), /Preparation input changed/);
  await writeFile(join(f.repo, 'prepare.lock'), 'approved');
  await assert.rejects(validatePrepared({ ...task, checks: [{ kind: 'test', targets: ['//:other'] }] }, f.repo, verification), /not approved/);
  await assert.rejects(validatePrepared({ ...task, repository: { main: f.dir } }, f.repo, verification), /different canonical/);
  await validatePrepared({ ...task, checks: [{ targets: ['//:unit'], kind: 'test' }] }, f.repo, verification);
  await writeFile(f.policy.path, '{}'); await assert.rejects(validatePolicy(execution), /Sealed input changed/);
}));

test('invalid preparations refuse before task/worktree allocation; successful snapshots retain seals', () => fixture(async f => {
  await writeFile(join(f.repo, 'prepare.lock'), 'drift');
  await assert.rejects(prepare(f.input, f.runtime, {}), /Preparation input changed/);
  await assert.rejects(readdir(f.runtime.state), /ENOENT/);
  await writeFile(join(f.repo, 'prepare.lock'), 'approved');
  const task = await prepare(f.input, f.runtime, { session: 'fixture', file: '/fixture/session.jsonl' });
  assert.deepEqual(task.verification.prepared, f.prepared); assert.deepEqual(task.execution.policy, f.policy);
  assert.equal((await readFile(join(task.directory, 'task.json'), 'utf8')).includes('accessToken'), false);
}));

test('prepared documents reject policy mismatch, aliases, traversal, unknown fields and mutated manifests', () => fixture(async f => {
  const execution = selectEnvironment(f.input, f.runtime), task = { ...f.input, execution, repository: { main: f.repo } };
  for (const mutate of [m => m.policySha256 = '0'.repeat(64), m => m.sourceInputs[0].path = '../prepare.lock',
    m => m.sourceInputs.push(m.sourceInputs[0]), m => m.extra = true, m => m.checks[0].targets = ['--flag']]) {
    const manifest = structuredClone(f.manifest); mutate(manifest);
    const prepared = await f.write(join(f.dir, 'bad.json'), manifest);
    await assert.rejects(validatePrepared(task, f.repo, { prepared }), /policy|source input|manifest|targets/);
  }
  const alias = join(f.dir, 'alias.json'); await symlink(f.prepared.path, alias);
  await assert.rejects(sealedJSON({ path: alias, sha256: f.prepared.sha256 }), /canonical/);
  await writeFile(f.prepared.path, '{}'); await assert.rejects(sealedJSON(f.prepared), /Sealed input changed/);
}));
