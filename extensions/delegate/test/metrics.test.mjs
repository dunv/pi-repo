import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeMetrics, usageMetrics, claudeMetrics, metricsLine } from '../metrics.mjs';

function fixture() {
  let time = 0;
  const handlers = new Map(), records = [];
  observeMetrics({ on(name, handler) { handlers.set(name, handler); } }, async record => records.push(record), () => time);
  return { records, at: value => { time = value; }, emit: async (name, event = {}) => handlers.get(name)?.(event) };
}
test('response latency includes preparation, excludes tools; overlapping tools use interval union', async () => {
  const f = fixture();
  await f.emit('agent_start'); await f.emit('turn_start');
  f.at(20); await f.emit('before_provider_request', { payload: 'SECRET' });
  f.at(100); await f.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'SECRET' } });
  f.at(200); await f.emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', usage: { input: 50, output: 10, cacheRead: 20, secret: 'SECRET' } } });
  await f.emit('tool_execution_start', { toolCallId: 'a', toolName: 'read' });
  f.at(250); await f.emit('tool_execution_start', { toolCallId: 'b', toolName: 'delegate_check' });
  f.at(300); await f.emit('tool_execution_end', { toolCallId: 'a' });
  f.at(500); await f.emit('tool_execution_end', { toolCallId: 'b', isError: true });
  await f.emit('turn_start');
  await f.emit('before_provider_request'); await f.emit('before_provider_request');
  f.at(700); await f.emit('message_end', { message: { role: 'assistant', stopReason: 'error' } });
  f.at(800); await f.emit('agent_settled', { aborted: false });
  assert.equal(f.records[0].elapsedMs, 200); assert.equal(f.records[0].firstOutputMs, 100);
  assert.equal(f.records[1].firstOutputMs, null); assert.equal(f.records[1].requests, 2);
  assert.equal(f.records[1].outcome, 'error');
  assert.deepEqual(f.records[2], { type: 'summary', backend: 'pi', elapsedMs: 800, modelMs: 400, toolMs: 300,
    checkMs: 250, responses: 2, toolErrors: 1, usage: { input: 50, output: 10, cacheRead: 20 }, aborted: false });
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET/);
  assert.match(metricsLine(f.records[1]), /first output n\/a/);
});
test('empty deltas and tool result messages do not count as model output', async () => {
  const f = fixture(); await f.emit('agent_start'); await f.emit('turn_start');
  await f.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '' } });
  await f.emit('message_end', { message: { role: 'toolResult' } });
  f.at(50); await f.emit('message_end', { message: { role: 'assistant', stopReason: 'aborted' } });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].firstOutputMs, null);
  assert.equal(f.records[0].outcome, 'aborted');
});
test('usage/Claude records allowlist finite nonnegative numbers; missing metrics stay unknown', () => {
  assert.deepEqual(usageMetrics({ input: -1, output: NaN, cacheRead: Infinity, cacheWrite: '5' }), {});
  const record = claudeMetrics({ duration_api_ms: 123, num_turns: 4, result: 'SECRET', usage: { output_tokens: 10 } }, 500);
  assert.deepEqual(record, { type: 'summary', backend: 'claude', elapsedMs: 500, apiMs: 123, turns: 4, usage: { output: 10 } });
  assert.match(metricsLine(record), /CLI aggregate/);
  assert.match(metricsLine(claudeMetrics({}, 0)), /API n\/a · turns n\/a/);
});
