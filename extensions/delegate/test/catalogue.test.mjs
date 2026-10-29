import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, cliEntries, resolveSelection } from '../catalogue.mjs';
import { workerBackend } from '../core.mjs';

const local = { provider: 'evo-x2', id: 'qwen3-coder-next-agent', name: 'Local coder', baseUrl: 'http://192.168.234.103:11434/v1',
  input: ['text'], reasoning: false, contextWindow: 131072, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const anthropic = { ...local, provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Sonnet',
  baseUrl: 'https://user:SECRET@api.anthropic.com/v1?key=SECRET', headers: { Authorization: 'SECRET' }, cost: { input: 3, output: 15 } };
const nested = { ...local, provider: 'openrouter', id: 'anthropic/claude-sonnet-4-6' };
const openai = { ...anthropic, provider: 'openai-codex', id: 'fixture-gpt', name: 'OpenAI model' };
const runtime = { claude: '/fixture/claude', catalogue: [{ id: 'claude-code/claude-sonnet-4-6', name: 'Sonnet through Claude Code', backend: 'claude', model: 'claude-sonnet-4-6' }] };
const registry = { getAll: () => [local, anthropic, nested, openai], hasConfiguredAuth: model => {
  assert.ok(!['anthropic', 'openrouter'].includes(model.provider), 'Anthropic must not inspect Pi auth'); return true;
}, find: (provider, id) => [local, anthropic, nested, openai].find(model => model.provider === provider && model.id === id) };

test('shared catalogue merges Pi and explicit CLI routes without credentials or readiness claims', () => {
  const entries = catalogue(runtime, registry);
  assert.equal(entries.length, 5);
  assert.equal(entries.find(e => e.id === 'evo-x2/qwen3-coder-next-agent').authentication.hostConfigured, true);
  const alias = entries.find(e => e.id === 'anthropic/claude-sonnet-4-6');
  assert.equal(alias.authentication.hostConfigured, null); assert.equal(alias.backend, 'claude');
  assert.equal(alias.model, 'claude-sonnet-4-6'); assert.equal(alias.cost, null);
  const cli = entries.find(e => e.backend === 'claude');
  assert.equal(cli.authentication.hostConfigured, null); assert.equal(cli.authentication.workerVerified, false);
  assert.equal(cli.cost, null); assert.equal(cli.configured, true);
  assert.doesNotMatch(JSON.stringify(entries), /SECRET|Authorization|key=|user:/);
  assert.match(alias.endpoint, /Claude Code/);
  assert.equal(entries.find(e => e.provider === 'openai-codex').endpoint, 'https://api.anthropic.com');
  assert.equal(catalogue(runtime, registry, { provider: 'evo-x2' }).length, 1);
  assert.equal(catalogue(runtime, registry, { backend: 'claude', query: 'SONNET' }).length, 3);
  assert.equal(catalogue(runtime, registry, { query: 'missing' }).length, 0);
  assert.equal(cliEntries({ ...runtime, claude: undefined })[0].configured, false);
});

test('strict routing: local/OpenAI stay Pi; every Anthropic alias invokes Claude Code', () => {
  for (const model of ['evo-x2/qwen3-coder-next-agent', 'openai-codex/fixture-gpt']) {
    const selected = resolveSelection({ model, thinking: 'off' }, runtime, registry);
    assert.equal(selected.backend, 'pi'); assert.equal(selected.model, model); assert.equal(selected.route.id, model);
  }
  for (const model of ['anthropic/claude-sonnet-4-6', 'openrouter/anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6']) {
    const selected = resolveSelection({ model, thinking: 'high' }, runtime, registry);
    assert.equal(selected.backend, 'claude'); assert.equal(selected.model, 'claude-sonnet-4-6');
    assert.equal(selected.route.authentication.hostConfigured, null);
  }
  const selected = resolveSelection({ model: 'claude-code/claude-sonnet-4-6', thinking: 'high' }, runtime, registry);
  assert.equal(selected.backend, 'claude'); assert.equal(selected.model, 'claude-sonnet-4-6');
  assert.equal(selected.route.selection, 'claude-code/claude-sonnet-4-6'); assert.equal(selected.route.explicitBackend, null);
});

test('missing, ambiguous, conflicting and unavailable selections fail closed without paid fallback', () => {
  for (const input of [
    { model: 'qwen' }, { model: 'evo-x2/offline-model' }, { model: 'claude-code/unknown' },
    { model: 'claude-code/claude-sonnet-4-6', backend: 'pi' },
    { model: 'anthropic/claude-sonnet-4-6', backend: 'pi' },
    { model: 'claude-sonnet-4-6', backend: 'pi' },
    { model: 'evo-x2/qwen3-coder-next-agent', backend: 'claude' },
    { model: 'openai-codex/fixture-gpt', backend: 'claude' },
  ]) assert.throws(() => resolveSelection({ thinking: 'high', ...input }, runtime, registry));
  assert.throws(() => resolveSelection({ model: 'claude-code/claude-sonnet-4-6', thinking: 'high' }, { ...runtime, claude: undefined }, registry), /unavailable/);
  assert.throws(() => resolveSelection({ model: 'claude-code/claude-sonnet-4-6', thinking: 'off' }, runtime, registry), /effort/);
  // No name matching: without an explicit external entry, do not invoke Claude.
  assert.throws(() => resolveSelection({ model: 'claude-code/claude-sonnet-4-6', thinking: 'high' }, { ...runtime, catalogue: [] }, registry), /Unknown/);
});

test('Anthropic Pi bypasses and unmappable vendor aliases fail, including runner validation', () => {
  for (const model of ['anthropic/claude-sonnet-4-6', 'openrouter/anthropic/claude-sonnet-4-6', 'github-copilot/claude-sonnet-4-6']) {
    assert.throws(() => workerBackend({ backend: 'pi', model }), /Pi is forbidden/);
  }
  const vendor = { ...anthropic, provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-v1:0' };
  const vendorRegistry = { getAll: () => [vendor], find: () => vendor };
  assert.deepEqual(catalogue({ ...runtime, catalogue: [] }, vendorRegistry), []);
  assert.throws(() => resolveSelection({ model: 'amazon-bedrock/us.anthropic.claude-sonnet-v1:0', thinking: 'high' }, runtime, vendorRegistry), /no exact Claude Code model mapping/);
  assert.throws(() => resolveSelection({ model: 'anthropic/claude-sonnet-4-6', thinking: 'high' }, { ...runtime, claude: undefined }, registry), /unavailable/);
});

test('explicit native backend calls remain supported and revisions resolve selected routes independently', () => {
  const direct = resolveSelection({ backend: 'claude', model: 'claude-opus-4-6', thinking: 'medium' }, runtime, registry);
  assert.equal(direct.backend, 'claude'); assert.equal(direct.route.explicitBackend, 'claude');
  const inherited = resolveSelection({ model: 'claude-opus-4-6', thinking: 'high' }, runtime, registry, { backend: 'claude' });
  assert.equal(inherited.backend, 'claude');
  const switched = resolveSelection({ model: 'evo-x2/qwen3-coder-next-agent', thinking: 'off' }, runtime, registry, { backend: 'claude' });
  assert.equal(switched.backend, 'pi');
  assert.equal(resolveSelection({ model: 'claude-code/claude-sonnet-4-6', thinking: 'high' }, runtime, registry, { backend: 'pi' }).backend, 'claude');
});

test('catalogue policy rejects duplicate, malformed or colliding IDs; route snapshots are detached', () => {
  for (const catalogue of [{}, [runtime.catalogue[0], runtime.catalogue[0]],
    [{ ...runtime.catalogue[0], backend: 'pi' }], [{ ...runtime.catalogue[0], model: 'sonnet' }],
    [{ ...runtime.catalogue[0], id: 'evo-x2/sonnet' }]]) {
    assert.throws(() => cliEntries({ ...runtime, catalogue }));
  }
  assert.deepEqual(cliEntries({}), []);
  assert.throws(() => catalogue(runtime, { getAll: () => [{ ...local, provider: 'claude-code' }] }), /conflicts/);
  const chosen = resolveSelection({ model: 'evo-x2/qwen3-coder-next-agent', thinking: 'off' }, runtime, registry);
  local.cost.input = 100;
  try { assert.equal(chosen.route.cost.input, 0); } finally { local.cost.input = 0; }
});
