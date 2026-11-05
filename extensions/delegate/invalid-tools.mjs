import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INVALID_TOOL_LIMIT = 3;
export const INVALID_TOOL_ARTIFACT = 'invalid-tools.json';
const safeName = name => typeof name === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(name) ? name : '[invalid tool name]';

// Per worker process/attempt, cumulative rather than consecutive. Only finalized
// assistant calls to names outside the offered loadout count, never tool errors.
export function observeInvalidTools(pi, onTrip) {
  let count = 0, pending, stopped = false;
  const names = [];
  pi.on('message_end', event => {
    if (stopped || pending || event.message.role !== 'assistant') return;
    const calls = (event.message.content ?? []).filter(block => block.type === 'toolCall');
    if (!calls.length) return;
    const offered = new Set(pi.getActiveTools());
    for (const block of calls) {
      if (offered.has(block.name)) continue;
      count++;
      if (names.length < INVALID_TOOL_LIMIT) names.push(safeName(block.name));
    }
    if (count >= INVALID_TOOL_LIMIT) pending = {
      schemaVersion: 1, reason: 'invalid-tool-limit', limit: INVALID_TOOL_LIMIT, count, tools: [...names],
    };
  });
  // A batch can contain the third invalid call plus valid writes/checks. Once
  // tripped, block those too while Pi records the current batch's tool results.
  pi.on('tool_call', () => {
    if (pending || stopped) return { block: true, reason: 'Delegate stopped: invalid-tool-limit; retain work and logs for review' };
  });
  pi.on('turn_end', async (_event, ctx) => {
    if (!pending || stopped) return;
    stopped = true;
    try { await onTrip(pending); }
    finally { ctx.abort(); } // No next model turn, process signals, retry or cleanup.
  });
}

// Keep a guard trip a failure even if a CLI version reports a graceful abort as
// exit zero. Never echo malformed evidence or treat unreadable evidence as clear.
export async function invalidToolFailure(directory) {
  let record;
  try { record = JSON.parse(await readFile(join(directory, INVALID_TOOL_ARTIFACT), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return { failureReason: 'invalid-tool-evidence' };
  }
  if (record?.schemaVersion !== 1 || record.reason !== 'invalid-tool-limit' || record.limit !== INVALID_TOOL_LIMIT ||
      !Number.isSafeInteger(record.count) || record.count < INVALID_TOOL_LIMIT ||
      !Array.isArray(record.tools) || record.tools.length !== INVALID_TOOL_LIMIT ||
      !record.tools.every(name => typeof name === 'string' && safeName(name) === name)) {
    return { failureReason: 'invalid-tool-evidence' };
  }
  return { failureReason: 'invalid-tool-limit', invalidTools: {
    limit: record.limit, count: record.count, tools: record.tools,
  } };
}
