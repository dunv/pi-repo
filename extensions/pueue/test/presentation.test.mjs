import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandPreview, displayState, statusLabel, submission, submissionDetails, submissionFor } from '../presentation.ts';
import { extension } from '../index.ts';
import { noticeText } from '../notice.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const nonce = '00000000-0000-4000-8000-000000000001';
const input = { argv: ['/bin/build-tool', 'run', '/checkout#dev', '--command', '/bin/echo', "a'b", 'x\ny', '\x1b[31m'], cwd: '/checkout' };
const queued = { nonce, id: 4, phase: 'QUEUED' };
const theme = { fg: (_ink, text) => text };

test('submission presentation uses existing literal arguments/cwd, escapes controls, and labels runtime without inspecting env', () => {
  const text = submissionDetails(input).join('\n');
  assert.match(text, /Command \(literal argv\): "\/bin\/build-tool" "run"/);
  assert.match(text, /Working directory: "\/checkout"/);
  assert.match(text, /configured Pueue runtime, not the interactive shell/);
  assert.match(text, /x\\ny/);
  assert.match(text, /\\u001b/);
  assert.doesNotMatch(text, /\x1b/);
  assert.match(commandPreview(input), /…$/);
  assert.match(submissionDetails({ argv: ['x'.repeat(20000)], cwd: '/repo' })[0], /display truncated/);
  for (const value of [undefined, {}, { argv: [1], cwd: '/' }]) assert.equal(submission(value), undefined);
  for (const phase of ['QUEUED', 'RUNNING', 'PAUSED', 'STASHED', 'UNKNOWN', 'ADMISSION_UNKNOWN', '__proto__']) assert.ok(statusLabel({ phase }).text);
});

test('completion details join only existing matching submit results and calls; missing evidence stays unavailable', () => {
  const entries = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'pueue_submit', arguments: input }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'pueue_submit', content: [{ type: 'text', text: JSON.stringify(queued) }] } },
  ];
  const before = structuredClone(entries);
  assert.deepEqual(submissionFor(entries, nonce), input);
  assert.equal(submissionFor(entries.slice(0, 1), nonce), undefined);
  assert.equal(submissionFor(entries, 'another-nonce'), undefined);
  assert.equal(submissionFor([{ ...entries[1], message: { ...entries[1].message, toolName: 'another_tool' } }, entries[0]], nonce), undefined);
  assert.deepEqual(entries, before);
  assert.match(noticeText(JSON.stringify({ ...queued, phase: 'EXITED', exitCode: 0 }), true, input), /Command \(literal argv\)/);
  assert.match(noticeText(JSON.stringify(queued), false, input), /\/bin\/build-tool/);
});

test('submit renderers collapse details, expand argv/cwd and preserve model-facing payloads exactly', () => {
  const tools = new Map(), notices = [];
  extension({ registerMessageRenderer() {}, on() {}, registerTool: t => tools.set(t.name, t), registerCommand() {}, sendMessage: m => notices.push(m) });
  const tool = tools.get('pueue_submit');
  const result = { content: [{ type: 'text', text: JSON.stringify(queued) }], details: undefined };
  const original = structuredClone(result);
  const context = { args: input, outputPad: 0, isError: false };
  assert.equal(tool.renderShell, 'self');
  for (const width of [5, 20, 80]) {
    const lines = tool.renderCall(input, theme, context).render(width);
    assert.equal(lines.length, 1);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(120).join('\n');
  assert.match(collapsed, /◷ Pueue #4 · Queued/);
  assert.doesNotMatch(collapsed, /Command|Working directory|nonce/);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(200).join('\n');
  assert.match(expanded, /Command \(literal argv\)/);
  assert.match(expanded, /Working directory/);
  assert.match(expanded, new RegExp(nonce));
  const error = tool.renderResult({ content: [{ type: 'text', text: 'Admission UNKNOWN\nDo not retry\x1b[31m' }] }, { expanded: false }, theme, { ...context, isError: true }).render(200).join('\n');
  assert.match(error, /Do not retry/); assert.doesNotMatch(error, /\x1b/);
  assert.deepEqual(result, original);
  assert.deepEqual(notices, []);
  assert.deepEqual(displayState(result.content), queued);
});
