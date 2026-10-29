// Claude Code is a separate harness, not a Pi provider. Keep its capabilities
// behind the same trusted source-write / planned-check boundary via one MCP.
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save, runToFiles, envFor } from './core.mjs';

export async function runClaude(runtime, runtimePath, task, plan, directory, attempt) {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = join(directory, 'claude-mcp.json');
  await save(config, { mcpServers: { delegate: { type: 'stdio', command: runtime.node,
    args: [join(here, 'claude-tools.mjs'), runtimePath, task.id, ...(attempt === undefined ? [] : [attempt])] } } });
  const args = ['--print', '--model', plan.model, '--effort', plan.thinking,
    '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', config,
    '--tools', '', '--allowedTools', 'mcp__delegate__*', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--no-chrome', '--output-format', 'json',
    '--session-id', attempt ?? task.id, '--name', `delegate-${task.id}`,
    '--append-system-prompt', await readFile(join(here, 'policy.md'), 'utf8')];
  const result = await runToFiles(runtime.claude, args, { cwd: task.worktree, env: envFor(runtime) },
    join(directory, 'claude-result.json'), join(directory, 'worker.log'), true, join(directory, 'brief.md'));
  let reply;
  try {
    reply = JSON.parse(await readFile(join(directory, 'claude-result.json'), 'utf8'));
    if (typeof reply.result !== 'string' || reply.is_error !== false || reply.subtype !== 'success') throw new Error('Claude result is not a confirmed success');
    await writeFile(join(directory, 'report.md'), reply.result + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return { ...result, code: result.code === 0 ? 1 : result.code, workerError: error.message };
  }
  return result;
}
