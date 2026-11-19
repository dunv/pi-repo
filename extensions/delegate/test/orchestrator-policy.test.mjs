// Real Pi loader/prompt builder; no runtime, worker, model or backend required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadExtensions } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';

const extension = new URL('../index.ts', import.meta.url).pathname;
const policy = (await readFile(new URL('../orchestrator-policy.md', import.meta.url), 'utf8')).trim();
async function load() {
  const loaded = await loadExtensions([extension], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const handlers = loaded.extensions[0].handlers.get('before_agent_start');
  assert.equal(handlers.length, 1);
  return async options => {
    const event = { type: 'before_agent_start', messageType: 'user', prompt: 'A bounded task',
      systemPromptOptions: options, systemPrompt: buildSystemPrompt(options) };
    assert.equal(await handlers[0](event), undefined, 'do not replace the system prompt or add a conversation message');
    return buildSystemPrompt(options);
  };
}
function options(overrides = {}) {
  return normalizeBuildSystemPromptOptions({ cwd: process.cwd(), selectedTools: ['read', 'delegate_task'],
    sections: { unrelated: 'Keep this other extension section.' }, appendSystemPrompt: 'Keep user instructions.',
    contextFiles: [{ path: '/fixture/AGENTS.md', content: 'Keep repository instructions.' }], ...overrides });
}

test('main-agent policy composes with the structured prompt and is idempotent across runs', async () => {
  const emit = await load(), input = options();
  const first = await emit(input);
  assert.equal(input.sections.delegate_orchestration, policy);
  assert.match(first, /<delegate_orchestration>/);
  assert.ok(first.includes(policy));
  assert.match(first, /Keep this other extension section/);
  assert.match(first, /Keep user instructions/);
  assert.match(first, /Keep repository instructions/);
  assert.equal(input.forceSystemPrompt, undefined);
  assert.equal(await emit(input), first);
  assert.equal(first.split(policy).length - 1, 1);
});

test('policy follows the declared task tool and disappears when disabled or hidden', async () => {
  const emit = await load(), input = options();
  await emit(input);
  input.selectedTools = ['read', 'delegate_review'];
  assert.doesNotMatch(await emit(input), /<delegate_orchestration>/);
  assert.equal(input.sections.delegate_orchestration, undefined);
  input.selectedTools.push('delegate_task');
  await emit(input);
  input.hiddenTools = ['delegate_task'];
  assert.doesNotMatch(await emit(input), /<delegate_orchestration>/);
  assert.equal(input.sections.unrelated, 'Keep this other extension section.');
});

test('custom prompt prefix is preserved and an explicit forced full prompt is not bypassed', async () => {
  const emit = await load();
  const custom = await emit(options({ customPrompt: 'Custom main-agent prefix.' }));
  assert.match(custom, /Custom main-agent prefix/);
  assert.ok(custom.includes(policy));
  assert.equal(await emit(options({ forceSystemPrompt: 'Explicit full replacement.' })), 'Explicit full replacement.');
});

test('policy stays bounded and retains the agreed decision rules and capability limits', () => {
  assert.ok(policy.length <= 8500, 'keep delegation, model-selection and brief guidance context cost bounded');
  for (const text of ['benefits outweigh the costs', 'fewest agents', 'Focused summarization', 'Better model fit',
    'Parallel progress', 'Context isolation', 'Independent examination', 'meaningfully verify',
    'inherently sequential', 'large prompt alone', 'Agent agreement is not proof',
    'source references and uncertainties', 'not additional capabilities or authorization', 'source-review enforces read-only source tools']) {
    assert.ok(policy.includes(text), `missing policy principle: ${text}`);
  }
});

test('model-selection guidance keeps capability, effort and route authorization separate', () => {
  for (const text of ['capability and thinking effort separately', 'unresolved decisions',
    'provisional starting hierarchy', 'Opus or Sol', 'Sonnet', 'Lowest supported and tested setting',
    'Settled design decisions do not remove implementation difficulty', 'extra-high/maximum effort',
    'Discover exact routes through delegate_models', 'operator policy',
    'does not establish worker authentication or readiness', 'medium-only policy must not be overridden',
    'report the blocker', 'Do not use an automatic router', 'Jev integration is deferred',
    'representative tasks in the actual worker harness', 'time/cost per accepted result']) {
    assert.ok(policy.includes(text), `missing model-selection principle: ${text}`);
  }
});

test('brief template distinguishes worker rules, referenced guidance and invoker decisions', () => {
  for (const text of ['launcher-supplied shared worker rules', 'invoker-written task brief',
    'does not inherit the main conversation', '## Goal', '## Scope and exclusions',
    '## Relevant context', '## Settled decisions', '## Open decisions', '## Guidance to read',
    '## Acceptance criteria and verification', '## Expected report',
    'combine or omit inapplicable sections', 'without predetermined conclusions',
    'Separate established facts from hypotheses', 'not an enforced read-only environment',
    'references will be accessible', 'conflicts or missing required guidance are blockers',
    'remain separate tool arguments', 'must agree with the actual check plan',
    "frozen checks/profile", "previous worker's conversation"]) {
    assert.ok(policy.includes(text), `missing brief principle: ${text}`);
  }
});

test('structured brief guidance keeps brief text free-form alongside explicit environment selection', async () => {
  const loaded = await loadExtensions([extension], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  const expected = {
    delegate_task: ['repo', 'brief', 'backend', 'model', 'thinking', 'environment', 'profile', 'checks'],
    delegate_revise: ['task', 'expectedNonce', 'expectedFingerprint', 'brief', 'backend', 'model', 'thinking'],
  };
  for (const [name, fields] of Object.entries(expected)) {
    const schema = tools.get(name).definition.parameters;
    assert.deepEqual(Object.keys(schema.properties).sort(), fields.sort());
    assert.equal(schema.properties.brief.type, 'string');
    assert.equal(schema.properties.brief.minLength, 1);
    assert.equal(schema.properties.brief.maxLength, 32000);
    assert.equal(schema.properties.brief.pattern, undefined, 'headings are guidance, not validation');
  }
});
