// Deployment entry point: an attempt-specific user scope contains the runner,
// model CLI, MCP bridge and check descendants. Pueue still owns admission/logs.
import { spawn } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFrom, json, attemptDirectory, envFor } from './core.mjs';
import { recordContainment, scopeName } from './containment.mjs';
import { run } from './run.mjs';
import { timestampLine } from './logging.mjs';

export async function scopedRun(runtimePath, id, attempt, inside = false) {
  const runtime = await runtimeFrom(runtimePath), unit = scopeName(id, attempt);
  if (runtime.containmentProtocol !== 1 || !isAbsolute(runtime.systemdRun ?? '')) throw new Error('Attempt scope runtime unavailable');
  const directory = join(runtime.state, id), task = await json(join(directory, 'task.json'));
  if (task.id !== id || task.directory !== directory) throw new Error('Scope task identity mismatch');
  attemptDirectory(task, attempt); // Validate before invoking systemd.
  if (inside) {
    await recordContainment(task, attempt);
    return run(runtimePath, id, attempt);
  }
  // These are derived local bus paths, not inherited tokens or agent sockets.
  const userRuntime = `/run/user/${process.getuid()}`;
  const args = ['--user', '--scope', '--quiet', '--collect', '--unit', unit, '--', runtime.node,
    join(dirname(fileURLToPath(import.meta.url)), 'scope.mjs'), '--inside', runtimePath, id,
    ...(attempt === undefined ? [] : [attempt])];
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.systemdRun, args, { cwd: task.worktree, stdio: 'inherit',
      env: { ...envFor(runtime), XDG_RUNTIME_DIR: userRuntime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${userRuntime}/bus` } });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal || code === null ? 1 : code));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inside = process.argv[2] === '--inside', args = process.argv.slice(inside ? 3 : 2);
  if (args.length < 2 || args.length > 3) throw new Error('Expected runtime, task and optional attempt');
  scopedRun(args[0], args[1], args[2], inside).then(code => { process.exitCode = code; }).catch(error => {
    console.error(timestampLine(`Delegate scope did not complete: ${error.message}. Retain evidence; do not retry automatically.`));
    process.exitCode = 1;
  });
}
