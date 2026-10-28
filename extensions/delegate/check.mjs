import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runtimeFrom, json, save, snapshot, runToFiles, envFor, attemptDirectory, verificationProfile } from './core.mjs';

// Called under the global flock by worker.ts. No shell, arbitrary argv or model-driven retries.
export async function check(runtimePath, id, index, attempt) {
  if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(index) || index < 0) throw new Error('Invalid task/check');
  const runtime = await runtimeFrom(runtimePath), root = join(runtime.state, id);
  const task = await json(join(root, 'task.json')), planned = task.checks[index], directory = attemptDirectory(task, attempt);
  if (!planned || task.id !== id || task.directory !== root) throw new Error('Unplanned check');
  if (attempt !== undefined) {
    const plan = await json(join(directory, 'attempt.json'));
    if (plan.task !== id || plan.attempt !== attempt) throw new Error('Revision identity mismatch');
  }
  const before = await snapshot(task, runtime), start = performance.now();
  const key = `check-${index}-${randomUUID()}`, log = join(directory, key + '.log');
  // Freeze the trusted command plan at preparation; runtime edits cannot silently
  // change an existing task's checks. Expansion is literal argv, never a shell.
  const { command, args: template } = verificationProfile(task.verification);
  const values = { worktree: task.worktree, outputBase: join(root, 'build-output'), kind: planned.kind };
  const args = template.flatMap(arg => arg === '{targets}' ? planned.targets
    : [arg.replace(/\{(worktree|outputBase|kind)\}/g, (_token, name) => values[name])]);
  await save(join(directory, key + '.intent.json'), { index, before, command, args, log });
  const result = await runToFiles(command, args, { cwd: task.worktree, env: envFor(runtime) }, log);
  const after = await snapshot(task, runtime);
  const record = { index, ...result, elapsedMs: Math.round(performance.now() - start), before, after,
    stable: before === after, passed: result.code === 0 && before === after, log };
  await save(join(directory, key + '.json'), record);
  console.log(JSON.stringify(record));
  return record.passed ? 0 : 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  check(process.argv[2], process.argv[3], Number(process.argv[4]), process.argv[5]).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Verification incomplete: ${error.message}`); process.exitCode = 1;
  });
}
