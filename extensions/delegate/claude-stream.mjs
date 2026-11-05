// Decode only allowlisted human-facing progress. Never mirror raw stream JSON,
// thinking, input_json deltas, user prompts or tool result bodies into live logs.
import { spawn } from 'node:child_process';
import { timestampLines } from './logging.mjs';
import { claudeProgress } from './claude-progress.mjs';
import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

export function claudeStream(emit, maxLineBytes = 8 * 1024 * 1024, now) {
  const decoder = new StringDecoder('utf8'), tools = new Map();
  let pending = '', bytes = 0, discarding = false, error, reply;
  let streamedText = false, lineOpen = false, toolNumber = 0;
  const fail = message => { error ??= message; };
  const text = async value => {
    if (!value) return;
    // Retain newlines/tabs, but do not let model text inject terminal controls.
    value = value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    await emit(value); lineOpen = !value.endsWith('\n');
  };
  const marker = async value => {
    await emit((lineOpen ? '\n' : '') + value + '\n'); lineOpen = false;
  };
  const progress = claudeProgress(marker, now);
  const startTool = async block => {
    if (typeof block.id !== 'string' || block.id.length > 256 || tools.has(block.id)) return;
    if (tools.size >= 1024) { fail('Claude stream has too many pending tools'); return; }
    const name = typeof block.name === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(block.name) ? block.name : 'unknown';
    const tool = { number: ++toolNumber, name }; tools.set(block.id, tool);
    await marker(`[delegate] Tool #${tool.number} starting: ${name}`);
  };
  const event = async line => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch { fail('Malformed Claude stream JSON'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
      fail('Invalid Claude stream event'); return;
    }
    if (reply) { fail('Claude stream contains events after its terminal result'); return; }
    if (value.type === 'result') { reply = value; return; }
    // Subagent output is not enabled by this runner. Do not mix its deltas with
    // the main assistant or echo forwarded prompts from other conversations.
    if (value.parent_tool_use_id) return;
    if (value.type === 'stream_event') {
      const e = value.event;
      if (e?.type === 'message_start') streamedText = false;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') await startTool(e.content_block);
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        streamedText = true; await text(e.delta.text);
      }
    } else if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
      // The CLI repeats completed assistant messages after the partial events.
      for (const block of value.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && !streamedText) await text(block.text);
        if (block?.type === 'tool_use') await startTool(block);
      }
      streamedText = false;
    } else if (value.type === 'user' && Array.isArray(value.message?.content)) {
      for (const block of value.message.content) {
        if (block?.type !== 'tool_result') continue;
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        tools.delete(block.tool_use_id);
        await marker(`[delegate] Tool #${tool.number} finished: ${tool.name} · ${block.is_error === true ? 'error' : 'done'}`);
      }
    }
    await progress(value);
  };
  const consume = async decoded => {
    const fragments = decoded.split('\n');
    for (let i = 0; i < fragments.length; i++) {
      const part = fragments[i]; bytes += Buffer.byteLength(part);
      if (bytes > maxLineBytes) { fail('Claude stream event exceeds size limit'); pending = ''; discarding = true; }
      if (!discarding) pending += part;
      if (i < fragments.length - 1) {
        if (!discarding) await event(pending);
        pending = ''; bytes = 0; discarding = false;
      }
    }
  };
  return {
    async write(chunk) { await consume(decoder.write(chunk)); },
    async finish() {
      await consume(decoder.end());
      if (pending && !discarding) await event(pending);
      if (lineOpen) await emit('\n');
      if (!reply) fail('Claude stream ended without a terminal result');
      return { reply, streamError: error };
    },
  };
}

export async function runClaudeStream(executable, args, options, inputPath, logPath) {
  const stdin = await open(inputPath, 'r');
  let log;
  // Serialize stdout/stderr writes to the shared private worker log. Each source
  // observes backpressure; no transcript-sized array or unbounded output queue.
  let writing = Promise.resolve();
  const stamp = timestampLines();
  const emit = (chunk, destination = process.stdout) => {
    const next = writing.then(async () => {
      const visible = stamp(chunk);
      await log.writeFile(visible);
      await new Promise((resolve, reject) => destination.write(visible, error => error ? reject(error) : resolve()));
    });
    writing = next.catch(() => {});
    return next;
  };
  try {
    log = await open(logPath, 'wx', 0o600);
    const parser = claudeStream(emit);
    const child = spawn(executable, args, { ...options, stdio: [stdin.fd, 'pipe', 'pipe'] });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const sink = write => new Writable({ write(chunk, _encoding, done) { write(chunk).then(() => done(), done); } });
    const streams = Promise.allSettled([
      pipeline(child.stdout, sink(chunk => parser.write(chunk))),
      pipeline(child.stderr, sink(chunk => emit(chunk, process.stderr))),
    ]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
    // Drain and wait for process completion even if a stream fails. Never retry,
    // signal a worker, infer completion from a result event, or leave it detached.
    const [exit, output] = await Promise.allSettled([exited, streams]);
    if (exit.status === 'rejected') throw exit.reason;
    if (output.status === 'rejected') throw output.reason;
    return { ...exit.value, ...await parser.finish() };
  } finally {
    await writing;
    try { await log?.close(); } finally { await stdin.close(); }
  }
}
