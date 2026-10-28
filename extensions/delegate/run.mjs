import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeFrom, json, save, assertWorktree, runToFiles, envFor, snapshot, attemptDirectory } from './core.mjs';

export async function run(runtimePath, id, attempt) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Full task UUID required');
  const runtime = await runtimeFrom(runtimePath), root = join(runtime.state, id);
  const task = await json(join(root, 'task.json')), directory = attemptDirectory(task, attempt);
  if (task.id !== id || task.directory !== root) throw new Error('Task identity mismatch');
  const plan = attempt === undefined ? task : await json(join(directory, 'attempt.json'));
  if (attempt !== undefined && (plan.task !== id || plan.attempt !== attempt)) throw new Error('Revision identity mismatch');
  await assertWorktree(task, runtime, attempt === undefined);
  if (attempt !== undefined && await snapshot(task, runtime) !== plan.expectedFingerprint) {
    throw new Error('Revision source changed after handoff; retain evidence and reconcile');
  }
  // One-shot claim: even an interrupted attempt is never automatically relaunched.
  await save(join(directory, 'started.json'), { started: new Date().toISOString() });
  const start = performance.now(), here = dirname(fileURLToPath(import.meta.url));
  const [provider, ...model] = plan.model.split('/');
  const args = ['--print', '--provider', provider, '--model', model.join('/'), '--thinking', plan.thinking,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-mcp',
    '--extension', join(here, 'worker.ts'), '--tools', 'read,grep,find,ls,edit,write,delegate_check',
    '--session-dir', join(directory, 'sessions'), '--name', `delegate-${id}`,
    '--append-system-prompt', join(here, 'policy.md'), '@' + join(directory, 'brief.md')];
  console.log(`[delegate] Worker starting: task=${id}${attempt ? ` revision=${attempt}` : ''} model=${plan.model} requested-thinking=${plan.thinking}`);
  const result = await runToFiles(runtime.pi, args, {
    cwd: task.worktree, env: { ...envFor(runtime), PI_DELEGATE_RUNTIME: runtimePath, PI_DELEGATE_TASK: id,
      ...(attempt === undefined ? {} : { PI_DELEGATE_ATTEMPT: attempt }) },
  }, join(directory, 'report.md'), join(directory, 'worker.log'), true);
  let fingerprint, integrityError;
  try { fingerprint = await snapshot(task, runtime); } catch (error) { integrityError = error.message; }
  await save(join(directory, 'result.json'), { ...result, elapsedMs: Math.round(performance.now() - start), fingerprint, integrityError,
    accepted: false });
  console.log(JSON.stringify({ task: id, attempt, workerExit: result.code, integrityError, artifacts: directory, reviewRequired: true }));
  return integrityError || result.code === null ? 1 : result.code;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv[2], process.argv[3], process.argv[4]).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Worker did not complete: ${error.message}. Retain evidence; do not automatically retry.`); process.exitCode = 1;
  });
}
