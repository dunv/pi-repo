import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, resolveSelection } from '../catalogue.mjs';
import { workerBackend, prepare, prepareRevision } from '../core.mjs';
import { parsePiModelPolicy, allowedPiThinking } from '../model-policy.mjs';

const models = [
  { provider: 'evo-x2', id: 'qwen3.8:27b', reasoning: true },
  { provider: 'evo-x2', id: 'qwen3-coder-next-agent' },
  { provider: 'evo-x2', id: 'devstral-small-2' },
  { provider: 'evo-x2', id: 'gpt-oss:120b' },
  { provider: 'ollama', id: 'qwen3.8:27b' },
  { provider: 'llama-cpp', id: 'qwen3.8:27b' },
  { provider: 'openai-codex', id: 'hosted', reasoning: true },
  { provider: 'anthropic', id: 'claude-sonnet-4-6' },
];
const registry = { getAll: () => models, find: (provider, id) => models.find(m => m.provider === provider && m.id === id), hasConfiguredAuth: () => true };
const runtime = { claude: '/fixture/claude', piModelPolicy: {
  'evo-x2': { 'qwen3.8:27b': ['medium'] }, ollama: {}, 'llama-cpp': {}, 'llama.cpp': {},
}, catalogue: [{ id: 'claude-code/claude-sonnet-4-6', backend: 'claude', model: 'claude-sonnet-4-6', name: 'Sonnet' }] };
const input = (model, thinking = 'medium', extra = {}) => ({ repo: '/fixture/source', brief: 'Small bounded task.', profile: 'fixture', checks: [], model, thinking, ...extra });

test('production policy filters delegate catalogue without mutating the Pi registry or hosted routes', () => {
  const before = structuredClone(models), entries = catalogue(runtime, registry);
  assert.deepEqual(entries.map(e => e.id), ['anthropic/claude-sonnet-4-6', 'claude-code/claude-sonnet-4-6', 'evo-x2/qwen3.8:27b', 'openai-codex/hosted']);
  const local = entries.find(e => e.provider === 'evo-x2');
  assert.deepEqual(local.capabilities.thinking, ['medium']);
  local.capabilities.thinking.push('off');
  assert.deepEqual(catalogue(runtime, registry, { provider: 'evo-x2' })[0].capabilities.thinking, ['medium']);
  assert.deepEqual(models, before);
  assert.equal(registry.find('evo-x2', 'qwen3-coder-next-agent').id, 'qwen3-coder-next-agent');
});

test('explicit selections/backend overrides cannot bypass policy; no automatic substitution', () => {
  for (const id of ['evo-x2/qwen3-coder-next-agent', 'evo-x2/devstral-small-2', 'evo-x2/gpt-oss:120b', 'ollama/qwen3.8:27b', 'llama-cpp/qwen3.8:27b']) {
    for (const extra of [{}, { backend: 'pi' }, { backend: 'claude' }])
      assert.throws(() => resolveSelection(input(id, 'medium', extra), runtime, registry), /excluded by delegate model policy/);
  }
  for (const thinking of ['off', 'low', 'high', 'max'])
    assert.throws(() => resolveSelection(input('evo-x2/qwen3.8:27b', thinking), runtime, registry), /Thinking level excluded/);
  const selected = resolveSelection(input('evo-x2/qwen3.8:27b'), runtime, registry);
  assert.equal(selected.model, 'evo-x2/qwen3.8:27b'); assert.equal(selected.thinking, 'medium');
  assert.equal(selected.backend, 'pi');
  assert.equal(resolveSelection(input('openai-codex/hosted', 'high'), runtime, registry).backend, 'pi');
  assert.equal(resolveSelection(input('anthropic/claude-sonnet-4-6', 'high'), runtime, registry).backend, 'claude');
});

test('preparation and revisions fail before filesystem work, and worker invocation rechecks policy', async () => {
  await assert.rejects(prepare(input('evo-x2/qwen3-coder-next-agent'), runtime, {}), /excluded by delegate model policy/);
  await assert.rejects(prepareRevision({}, input('evo-x2/qwen3-coder-next-agent'), { ...runtime, revisionProtocol: 1 }), /excluded by delegate model policy/);
  assert.throws(() => workerBackend(input('evo-x2/qwen3-coder-next-agent'), runtime), /excluded by delegate model policy/);
  assert.throws(() => workerBackend(input('EVO-X2/qwen3-coder-next-agent'), runtime), /excluded by delegate model policy/);
  assert.throws(() => workerBackend(input('evo-x2/qwen3.8:27b', 'off'), runtime), /Thinking level excluded/);
  assert.equal(workerBackend(input('evo-x2/qwen3.8:27b'), runtime), 'pi');
});

test('an absent allowed model leaves no local production route, never a fallback', () => {
  const remaining = models.filter(m => m.id !== 'qwen3.8:27b');
  const missing = { ...registry, getAll: () => remaining, find: (provider, id) => remaining.find(m => m.provider === provider && m.id === id) };
  assert.equal(catalogue(runtime, missing, { provider: 'evo-x2' }).length, 0);
  assert.throws(() => resolveSelection(input('evo-x2/qwen3.8:27b'), runtime, missing), /Exact model not found/);
});

test('legacy policy is opt-in; configured empty provider disables all its Pi routes', () => {
  assert.equal(catalogue({ ...runtime, piModelPolicy: undefined }, registry).length, models.length + 1);
  assert.equal(catalogue({ ...runtime, piModelPolicy: { 'evo-x2': {} } }, registry, { provider: 'evo-x2' }).length, 0);
  assert.equal(workerBackend(input('evo-x2/qwen3-coder-next-agent')), 'pi');
  const policy = parsePiModelPolicy(runtime);
  assert.equal(allowedPiThinking(policy, 'unlisted', 'any'), undefined);
  assert.equal(allowedPiThinking(policy, 'evo-x2', 'unlisted'), null);
});

test('malformed policy fails closed without blocking no-policy legacy runtimes', () => {
  const invalid = [null, [], { 'bad/provider': {} }, { 'evo-x2': [] }, { 'evo-x2': null },
    { 'evo-x2': { '': ['medium'] } }, { 'evo-x2': { 'model\nname': ['medium'] } },
    { 'evo-x2': { model: [] } }, { 'evo-x2': { model: 'medium' } },
    { 'evo-x2': { model: ['medium', 'medium'] } }, { 'evo-x2': { model: ['automatic'] } }];
  for (const piModelPolicy of invalid) {
    const configured = { ...runtime, piModelPolicy };
    assert.throws(() => catalogue(configured, registry), /Invalid Pi delegate model policy/);
    assert.throws(() => resolveSelection(input('openai-codex/hosted'), configured, registry), /Invalid Pi delegate model policy/);
    assert.throws(() => workerBackend(input('openai-codex/hosted'), configured), /Invalid Pi delegate model policy/);
  }
  assert.equal(parsePiModelPolicy().size, 0);
});
