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
  assert.equal(output, '[delegate] Claude response #1 started\n'
    + '[delegate] Claude response #1: thinking activity (content hidden)\n'
    + 'Reading café ☕\n[delegate] Tool #1 starting: mcp__delegate__read\n'
    + '[delegate] Tool #1 finished: mcp__delegate__read · error\nCompleted fallback.\\u001b[2J\n');
  assert.ok(!output.includes('PRIVATE_'));
  assert.ok(!output.includes('Final report.'), 'result text is retained separately, not duplicated in live logs');
});

test('thinking-only max_tokens responses expose usage, continuation and a repeated-exhaustion warning', async () => {
  let output = '', clock = 0;
  const parser = claudeStream(async chunk => { output += chunk; }, undefined, () => clock);
  for (let i = 1; i <= 3; i++) {
    await parser.write(Buffer.from(encode([
      partial({ type: 'message_start', message: { id: `m${i}`, usage: { input_tokens: 42 } } }),
      partial({ type: 'content_block_start', content_block: { type: 'thinking', thinking: 'PRIVATE_THINKING' } }),
      partial({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } }),
    ])));
    clock += 552000;
    const usage = { output_tokens: 32000, output_tokens_details: { thinking_tokens: 32000 }, secret: 'PRIVATE_USAGE' };
    await parser.write(Buffer.from(encode([
      partial({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage }),
      partial({ type: 'message_stop' }),
      // Completed envelopes must not double-count partial-stream summaries.
      { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }], stop_reason: 'max_tokens', usage } },
      { type: 'user', isMeta: true, message: { content: 'PRIVATE_CONTINUATION_PROMPT' } },
    ])));
  }
  await parser.write(Buffer.from(encode([success])));
  assert.equal((await parser.finish()).streamError, undefined);
  assert.equal((output.match(/finished: observed stream 552\.0s/g) ?? []).length, 3);
  assert.equal((output.match(/thinking activity/g) ?? []).length, 3);
  assert.equal((output.match(/CLI continuation after max_tokens/g) ?? []).length, 2);
  assert.match(output, /stop max_tokens · input tokens 42 · output tokens 32000 · thinking tokens 32000/);
  assert.match(output, /Warning: 2 consecutive thinking-only/);
  assert.match(output, /Warning: 3 consecutive thinking-only/);
  assert.ok(!output.includes('PRIVATE_'));
});

test('completed-envelope fallback deduplicates block envelopes and resets the exhaustion streak on tool progress', async () => {
  let output = '';
  const parser = claudeStream(async chunk => { output += chunk; });
  const response = (id, stop, content, usage = { output_tokens: 32000, output_tokens_details: { thinking_tokens: 32000 } }) =>
    ({ type: 'assistant', message: { id, stop_reason: stop, content, usage } });
  const hidden = [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }];
  const first = response('first', 'max_tokens', hidden);
  await parser.write(Buffer.from(encode([
    first, first,
    response('tool', 'tool_use', [{ type: 'tool_use', id: 't', name: 'read', input: { secret: 'PRIVATE_INPUT' } }]),
    response('next', 'max_tokens', hidden),
    response('unknown-usage', 'max_tokens', hidden, { output_tokens: 32000 }),
    response('last', 'max_tokens', hidden),
    success,
  ])));
  assert.equal((await parser.finish()).streamError, undefined);
  assert.equal((output.match(/finished:/g) ?? []).length, 5);
  assert.match(output, /observed stream n\/a/);
  assert.match(output, /thinking tokens n\/a/);
  assert.ok(!output.includes('Warning:'));
  assert.ok(!output.includes('PRIVATE_'));
});

test('response metadata is allowlisted; foreign activity and invalid usage do not leak or invent numbers', async () => {
  let output = '';
  const parser = claudeStream(async chunk => { output += chunk; });
  await parser.write(Buffer.from(encode([
    { ...partial({ type: 'message_start', message: { id: 'PRIVATE_FOREIGN' } }), parent_tool_use_id: 'foreign' },
    { type: 'assistant', parent_tool_use_id: 'foreign', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }], stop_reason: 'max_tokens' } },
    { type: 'assistant', message: { id: 'PRIVATE_ID', content: [{ type: 'redacted_thinking', data: 'PRIVATE_DATA' }], stop_reason: 'PRIVATE_STOP\u001b[2J',
      usage: { input_tokens: -1, output_tokens: 'PRIVATE_TOKENS', output_tokens_details: { thinking_tokens: 1.5 } } } },
    success,
  ])));
  assert.equal((await parser.finish()).streamError, undefined);
  assert.equal((output.match(/started/g) ?? []).length, 1);
  assert.match(output, /stop unknown · input tokens n\/a · output tokens n\/a · thinking tokens n\/a/);
  assert.ok(!output.includes('PRIVATE_'));
  assert.ok(!output.includes('\u001b'));
});

test('a thinking notice does not require completion and never fabricates a summary', async () => {
  let output = '';
  const parser = claudeStream(async chunk => { output += chunk; });
  await parser.write(Buffer.from(encode([
    partial({ type: 'message_start', message: { id: 'm' } }),
    partial({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } }),
  ])));
  assert.match(output, /thinking activity/);
  assert.ok(!output.includes('finished:'));
  assert.match((await parser.finish()).streamError, /without a terminal result/);
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
