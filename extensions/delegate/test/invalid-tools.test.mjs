import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeInvalidTools, invalidToolFailure, INVALID_TOOL_ARTIFACT } from '../invalid-tools.mjs';

function harness(onTrip = async () => {}) {
  const handlers = new Map();
  let aborts = 0, trips = [];
  const pi = { getActiveTools: () => ['read', 'edit'], on(name, handler) { handlers.set(name, handler); } };
  observeInvalidTools(pi, async record => { trips.push(record); await onTrip(record); });
  const ctx = { abort() { aborts++; } };
  return { trips, get aborts() { return aborts; },
    emit: (name, event) => handlers.get(name)?.(event, ctx),
    message: (...names) => handlers.get('message_end')({ message: { role: 'assistant',
      content: names.map(name => ({ type: 'toolCall', name })) } }, ctx),
  };
}

test('only unavailable assistant tool names count; errors and valid calls do not reset cumulative budget', async () => {
  const h = harness();
  await h.emit('message_end', { message: { role: 'user', content: [{ type: 'toolCall', name: 'run' }] } });
  await h.message('read');
  await h.emit('message_end', { message: { role: 'toolResult', toolName: 'read', isError: true } });
  await h.message('run'); await h.emit('turn_end', {});
  await h.message('edit'); await h.emit('turn_end', {});
  await h.message('glob'); await h.emit('turn_end', {});
  assert.equal(h.aborts, 0);
  await h.message('run');
  assert.equal(h.emit('tool_call', { toolName: 'edit' }).block, true);
  await h.emit('turn_end', {});
  assert.equal(h.aborts, 1);
  assert.deepEqual(h.trips, [{ schemaVersion: 1, reason: 'invalid-tool-limit', limit: 3, count: 3, tools: ['run', 'glob', 'run'] }]);
  await h.message('run'); await h.emit('turn_end', {});
  assert.equal(h.aborts, 1); assert.equal(h.trips.length, 1);
});

test('parallel batch trips once, blocks other mutations, and stores bounded safe tool names only', async () => {
  const h = harness();
  await h.message('read', 'run', 'invalid\n\x1b[31m', 'x'.repeat(1000), 'other');
  assert.equal(h.emit('tool_call', { toolName: 'edit', input: { newText: 'PRIVATE' } }).block, true);
  await h.emit('turn_end', {});
  assert.equal(h.aborts, 1);
  assert.deepEqual(h.trips[0].tools, ['run', '[invalid tool name]', '[invalid tool name]']);
  assert.equal(h.trips[0].count, 4);
  assert.doesNotMatch(JSON.stringify(h.trips), /PRIVATE|\u001b/);
});

test('failure evidence callback cannot prevent abort; a new attempt starts with a fresh budget', async () => {
  const h = harness(async () => { throw new Error('disk failure'); });
  await h.message('run', 'run', 'run');
  await assert.rejects(h.emit('turn_end', {}), /disk failure/);
  assert.equal(h.aborts, 1);
  const next = harness(); await next.message('run'); await next.emit('turn_end', {});
  assert.equal(next.aborts, 0);
});

test('runner evidence is allowlisted and malformed/unreadable markers fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delegate-invalid-evidence-'));
  try {
    assert.equal(await invalidToolFailure(root), undefined);
    const marker = join(root, INVALID_TOOL_ARTIFACT);
    await writeFile(marker, 'invalid PRIVATE');
    assert.deepEqual(await invalidToolFailure(root), { failureReason: 'invalid-tool-evidence' });
    for (const record of [{ schemaVersion: 1, reason: 'invalid-tool-limit', limit: 3, count: 2, tools: ['run'] }, null]) {
      await writeFile(marker, JSON.stringify(record));
      assert.deepEqual(await invalidToolFailure(root), { failureReason: 'invalid-tool-evidence' });
    }
    await writeFile(marker, JSON.stringify({ schemaVersion: 1, reason: 'invalid-tool-limit', limit: 3,
      count: 3, tools: ['run', 'glob', '[invalid tool name]'], secret: 'PRIVATE' }));
    const failure = await invalidToolFailure(root);
    assert.deepEqual(failure, { failureReason: 'invalid-tool-limit', invalidTools: { limit: 3, count: 3, tools: ['run', 'glob', '[invalid tool name]'] } });
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/);
    await rm(marker); await mkdir(marker);
    assert.deepEqual(await invalidToolFailure(root), { failureReason: 'invalid-tool-evidence' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Pi CLI/worker: third invalid call aborts, ordinary edit errors do not count, partial work/logs survive', async () => {
  const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;
  const root = await mkdtemp(join(tmpdir(), 'delegate-invalid-cli-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* no provider payload logging */ }
    requests++;
    const call = (name, args, index = 0) => ({ index, id: `call_${requests}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const change = (oldText, newText, index = 0) => call('edit', { path: 'source.txt', edits: [{ oldText, newText }] }, index);
    const calls = requests === 1 ? [call('read', { path: 'source.txt' })]
      : requests === 2 ? [change('original', 'retained'), call('run', { command: 'PRIVATE' }, 1)]
      : requests === 3 ? [change('not present', 'never')]
      : requests === 4 ? [call('run', {})]
      : requests === 5 ? [call('run', {}), change('retained', 'must not execute', 1)] : undefined;
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `test-${requests}`, object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', ...(calls ? { tool_calls: calls } : { content: 'Unexpected continuation' }) }) +
      chunk({}, calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const home = join(root, 'home'), worktree = join(root, 'worktree'), state = join(root, 'state'), id = randomUUID();
    const directory = join(state, id), runtimePath = join(root, 'runtime.json');
    await mkdir(join(home, '.pi/agent'), { recursive: true }); await mkdir(worktree); await mkdir(directory, { recursive: true });
    await writeFile(join(worktree, 'source.txt'), 'original\n');
    await writeFile(join(home, '.pi/agent/auth.json'), '{}');
    await writeFile(join(home, '.pi/agent/settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    await writeFile(join(home, '.pi/agent/models.json'), JSON.stringify({ providers: { fixture: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture',
      compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(runtimePath, JSON.stringify({ git: '/fixture/git', node: process.execPath, pi: '/fixture/pi', flock: '/fixture/flock',
      ssh: '/fixture/ssh', home, state, launcher: '/fixture/launcher', path: process.env.PATH }));
    await writeFile(join(directory, 'task.json'), JSON.stringify({ id, directory, worktree, checks: [] }));
    const child = spawn(process.execPath, [join(sdk, 'dist/cli.js'), '--offline', '--print', '--provider', 'fixture', '--model', 'fixture', '--thinking', 'off',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-mcp',
      '--extension', new URL('../worker.ts', import.meta.url).pathname,
      '--tools', 'read,grep,find,ls,edit,write,delegate_check', '--session-dir', join(directory, 'sessions'), 'Fixture test'],
    { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', PI_OFFLINE: '1', PI_DELEGATE_RUNTIME: runtimePath, PI_DELEGATE_TASK: id } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, stderr);
    assert.equal(requests, 5, stderr);
    assert.equal(await readFile(join(worktree, 'source.txt'), 'utf8'), 'retained\n');
    const marker = join(directory, INVALID_TOOL_ARTIFACT);
    assert.deepEqual(await invalidToolFailure(directory), { failureReason: 'invalid-tool-limit',
      invalidTools: { limit: 3, count: 3, tools: ['run', 'run', 'run'] } });
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    assert.match(stderr, /Stopping worker: invalid-tool-limit/);
    assert.doesNotMatch(stderr, /PRIVATE|must not execute|Unexpected continuation/);
    assert.doesNotMatch(stdout, /Unexpected continuation/);
    // Persistent sessions and telemetry remain present for caller review.
    assert.ok((await stat(join(directory, 'sessions'))).isDirectory());
    assert.ok((await readFile(join(directory, 'metrics.jsonl'), 'utf8')).length);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
