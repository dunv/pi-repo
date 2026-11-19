// Operator contracts: v1 tool boundaries; opt-in v2 separate OS-isolated purposes.
import { isAbsolute, resolve, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import { seal } from './prepared.mjs';

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
  if (runtime.environmentProtocol === undefined && runtime.environments === undefined) return null;
  const version = runtime.environmentProtocol;
  if (![1, 2].includes(version) || !keys(runtime.environments, Object.keys(shapes))) throw new Error('Environment contract requires a supported version and all three named environments');
  return Object.entries(shapes).map(([id, required]) => {
    const value = runtime.environments[id];
    const fields = ['capabilities', 'verificationProfiles', 'isolation', 'launcher', 'path', ...(version === 2 ? ['checkLauncher', 'policy', 'routes'] : [])];
    if (!keys(value, fields) || !keys(value.capabilities, ['source', 'checks'])
      || value.capabilities.source !== required.source || value.capabilities.checks !== required.checks
      || !Array.isArray(value.verificationProfiles) || value.verificationProfiles.some(p => !name(p) || !Object.hasOwn(runtime.profiles ?? {}, p))
      || new Set(value.verificationProfiles).size !== value.verificationProfiles.length
      || (required.checks ? !value.verificationProfiles.length : value.verificationProfiles.length > 0)
      || !keys(value.isolation, ['filesystem', 'network', 'credentials'])
      || !absolute(value.launcher) || typeof value.path !== 'string' || !value.path || value.path.split(':').some(p => !absolute(p))) {
      throw new Error(`Invalid environment ${id}: unsupported capabilities, isolation or launcher`);
    }
    const isolation = version === 1
      ? { filesystem: 'tool-boundary', network: 'host', credentials: 'host-home' }
      : { filesystem: 'operator-allowlist', network: 'worker-host/check-none', credentials: 'access-lease-or-none' };
    if (Object.entries(isolation).some(([key, expected]) => value.isolation[key] !== expected)) throw new Error(`Invalid environment ${id}: unsupported isolation guarantee`);
    let extra = {};
    if (version === 2) {
      if ((required.checks ? !absolute(value.checkLauncher) : value.checkLauncher !== null)
        || !keys(value.routes, ['pi', 'claude']) || !['pi', 'claude'].every(backend => Array.isArray(value.routes[backend])
          && value.routes[backend].length <= 64 && new Set(value.routes[backend]).size === value.routes[backend].length
          && value.routes[backend].every(route => typeof route === 'string' && !/[\x00-\x20]/.test(route)
            && (backend === 'pi' ? /^[a-z0-9-]+\/.+$/i.test(route) : /^claude-[a-z0-9][a-z0-9.-]*$/.test(route))))
        || !value.routes.pi.length && !value.routes.claude.length
        || required.checks && value.verificationProfiles.some(p => !runtime.profiles[p]?.prepared)) throw new Error(`Invalid environment ${id}: v2 requires explicit routes, launchers and prepared profiles`);
      extra = { checkLauncher: value.checkLauncher, policy: seal(value.policy), routes: { pi: [...value.routes.pi], claude: [...value.routes.claude] } };
    }
    return { interfaceVersion: version, id, capabilities: { ...required }, verificationProfiles: [...value.verificationProfiles],
      isolation, launcher: value.launcher, path: value.path, ...extra };
  });
}
export function validateEnvironmentRoute(input, execution) {
  if (execution?.interfaceVersion !== 2) return;
  const backend = input.backend ?? 'pi';
  if (!execution.routes[backend]?.includes(input.model)) throw new Error('Model/auth route is unsupported by the selected sandbox; no credential or provider fallback');
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
  if (selected.interfaceVersion === 2 && selected.capabilities.checks && !input.checks?.length) throw new Error('V2 checked environments require a nonempty prepared check plan');
  validateEnvironmentRoute(input, selected);
  return selected;
}
export function assertTaskEnvironment(task, runtime) {
  const entries = environments(runtime);
  if (!task.execution && !entries) return;
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
export function environmentCommand(task, runtime, command, args, context = {}) {
  assertTaskEnvironment(task, runtime);
  if (task.execution?.interfaceVersion === 2) {
    if (!absolute(command) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !['worker', 'check'].includes(context.purpose) || !absolute(context.runtimePath)
      || context.attempt !== undefined && !/^[a-f0-9-]{36}$/.test(context.attempt)
      || context.purpose === 'check' && (!task.execution.capabilities.checks || !Number.isInteger(context.index) || context.index < 0 || context.index > 7)) throw new Error('Explicit sandbox launch purpose and context are required');
    return { command: context.purpose === 'worker' ? task.execution.launcher : task.execution.checkLauncher,
      args: ['2', context.purpose, context.runtimePath, task.id, context.attempt ?? '-', context.purpose === 'check' ? String(context.index) : '-', command, ...args] };
  }
  return task.execution ? { command: task.execution.launcher, args: [command, ...args] } : { command, args };
}
export function environmentPath(task, runtime) { return task.execution?.path ?? runtime.path; }
export async function readable(task, path = '.') {
  if (typeof path !== 'string' || /\0/.test(path)) throw new Error('Invalid source path');
  const target = await realpath(resolve(task.worktree, path)), rel = relative(task.worktree, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Read outside worktree');
  return target;
}
export function environmentInstructions(task) {
  if (!task.execution) return '';
  const boundary = task.execution.interfaceVersion === 2
    ? 'OS filesystem allowlisting is operator-enforced. Model networking remains host-wide; checks have no network or credentials. Access leases cannot refresh inside workers; report expiration as a blocker.'
    : 'This is a tool boundary, NOT an OS sandbox: host network and HOME-based authentication remain accessible to trusted processes.';
  return `\nSelected environment: ${task.environment}. Source access: ${task.execution.capabilities.source}; planned checks: ${task.execution.capabilities.checks ? 'allowed' : 'forbidden'}. Only these tools are available: ${workerTools(task).join(', ')}. Read source only within this workspace. If required guidance or tooling is unavailable, report a blocker. ${boundary}\n`;
}
