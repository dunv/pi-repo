import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeStream } from '../claude-stream.mjs';

const partial = event => ({ type: 'stream_event', event, parent_tool_use_id: null });
const success = { type: 'result', subtype: 'success', is_error: false, result: 'Final report.' };
const encode = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('Claude stream renders text deltas once, tool lifecycle only, and excludes private payloads', async () => {
  let output = '';
  const parser = claudeStream(async chunk => { output += chunk; });
  const events = [
    { type: 'system', subtype: 'init', api_key: 'PRIVATE_INIT' },
    { type: 'user', message: { content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] } },
    partial({ type: 'message_start', message: { id: 'message-1' } }),
    partial({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } }),
    partial({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } }),
    partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading café ☕' } }),
    partial({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'mcp__delegate__read', input: {} } }),
    partial({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'PRIVATE_ARGS' } }),
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'Reading café ☕' },
      { type: 'tool_use', id: 'tool-1', name: 'mcp__delegate__read', input: { content: 'PRIVATE_BODY' } },
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'PRIVATE_FILE', is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Completed fallback.\u001b[2J' }] } },
    { type: 'assistant', parent_tool_use_id: 'foreign', message: { content: [{ type: 'text', text: 'PRIVATE_SUBAGENT' }] } },
    success,
  ];
  // Byte-at-a-time chunks split JSON records and multibyte UTF-8 characters.
  for (const byte of Buffer.from(encode(events))) await parser.write(Buffer.from([byte]));
  assert.deepEqual(await parser.finish(), { reply: success, streamError: undefined });
  assert.equal(output, 'Reading café ☕\n[delegate] Tool #1 starting: mcp__delegate__read\n'
    + '[delegate] Tool #1 finished: mcp__delegate__read · error\nCompleted fallback.\\u001b[2J\n');
  assert.ok(!output.includes('PRIVATE_'));
  assert.ok(!output.includes('Final report.'), 'result text is retained separately, not duplicated in live logs');
});

test('Claude stream supports CRLF, blank lines and a final record without newline', async () => {
  const parser = claudeStream(async () => {});
  await parser.write(Buffer.from('\r\n' + JSON.stringify(success) + '\r'));
  assert.deepEqual(await parser.finish(), { reply: success, streamError: undefined });
});

test('malformed, oversized, missing and repeated terminal results fail closed without echoing raw data', async () => {
  for (const [input, error] of [
    ['PRIVATE_BAD_JSON\n' + encode([success]), /Malformed/],
    [encode([null, success]), /Invalid/],
    [encode([{ type: 'assistant', message: { content: [] } }]), /without a terminal result/],
    [encode([success, success]), /after its terminal result/],
    [encode([success, { type: 'assistant' }]), /after its terminal result/],
    ['x'.repeat(200) + '\n' + encode([success]), /size limit/],
  ]) {
    let output = '';
    const parser = claudeStream(async chunk => { output += chunk; }, 150);
    await parser.write(Buffer.from(input));
    assert.match((await parser.finish()).streamError, error);
    assert.equal(output, '');
  }
});
