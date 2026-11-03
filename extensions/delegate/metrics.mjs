// Display-only telemetry. Never retain prompts, deltas, tool args or provider payloads.
import { performance } from 'node:perf_hooks';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function usageMetrics(usage, claude = false) {
  const fields = claude ? { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' }
    : { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite' };
  const result = {};
  for (const [key, field] of Object.entries(fields)) {
    const value = number(usage?.[field]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
export function metricsLine(record) {
  if (record.type === 'response') return `[delegate] Model #${record.response} finished: ${seconds(record.elapsedMs)} · first output ${record.firstOutputMs === null ? 'n/a' : seconds(record.firstOutputMs)} · output tokens ${record.usage.output ?? 'n/a'} · requests ${record.requests} · ${record.outcome}\n`;
  if (record.backend === 'claude') return `[delegate] Claude summary: ${seconds(record.elapsedMs)} elapsed · API ${record.apiMs === undefined ? 'n/a' : seconds(record.apiMs)} · turns ${record.turns ?? 'n/a'} · output tokens ${record.usage.output ?? 'n/a'} (CLI aggregate; no per-response timing)\n`;
  return `[delegate] Worker summary: ${seconds(record.elapsedMs)} elapsed · model ${seconds(record.modelMs)} · tools ${seconds(record.toolMs)} · checks ${seconds(record.checkMs)} (included in tools) · ${record.responses} responses · ${record.toolErrors} tool errors · output tokens ${record.usage.output ?? 'n/a'}\n`;
}

// Turn start precedes context preparation/provider dispatch; message_start can
// arrive only after the HTTP response, so it is too late to start this clock.
export function observeMetrics(pi, emit, now = () => performance.now()) {
  let start, turn, responses = 0, modelMs = 0, toolMs = 0, checkMs = 0, toolErrors = 0;
  let toolsSince, checksSince;
  const tools = new Map(), usage = {};
  pi.on('agent_start', () => { start ??= now(); });
  pi.on('turn_start', () => { turn = { start: now(), first: null, requests: 0 }; });
  pi.on('before_provider_request', () => { if (turn) turn.requests++; });
  pi.on('message_update', event => {
    const update = event.assistantMessageEvent;
    if (turn && turn.first === null && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update.type) && update.delta?.length) turn.first = now();
  });
  pi.on('message_end', async event => {
    if (event.message.role !== 'assistant' || !turn) return;
    const current = turn; turn = undefined;
    const elapsedMs = Math.max(0, now() - current.start); modelMs += elapsedMs;
    const outcome = ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(event.message.stopReason) ? event.message.stopReason : 'unknown';
    const responseUsage = usageMetrics(event.message.usage);
    for (const [key, value] of Object.entries(responseUsage)) usage[key] = (usage[key] ?? 0) + value;
    await emit({ type: 'response', backend: 'pi', response: ++responses, elapsedMs,
      firstOutputMs: current.first === null ? null : Math.max(0, current.first - current.start),
      requests: current.requests, outcome, usage: responseUsage });
  });
  pi.on('tool_execution_start', event => {
    const time = now();
    if (!tools.size) toolsSince = time;
    if (event.toolName === 'delegate_check' && ![...tools.values()].includes('delegate_check')) checksSince = time;
    tools.set(event.toolCallId, event.toolName);
  });
  pi.on('tool_execution_end', event => {
    if (!tools.has(event.toolCallId)) return;
    const check = tools.get(event.toolCallId) === 'delegate_check'; tools.delete(event.toolCallId);
    const time = now();
    if (check && ![...tools.values()].includes('delegate_check')) checkMs += time - checksSince;
    if (!tools.size) toolMs += time - toolsSince;
    if (event.isError) toolErrors++;
  });
  pi.on('agent_settled', async event => {
    const time = now();
    await emit({ type: 'summary', backend: 'pi', elapsedMs: Math.max(0, time - (start ?? time)), modelMs,
      toolMs: toolMs + (tools.size ? time - toolsSince : 0),
      checkMs: checkMs + ([...tools.values()].includes('delegate_check') ? time - checksSince : 0),
      responses, toolErrors, usage: { ...usage }, aborted: event.aborted });
  });
}

export function claudeMetrics(reply, elapsedMs) {
  return { type: 'summary', backend: 'claude', elapsedMs, apiMs: number(reply.duration_api_ms),
    turns: Number.isInteger(reply.num_turns) ? number(reply.num_turns) : undefined,
    usage: usageMetrics(reply.usage, true) };
}
