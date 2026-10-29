import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare, prepareRevision, snapshot, save, json, attemptDirectory, workerBackend, validateInput } from '../core.mjs';
import { run } from '../run.mjs';
import { createTools, tools } from '../claude-tools.mjs';
const executable = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const gitBin = executable('git');
const spec = repo => ({ repo, backend: 'claude', model: 'claude-sonnet-4-6', thinking: 'high', brief: 'SECRET_BRIEF: edit source.txt only.', profile: 'fixture', checks: [{ kind: 'test', targets: ['unit:test'] }] });
const who = { session: 'session', file: '/fixture/session.jsonl' };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-claude-')), repo = join(dir, 'repo with spaces');
  const git = (...args) => execFileSync(gitBin, ['-C', repo, ...args], { encoding: 'utf8' });
  try {
    execFileSync(gitBin, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial');
    const claude = join(dir, 'fake-claude'), verifier = join(dir, 'verify');
    await writeFile(claude, `#!${process.execPath}
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(join(dir, 'invocation.json'))},JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8'),cwd:process.cwd(),secret:process.env.UNAPPROVED_TOKEN}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Implemented; parent review required.'}));
`, { mode: 0o700 });
    await writeFile(verifier, `#!${process.execPath}\nconsole.log('fixture check passed');\n`, { mode: 0o700 });
    const runtime = { git: gitBin, node: process.execPath, pi: claude, claude, flock: executable('flock'), ssh: '/fixture/ssh',
      home: dir, state: join(dir, 'state'), launcher: '/fixture/launcher', path: process.env.PATH, revisionProtocol: 1,
      profiles: { fixture: { command: verifier, args: ['{worktree}', '{outputBase}', '{kind}', '{targets}'] } } };
    const runtimePath = join(dir, 'runtime.json'); await save(runtimePath, runtime);
    await fn({ dir, repo, git, runtime, runtimePath });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('shared catalogue tool pages local/CLI routes and freezes automatic task/revision selection', () => fixture(async f => {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  f.runtime.catalogue = [{ id: 'claude-code/claude-sonnet-4-6', name: 'Claude Code Sonnet', backend: 'claude', model: 'claude-sonnet-4-6' }];
  await writeFile(f.runtimePath, JSON.stringify(f.runtime));
  const host = createExtensionRuntime(), entries = [], calls = [];
  host.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, host);
  assert.deepEqual(loaded.errors, []);
  const registered = new Map([...loaded.extensions[0].tools.values()].map(v => [v.definition.name, v.definition]));
  const local = { provider: 'evo-x2', id: 'qwen3-coder-next-agent', name: 'GMKtec', baseUrl: 'http://localhost:11434/v1', input: ['text'], cost: { input: 0 } };
  const ctx = { modelRegistry: { getAll: () => [local], hasConfiguredAuth: () => true,
    find: (provider, id) => provider === local.provider && id === local.id ? local : undefined }, sessionManager: {
    getSessionFile: () => who.file, getSessionId: () => who.session, getBranch: () => entries,
  }, executeTool: async name => {
    calls.push(name);
    return { result: { content: [{ type: 'text', text: JSON.stringify(name === 'pueue_status' ? [{ phase: 'EXITED', exitCode: 0 }] : { nonce: `nonce-${calls.length}`, phase: 'QUEUED' }) }] } };
  } };
  const previous = process.env.PI_DELEGATE_RUNTIME; process.env.PI_DELEGATE_RUNTIME = f.runtimePath;
  try {
    const invoke = async (name, input) => JSON.parse((await registered.get(name).execute(name, input, undefined, undefined, ctx)).content[0].text);
    const page = await invoke('delegate_models', { limit: 1 });
    assert.equal(page.total, 2); assert.equal(page.nextOffset, 1); assert.equal(page.fallback, false);
    const next = await invoke('delegate_models', { offset: 1, limit: 1 });
    assert.equal(next.entries[0].provider, 'evo-x2'); assert.equal(next.nextOffset, null);
    assert.deepEqual(calls, [], 'Listing never submits or probes workers');
    const task = await invoke('delegate_task', { ...spec(f.repo), backend: undefined, model: 'evo-x2/qwen3-coder-next-agent', thinking: 'off' });
    assert.equal(task.backend, 'pi'); assert.equal(task.route.selection, task.model);
    const original = await json(join(task.artifacts, 'task.json'));
    assert.equal(original.route.provider, 'evo-x2'); assert.equal(original.route.authentication.workerVerified, false);
    await run(f.runtimePath, task.task);
    const revision = await invoke('delegate_revise', { task: task.task, expectedNonce: task.nonce,
      expectedFingerprint: await snapshot(original, f.runtime), brief: 'Explicitly select CLI route.',
      model: 'claude-code/claude-sonnet-4-6', thinking: 'high' });
    assert.equal(revision.backend, 'claude'); assert.equal(revision.model, 'claude-sonnet-4-6');
    const plan = await json(join(revision.artifacts, 'attempt.json'));
    assert.equal(plan.route.id, 'claude-code/claude-sonnet-4-6');
    // Removing catalogue policy does not re-route an already prepared worker.
    await writeFile(f.runtimePath, JSON.stringify({ ...f.runtime, catalogue: [] }));
    assert.equal(await run(f.runtimePath, task.task, revision.attempt), 0);
    assert.equal((await json(join(task.artifacts, 'task.json'))).backend, 'pi');
  } finally { if (previous === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = previous; }
}));

test('explicit backend validation rejects aliases, unavailable CLI and unsupported effort before preparation', () => fixture(async f => {
  validateInput(spec(f.repo));
  assert.equal(workerBackend({ model: 'fixture/model' }), 'pi');
  for (const patch of [{ backend: 'unknown' }, { model: 'sonnet' }, { model: 'anthropic/claude-sonnet-4-6' }, { thinking: 'minimal' }, { thinking: 'off' }]) {
    assert.throws(() => validateInput({ ...spec(f.repo), ...patch }));
  }
  await assert.rejects(prepare(spec(f.repo), { ...f.runtime, claude: undefined }, who), /unavailable/);
  assert.equal(f.git('branch', '--list', 'delegate/*'), '');
}));
test('Claude worker has explicit capabilities, stdin brief, clean environment, durable report and one-shot identity', () => fixture(async f => {
  const task = await prepare(spec(f.repo), f.runtime, who);
  process.env.UNAPPROVED_TOKEN = 'never-forward';
  try { assert.equal(await run(f.runtimePath, task.id), 0); } finally { delete process.env.UNAPPROVED_TOKEN; }
  const invocation = await json(join(f.dir, 'invocation.json')), args = invocation.args;
  assert.equal(invocation.secret, undefined); assert.equal(invocation.cwd, task.worktree);
  assert.equal(invocation.stdin, spec(f.repo).brief); assert.ok(!args.join(' ').includes('SECRET_BRIEF'));
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  for (const [flag, value] of [['--model', task.model], ['--effort', 'high'], ['--tools', ''], ['--setting-sources', ''], ['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none'], ['--session-id', task.id]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  const config = await json(join(task.directory, 'claude-mcp.json'));
  assert.deepEqual(Object.keys(config.mcpServers), ['delegate']);
  assert.equal(config.mcpServers.delegate.command, f.runtime.node);
  assert.equal((await json(join(task.directory, 'result.json'))).backend, 'claude');
  assert.match(await readFile(join(task.directory, 'report.md'), 'utf8'), /parent review/);
  assert.equal(f.git('status', '--porcelain'), '');
  await assert.rejects(run(f.runtimePath, task.id), /EEXIST/);
  const bound = { ...task, nonce: 'previous' };
  const revision = await prepareRevision(bound, { expectedNonce: 'previous', expectedFingerprint: await snapshot(task, f.runtime),
    brief: 'Revise in place.', model: task.model, thinking: 'low' }, f.runtime);
  assert.equal(revision.backend, 'claude');
  assert.equal(await run(f.runtimePath, task.id, revision.attempt), 0);
  assert.equal((await json(join(f.dir, 'invocation.json'))).args.includes(revision.attempt), true);
  assert.equal((await json(join(attemptDirectory(task, revision.attempt), 'result.json'))).backend, 'claude');
}));
test('Claude semantic errors or invalid output never become successful revision evidence', () => fixture(async f => {
  for (const output of ['not-json', JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'partial' })]) {
    await writeFile(f.runtime.claude, `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o700 });
    const task = await prepare(spec(f.repo), f.runtime, who);
    assert.equal(await run(f.runtimePath, task.id), 1);
    const result = await json(join(task.directory, 'result.json'));
    assert.equal(result.code, 1); assert.ok(result.workerError); assert.equal(result.accepted, false);
  }
}));
test('Claude MCP source tools enforce protected/symlink boundary and record only planned locked checks', () => fixture(async f => {
  const task = await prepare(spec(f.repo), f.runtime, who), call = await createTools(f.runtimePath, task.id);
  assert.deepEqual(tools.map(t => t.name), ['read', 'ls', 'find', 'grep', 'write', 'edit', 'delegate_check']);
  assert.match((await call('read', { path: 'source.txt' })).content[0].text, /original/);
  assert.match((await call('find', { pattern: 'source' })).content[0].text, /source.txt/);
  assert.match((await call('grep', { pattern: 'original' })).content[0].text, /source.txt:1/);
  await call('edit', { path: 'source.txt', oldText: 'original', newText: 'changed' });
  await call('write', { path: 'src/new.txt', content: 'new source' });
  for (const path of ['../escape', '.git', '.claude/settings.json', '.pi/settings.json', '.agents/rules.md']) {
    await assert.rejects(call('write', { path, content: 'forbidden' }));
  }
  await symlink(f.dir, join(task.worktree, 'outside'));
  await assert.rejects(call('read', { path: 'outside/runtime.json' }), /outside/);
  await assert.rejects(call('write', { path: 'outside/escape', content: 'forbidden' }), /symlink/);
  await assert.rejects(call('edit', { path: 'source.txt', oldText: '', newText: 'bad' }), /exactly once/);
  await assert.rejects(call('delegate_check', { index: 1 }), /not planned/);
  await assert.rejects(call('shell', { command: 'anything' }), /Unknown/);
  await assert.rejects(call('read', { path: 'source.txt', arbitrary: true }), /Invalid/);
  await call('delegate_check', { index: 0 });
  const name = (await readdir(task.directory)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(task.directory, name));
  assert.equal(record.passed, true); assert.equal(record.after, await snapshot(task, f.runtime));
  assert.equal(f.git('status', '--porcelain'), '');
}));
test('real stdio MCP handshake/list/call stays JSON-only and denies arbitrary methods', () => fixture(async f => {
  const task = await prepare(spec(f.repo), f.runtime, who);
  const child = spawn(process.execPath, [new URL('../claude-tools.mjs', import.meta.url).pathname, f.runtimePath, task.id], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'notifications/initialized' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'read', arguments: { path: 'source.txt' } } },
    { id: 4, method: 'execute' },
  ];
  child.stdin.end(requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n');
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0, stderr);
  const replies = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4); assert.deepEqual(replies[0].result.capabilities, { tools: {} });
  assert.equal(replies[1].result.tools.length, 7); assert.match(replies[2].result.content[0].text, /original/);
  assert.equal(replies[3].error.code, -32601); assert.match(stderr, /Tool starting: read/);
}));
test('Pi host routes native and registry Anthropic IDs through Claude and can switch to a Pi revision', () => fixture(async f => {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
  const host = createExtensionRuntime(), entries = [];
  host.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([new URL('../index.ts', import.meta.url).pathname], f.repo, undefined, host);
  assert.deepEqual(loaded.errors, []);
  const registered = new Map([...loaded.extensions[0].tools.values()].map(v => [v.definition.name, v.definition]));
  let registryCalls = 0;
  const ctx = { modelRegistry: { find: () => { registryCalls++; return { id: 'model' }; },
    hasConfiguredAuth: model => { assert.notEqual(model.provider, 'anthropic', 'Anthropic Pi auth must not be read'); return true; } }, sessionManager: {
    getSessionFile: () => who.file, getSessionId: () => who.session, getBranch: () => entries,
  }, executeTool: async name => ({ result: { content: [{ type: 'text', text: JSON.stringify(name === 'pueue_status' ? [{ phase: 'EXITED', exitCode: 0 }] : { nonce: 'nonce', phase: 'QUEUED' }) }] } }) };
  const previous = process.env.PI_DELEGATE_RUNTIME; process.env.PI_DELEGATE_RUNTIME = f.runtimePath;
  try {
    const reply = await registered.get('delegate_task').execute('task', spec(f.repo), undefined, undefined, ctx);
    const task = JSON.parse(reply.content[0].text);
    assert.equal(task.backend, 'claude'); assert.equal(registryCalls, 0);
    const alias = JSON.parse((await registered.get('delegate_task').execute('alias', {
      ...spec(f.repo), backend: undefined, model: 'anthropic/claude-sonnet-4-6',
    }, undefined, undefined, ctx)).content[0].text);
    assert.equal(alias.backend, 'claude'); assert.equal(alias.model, 'claude-sonnet-4-6');
    assert.equal(alias.route.canonicalId, 'claude-code/claude-sonnet-4-6'); assert.equal(registryCalls, 1);
    await run(f.runtimePath, task.task);
    const current = entries.findLast(entry => entry.data.id === task.task).data;
    const revision = await registered.get('delegate_revise').execute('revise', {
      task: task.task, expectedNonce: 'nonce', expectedFingerprint: await snapshot(current, f.runtime),
      backend: 'pi', model: 'fixture/model', thinking: 'minimal', brief: 'Explicit switch to Pi.',
    }, undefined, undefined, ctx);
    assert.equal(JSON.parse(revision.content[0].text).backend, 'pi'); assert.equal(registryCalls, 2);
  } finally { if (previous === undefined) delete process.env.PI_DELEGATE_RUNTIME; else process.env.PI_DELEGATE_RUNTIME = previous; }
}));
