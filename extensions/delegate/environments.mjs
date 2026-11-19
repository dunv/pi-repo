// Portable operator contract. This version enforces agent tool capabilities,
// not an OS sandbox. Never accept stronger isolation labels we cannot enforce.
import { isAbsolute, resolve, relative } from 'node:path';
import { realpath } from 'node:fs/promises';

const name = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const absolute = value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value);
const shapes = {
  'source-review': { source: 'read-only', checks: false },
  implementation: { source: 'writable-worktree', checks: false },
  'implementation-checked': { source: 'writable-worktree', checks: true },
};
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
export function environments(runtime) {
  if (runtime.environmentProtocol === undefined && runtime.environments === undefined) return null; // Existing immutable runtimes only.
  if (runtime.environmentProtocol !== 1 || !keys(runtime.environments, Object.keys(shapes))) throw new Error('Environment contract v1 requires all three named environments');
  return Object.entries(shapes).map(([id, required]) => {
    const value = runtime.environments[id];
    if (!keys(value, ['capabilities', 'verificationProfiles', 'isolation', 'launcher', 'path'])
      || !keys(value.capabilities, ['source', 'checks'])
      || value.capabilities.source !== required.source || value.capabilities.checks !== required.checks
      || !Array.isArray(value.verificationProfiles) || value.verificationProfiles.some(p => !name(p) || !Object.hasOwn(runtime.profiles ?? {}, p))
      || new Set(value.verificationProfiles).size !== value.verificationProfiles.length
      || (required.checks ? !value.verificationProfiles.length : value.verificationProfiles.length > 0)
      || !keys(value.isolation, ['filesystem', 'network', 'credentials'])
      || value.isolation.filesystem !== 'tool-boundary' || value.isolation.network !== 'host'
      || value.isolation.credentials !== 'host-home'
      || !absolute(value.launcher) || typeof value.path !== 'string' || !value.path || value.path.split(':').some(p => !absolute(p))) {
      throw new Error(`Invalid environment ${id}: unsupported capabilities, isolation or launcher`);
    }
    return { interfaceVersion: 1, id, capabilities: { ...required }, verificationProfiles: [...value.verificationProfiles],
      isolation: { filesystem: 'tool-boundary', network: 'host', credentials: 'host-home' }, launcher: value.launcher, path: value.path };
  });
}
export function selectEnvironment(input, runtime) {
  const entries = environments(runtime);
  if (!entries) {
    if (input.environment !== undefined) throw new Error('Environment contract unavailable; no fallback');
    return undefined;
  }
  const selected = entries.find(entry => entry.id === input.environment);
  if (!selected) throw new Error('Select an explicit environment from delegate_environments; no default or fallback');
  if (!selected.capabilities.checks && (input.checks?.length || input.profile !== undefined)) throw new Error('This environment forbids checks and verification profiles');
  if (selected.capabilities.checks && !selected.verificationProfiles.includes(input.profile)) throw new Error('Verification profile is not approved for this environment');
  return selected;
}
export function assertTaskEnvironment(task, runtime) {
  const entries = environments(runtime);
  if (!task.execution && !entries) return; // Legacy workers keep their original runtime; no new guarantees.
  const current = entries?.find(entry => entry.id === task.environment);
  if (!current || JSON.stringify(current) !== JSON.stringify(task.execution)) throw new Error('Frozen environment missing or changed; no fallback or privilege upgrade');
  selectEnvironment(task, runtime);
}
export function workerTools(task) {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (!task.execution || task.execution.capabilities.source === 'writable-worktree') tools.push('edit', 'write');
  if (!task.execution || task.execution.capabilities.checks) tools.push('delegate_check');
  return tools;
}
export function assertTool(task, tool) {
  if (!workerTools(task).includes(tool)) throw new Error(`Environment forbids tool: ${tool}`);
}
export function environmentCommand(task, runtime, command, args) {
  assertTaskEnvironment(task, runtime);
  return task.execution ? { command: task.execution.launcher, args: [command, ...args] } : { command, args };
}
export function environmentPath(task, runtime) {
  return task.execution?.path ?? runtime.path;
}
export async function readable(task, path = '.') {
  if (typeof path !== 'string' || /\0/.test(path)) throw new Error('Invalid source path');
  const target = await realpath(resolve(task.worktree, path)), rel = relative(task.worktree, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Read outside worktree');
  return target;
}
export function environmentInstructions(task) {
  if (!task.execution) return '';
  return `\nSelected environment: ${task.environment}. Source access: ${task.execution.capabilities.source}; planned checks: ${task.execution.capabilities.checks ? 'allowed' : 'forbidden'}. Only these tools are available: ${workerTools(task).join(', ')}. Read source only within this workspace. If required guidance or tooling is unavailable, report a blocker. This is a tool boundary, NOT an OS sandbox: host network and HOME-based authentication remain accessible to trusted processes.\n`;
}
