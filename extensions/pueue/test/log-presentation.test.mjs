import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logPresentation } from '../log-presentation.ts';
import { extension } from '../index.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const nonce = '00000000-0000-4000-8000-000000000001';
const payload = (overrides = {}) => ({ status: { nonce, id: 67, phase: 'EXITED', exitCode: 7 },
  log: { path: '/logs/67.log', start: 10, end: 30, size: 100, text: 'hello\nerror\x1b[31m\r\u009b', omittedBefore: true, omittedAfter: true }, ...overrides });
const content = data => [{ type: 'text', text: JSON.stringify(data) }];

test('log presentation collapses output, expands slice metadata and escapes controls without modifying payload', () => {
  const data = payload(), before = structuredClone(data);
  const collapsed = logPresentation(content(data), false);
  assert.match(collapsed.heading, /Failed · exit 7 · log 20 B/);
  assert.deepEqual(collapsed.details, []);
  const expanded = logPresentation(content(data), true).details.join('\n');
  assert.match(expanded, /Bytes 10–30 of 100 · earlier bytes omitted · later bytes omitted/);
  assert.match(expanded, /Artifact: \/logs\/67.log/);
  assert.match(expanded, /hello\nerror\\u001b\[31m\\u000d\\u009b/);
  assert.match(expanded, /untrusted workload text/);
  assert.doesNotMatch(expanded, /\x1b|\r|\u009b/);
  assert.deepEqual(data, before);
});

test('large valid log slices render; empty/missing/malformed data is explicit', () => {
  const data = payload(); data.log.text = 'x'.repeat(16384);
  assert.ok(logPresentation(content(data), true).details.join('\n').includes(data.log.text));
  data.log.text = ''; data.log.start = data.log.end = data.log.size = 0;
  delete data.log.omittedBefore; delete data.log.omittedAfter;
  const empty = logPresentation(content(data), true).details.join('\n');
  assert.match(empty, /empty log slice/); assert.doesNotMatch(empty, /omitted/);
  for (const value of [null, {}, payload({ log: { text: 'unsafe' } })]) assert.equal(logPresentation(content(value), true), undefined);
  assert.equal(logPresentation([{ type: 'text', text: 'bad JSON' }], true), undefined);
});

test('result tool renderers are UI-only, width-safe and preserve error diagnostics', () => {
  const tools = new Map(), messages = [];
  extension({ registerMessageRenderer() {}, on() {}, registerTool: t => tools.set(t.name, t), registerCommand() {}, sendMessage: m => messages.push(m) });
  const tool = tools.get('pueue_result'), theme = { fg: (_ink, text) => text };
  const reply = { content: content(payload()), details: undefined }, before = structuredClone(reply);
  const context = { outputPad: 1, args: { nonce }, isError: false };
  assert.equal(tool.renderShell, 'self');
  for (const expanded of [false, true]) for (const width of [8, 40, 120]) {
    const lines = tool.renderResult(reply, { expanded, isPartial: false }, theme, context).render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  const error = tool.renderResult({ content: [{ type: 'text', text: 'Ownership UNKNOWN; result withheld\x1b' }] }, { expanded: false }, theme, { ...context, isError: true }).render(160).join('\n');
  assert.match(error, /Log unavailable/); assert.match(error, /Ownership UNKNOWN; result withheld/); assert.doesNotMatch(error, /\x1b/);
  assert.deepEqual(reply, before); assert.deepEqual(messages, []);
});
