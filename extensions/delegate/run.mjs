import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { assertTaskEnvironment, workerTools, environmentCommand, environmentPath, environmentInstructions } from './environments.mjs';
import { runClaude } from './claude.mjs';
import { timestampLine } from './logging.mjs';
import { assertContained } from './containment.mjs';
import { withTaskLock } from './lock.mjs';
import { invalidToolFailure } from './invalid-tools.mjs';
import { runtimeFrom, json, save, assertWorktree, runToFiles, envFor, snapshot, attemptDirectory, workerBackend, initiatorLabel } from './core.mjs';

const log = text => console.log(timestampLine(text));

export async function run(runtimePath, id, attempt) {
  const runtime = await runtimeFrom(runtimePath);
  return withTaskLock(runtime, id, true, () => runWorker(runtimePath, id, attempt));
}
async function runWorker(runtimePath, id, attempt) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Full task UUID required');
  const runtime = await runtimeFrom(runtimePath), root = join(runtime.state, id);
  const task = await json(join(root, 'task.json')), directory = attemptDirectory(task, attempt);
  if (task.version !== 2 || task.id !== id || task.directory !== root) throw new Error('Disposable task identity mismatch');
  const plan = attempt === undefined ? task : await json(join(directory, 'attempt.json'));
  if (attempt !== undefined && (plan.task !== id || plan.attempt !== attempt)) throw new Error('Revision identity mismatch');
  const backend = workerBackend(plan, runtime);
  assertTaskEnvironment(task, runtime);
  if (runtime.containmentProtocol === 1) await assertContained(task, attempt);
  await assertWorktree(task, runtime, attempt === undefined);
  if (attempt !== undefined && await snapshot(task, runtime) !== plan.expectedFingerprint) {
    throw new Error('Revision source changed after handoff; retain evidence and reconcile');
  }
  const initialFingerprint = task.execution?.capabilities.source === 'read-only' ? await snapshot(task, runtime) : undefined;
  // One-shot claim: even an interrupted attempt is never automatically relaunched.
  await save(join(directory, 'started.json'), { started: new Date().toISOString() });
  const start = performance.now(), here = dirname(fileURLToPath(import.meta.url));
  let policyPath = join(here, 'policy.md');
  if (task.execution) {
    policyPath = join(directory, 'worker-policy.md');
    await writeFile(policyPath, await readFile(join(here, 'policy.md'), 'utf8') + environmentInstructions(task), { flag: 'wx', mode: 0o600 });
  }
  const [provider, ...model] = plan.model.split('/');
  const args = ['--print', '--provider', provider, '--model', model.join('/'), '--thinking', plan.thinking,
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-mcp',
    '--extension', join(here, 'worker.ts'), '--tools', workerTools(task).join(','),
    '--session-dir', join(directory, 'sessions'), '--name', `delegate-${id}`,
    '--append-system-prompt', policyPath, '@' + join(directory, 'brief.md')];
  const launch = environmentCommand(task, runtime, runtime.pi, args);
  log(`[delegate] Initiated by: ${task.initiatorLabel ?? initiatorLabel(task.owner)} session=${task.owner.session}`);
  log(`[delegate] Worker starting: task=${id}${attempt ? ` revision=${attempt}` : ''} model=${plan.model} requested-thinking=${plan.thinking}`);
  log(`[delegate] Prompt file: ${JSON.stringify(join(directory, 'brief.md'))}`);
  const result = backend === 'claude' ? await runClaude(runtime, runtimePath, task, plan, directory, attempt) : await runToFiles(launch.command, launch.args, {
    cwd: task.worktree, env: { ...envFor({ ...runtime, path: environmentPath(task, runtime) }), PI_DELEGATE_RUNTIME: runtimePath, PI_DELEGATE_TASK: id,
      ...(attempt === undefined ? {} : { PI_DELEGATE_ATTEMPT: attempt }) },
  }, join(directory, 'report.md'), join(directory, 'worker.log'), true, undefined, true);
  const failure = backend === 'pi' ? await invalidToolFailure(directory) : undefined;
  const outcome = failure ? { ...result, workerCode: result.code, code: result.code || 1, ...failure } : result;
  let fingerprint, integrityError;
  try {
    fingerprint = await snapshot(task, runtime);
    if (initialFingerprint !== undefined && fingerprint !== initialFingerprint) integrityError = 'Read-only source changed during worker execution';
  } catch (error) { integrityError = error.message; }
  await save(join(directory, 'result.json'), { ...outcome, backend, elapsedMs: Math.round(performance.now() - start), fingerprint, integrityError,
    accepted: false });
  log(JSON.stringify({ task: id, attempt, workerExit: outcome.code, ...(failure ?? {}), integrityError, artifacts: directory, reviewRequired: true }));
  return integrityError || outcome.code === null ? 1 : outcome.code;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv[2], process.argv[3], process.argv[4]).then(code => { process.exitCode = code; }).catch(error => {
    console.error(timestampLine(`Worker did not complete: ${error.message}. Retain evidence; do not automatically retry.`)); process.exitCode = 1;
  });
}
