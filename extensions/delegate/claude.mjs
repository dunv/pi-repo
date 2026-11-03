// Claude Code is a separate harness, not a Pi provider. Keep its capabilities
// behind the same trusted source-write / planned-check boundary via one MCP.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { claudeMetrics, metricsLine } from './metrics.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save, envFor } from './core.mjs';
import { runClaudeStream } from './claude-stream.mjs';

export async function runClaude(runtime, runtimePath, task, plan, directory, attempt) {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = join(directory, 'claude-mcp.json');
  await save(config, { mcpServers: { delegate: { type: 'stdio', command: runtime.node,
    args: [join(here, 'claude-tools.mjs'), runtimePath, task.id, ...(attempt === undefined ? [] : [attempt])] } } });
  const args = ['--print', '--model', plan.model, '--effort', plan.thinking,
    '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', config,
    '--tools', '', '--allowedTools', 'mcp__delegate__*', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--no-chrome', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages',
    '--session-id', attempt ?? task.id, '--name', `delegate-${task.id}`,
    '--append-system-prompt', await readFile(join(here, 'policy.md'), 'utf8')];
  const start = performance.now();
  const { reply, streamError, ...result } = await runClaudeStream(runtime.claude, args,
    { cwd: task.worktree, env: envFor(runtime) }, join(directory, 'brief.md'), join(directory, 'worker.log'));
  const elapsedMs = performance.now() - start;
  try {
    if (reply) await save(join(directory, 'claude-result.json'), reply);
    if (streamError) throw new Error(streamError);
    const record = claudeMetrics(reply, elapsedMs);
    await appendFile(join(directory, 'metrics.jsonl'), JSON.stringify({ schemaVersion: 1,
      timestamp: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    const line = metricsLine(record);
    await appendFile(join(directory, 'worker.log'), line, { mode: 0o600 });
    process.stderr.write(line);
    if (result.code !== 0 || result.signal || typeof reply.result !== 'string'
      || reply.is_error !== false || reply.subtype !== 'success') throw new Error('Claude result is not a confirmed success');
    await writeFile(join(directory, 'report.md'), reply.result + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return { ...result, code: result.code === 0 ? 1 : result.code, workerError: error.message };
  }
  return result;
}
