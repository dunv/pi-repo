// Content-free Claude response telemetry. Never render IDs, thinking, prompts,
// arbitrary stop reasons or arbitrary usage fields from the CLI stream.
import { performance } from 'node:perf_hooks';

const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stops = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);

export function claudeProgress(marker, now = () => performance.now()) {
  let current, count = 0, exhausted = 0, continuation = false;
  const begin = async (id, streamed) => {
    current = { id, number: ++count, start: streamed ? now() : undefined, usage: {}, thinking: false, visible: false, reported: false };
    await marker(`[delegate] Claude response #${count} started${continuation ? ' (CLI continuation after max_tokens)' : ''}`);
    continuation = false;
  };
  const usage = value => {
    for (const key of ['input_tokens', 'output_tokens']) {
      const number = tokens(value?.[key]);
      if (number !== undefined) current.usage[key] = number;
    }
    const thinking = tokens(value?.output_tokens_details?.thinking_tokens);
    if (thinking !== undefined) current.usage.thinking_tokens = thinking;
  };
  const thinking = async () => {
    if (current.thinking) return;
    current.thinking = true;
    await marker(`[delegate] Claude response #${current.number}: thinking activity (content hidden)`);
  };
  const finish = async () => {
    if (!current || current.reported) return;
    current.reported = true;
    const stop = stops.has(current.stop) ? current.stop : 'unknown';
    const elapsed = current.start === undefined ? 'n/a' : `${(Math.max(0, now() - current.start) / 1000).toFixed(1)}s`;
    const u = current.usage;
    await marker(`[delegate] Claude response #${current.number} finished: observed stream ${elapsed} · stop ${stop} · input tokens ${u.input_tokens ?? 'n/a'} · output tokens ${u.output_tokens ?? 'n/a'} · thinking tokens ${u.thinking_tokens ?? 'n/a'}`);
    continuation = stop === 'max_tokens';
    // Require explicit token attribution; hidden/redacted content alone does not
    // establish thinking-only exhaustion. Any ordinary response resets the streak.
    exhausted = continuation && !current.visible && u.output_tokens > 0 && u.thinking_tokens === u.output_tokens ? exhausted + 1 : 0;
    if (continuation) await marker('[delegate] Claude output token limit reached; CLI may continue automatically (not task completion)');
    if (exhausted >= 2) await marker(`[delegate] Warning: ${exhausted} consecutive thinking-only token-limit exhaustions; no text/tool progress in these responses. Inspect before continuing; no automatic cancellation or retry.`);
  };
  return async value => {
    if (value.parent_tool_use_id) return;
    if (value.type === 'stream_event') {
      const e = value.event;
      if (e?.type === 'message_start') {
        await begin(e.message?.id, true);
        usage(e.message?.usage);
      }
      if (!current) return;
      if (e?.type === 'content_block_start') {
        if (['thinking', 'redacted_thinking'].includes(e.content_block?.type)) await thinking();
        if (e.content_block?.type === 'tool_use' || (e.content_block?.type === 'text' && e.content_block.text)) current.visible = true;
      }
      if (e?.type === 'content_block_delta') {
        if (e.delta?.type === 'thinking_delta') await thinking();
        if (e.delta?.type === 'text_delta' && e.delta.text) current.visible = true;
      }
      if (e?.type === 'message_delta') {
        usage(e.usage);
        current.stop = e.delta?.stop_reason;
      }
      if (e?.type === 'message_stop') await finish();
    } else if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
      const m = value.message;
      if (!m.content.length && m.stop_reason == null) return;
      // CLI assistant envelopes may repeat once per content block and again
      // after partial events. A message ID identifies one response, not one block.
      if (!current || (m.id !== undefined && m.id !== current.id)) await begin(m.id, false);
      if (current.reported) return;
      usage(m.usage);
      for (const block of m.content) {
        if (['thinking', 'redacted_thinking'].includes(block?.type)) await thinking();
        if (block?.type === 'tool_use' || (block?.type === 'text' && block.text)) current.visible = true;
      }
      if (m.stop_reason != null) { current.stop = m.stop_reason; await finish(); }
    }
  };
}
