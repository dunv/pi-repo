// Caller assessments are diagnostic observations, never acceptance or authority.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ENTRY, attemptDirectory, json, privateDir, save } from './core.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const feedbackChoices = {
  reviewStatus: ['reviewed', 'partial', 'not_reviewed'],
  usefulness: ['useful', 'partly', 'not_useful', 'not_assessed'],
  correctness: ['good', 'issues', 'not_assessed'],
  instructionFollowing: ['good', 'issues', 'not_assessed'],
  reviewEffort: ['low', 'moderate', 'high', 'not_assessed'],
  wouldDelegateAgain: ['yes', 'no', 'unsure'],
};
export function validateFeedback(input) {
  if (!uuid.test(input.task) || typeof input.expectedNonce !== 'string' || !input.expectedNonce.length || input.expectedNonce.length > 200) throw new Error('Full task UUID and bounded job nonce required');
  if (input.supersedes !== undefined && !uuid.test(input.supersedes)) throw new Error('Full feedback UUID required');
  if (input.reviewedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.reviewedFingerprint)) throw new Error('Invalid reviewed fingerprint');
  const assessment = {};
  for (const [key, choices] of Object.entries(feedbackChoices)) {
    if (!choices.includes(input[key])) throw new Error(`Invalid feedback ${key}`);
    assessment[key] = input[key];
  }
  if (typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 4000) throw new Error('Bounded nonempty feedback rationale required');
  assessment.rationale = input.rationale;
  for (const key of ['problems', 'improvements', 'evidence']) {
    if (!Array.isArray(input[key]) || input[key].length > 12 || input[key].some(s => typeof s !== 'string' || !s.trim() || s.length > 1000)) throw new Error(`Invalid bounded feedback ${key}`);
    assessment[key] = [...input[key]];
  }
  return assessment;
}
export function feedbackTask(entries, who, input) {
  // Resolve the exact historical attempt on this branch, not just its latest task.
  const matches = entries.filter(e => e.type === 'custom' && e.customType === ENTRY && e.data?.id === input.task
    && e.data.nonce === input.expectedNonce && (e.data.custodian ?? e.data.owner)?.session === who.session
    && (e.data.custodian ?? e.data.owner)?.file === who.file);
  if (!matches.length) throw new Error('Task/job is not owned by this active session branch');
  return matches.at(-1).data;
}
export function feedbackRequest(task) {
  return { tool: 'delegate_feedback', task: task.id, expectedNonce: task.nonce,
    directory: join(task.directory, 'feedback'),
    instruction: 'After reviewing the full patch, every new file, relevant context and check evidence, report your verdict and call delegate_feedback with your own assessment, evidence, problems and improvements. Do not infer usefulness or correctness from exit zero. For incomplete/failed work use partial/not_reviewed and not_assessed where appropriate. Missing feedback means not assessed. Feedback never grants acceptance, publication or integration.' };
}
export async function writeFeedback(runtime, task, input, status, caller, guard = () => {}) {
  const assessment = validateFeedback(input);
  const reconciled = task.reconciliationId && status?.[0]?.phase === 'RECONCILED_EXITED'
    && status[0].reconciliationId === task.reconciliationId && status[0].backendAuthority === false;
  if (!Array.isArray(status) || status.length !== 1 || status[0].nonce !== task.nonce || (!reconciled && !['EXITED', 'KILLED'].includes(status[0].phase))) {
    throw new Error('Feedback requires a known terminal job; UNKNOWN/absent/active jobs cannot be assessed yet');
  }
  const root = join(runtime.state, task.id);
  if (task.directory !== root || task.id !== input.task || task.nonce !== input.expectedNonce) throw new Error('Feedback task identity mismatch');
  await privateDir(runtime.state); await privateDir(root);
  const manifest = await json(join(root, 'task.json'));
  if (manifest.id !== task.id || manifest.directory !== root || manifest.owner?.session !== task.owner.session || manifest.owner?.file !== task.owner.file) throw new Error('Feedback manifest identity mismatch');
  const directory = attemptDirectory(task, task.attempt);
  const plan = task.attempt === undefined ? manifest : await json(join(directory, 'attempt.json'));
  if (task.attempt !== undefined && (plan.task !== task.id || plan.attempt !== task.attempt)) throw new Error('Feedback revision identity mismatch');
  const submission = await json(join(directory, 'submission.json'));
  if (submission.nonce !== input.expectedNonce) throw new Error('Feedback submission identity mismatch');
  const feedbackDirectory = join(root, 'feedback');
  await privateDir(feedbackDirectory);
  if (input.supersedes !== undefined) {
    const previous = await json(join(feedbackDirectory, input.supersedes + '.json'));
    if (previous.task !== task.id || previous.nonce !== task.nonce || previous.attempt !== (task.attempt ?? null)) throw new Error('Correction must reference feedback for the same attempt');
  }
  const id = randomUUID(), record = {
    schemaVersion: 1, id, timestamp: new Date().toISOString(), task: task.id, attempt: task.attempt ?? null, nonce: task.nonce,
    supersedes: input.supersedes ?? null,
    caller: { session: caller.session, model: caller.model ?? null },
    invocation: { repo: manifest.repo, base: manifest.base, backend: plan.backend ?? 'pi', model: plan.model,
      thinking: plan.thinking, profile: manifest.profile, checks: manifest.checks },
    execution: { phase: status[0].phase, exitCode: status[0].exitCode ?? null, cancellationRequested: status[0].cancellationRequested === true,
      ...(reconciled ? { reconciliationId: task.reconciliationId, provenance: status[0].provenance, backendAuthority: false } : {}) },
    artifacts: { directory, brief: join(directory, 'brief.md'), result: join(directory, 'result.json'),
      metrics: join(directory, 'metrics.jsonl'), trackedPatch: join(directory, 'tracked.diff') },
    // Caller-supplied historical observation, not a fresh source verification.
    reviewedFingerprint: input.reviewedFingerprint ?? null, assessment,
    accepted: false,
  };
  guard();
  const path = join(feedbackDirectory, id + '.json');
  await save(path, record);
  return { id, path, task: task.id, attempt: record.attempt, recorded: true, accepted: false };
}
