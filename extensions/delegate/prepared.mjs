// Versioned, data-only preparation seals. Never evaluate source flakes or run setup.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f]/.test(value);
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
export function seal(value) {
  if (!exact(value, ['path', 'sha256']) || !absolute(value.path) || !hash(value.sha256)) throw new Error('An explicit absolute preparation/policy seal and SHA256 are required');
  return { path: value.path, sha256: value.sha256 };
}
async function bytes(path, limit) {
  if (await realpath(path) !== path) throw new Error('Sealed inputs must use canonical paths, not symlinks');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    // Host-root store files can have overflow UID 65534 in an unprivileged
    // user namespace. Canonical store paths + non-writable mode + exact digest
    // protect sealed data; mutable non-store inputs still require trusted UID.
    if (!before.isFile() || before.size > limit || before.mode & 0o022
      || !path.startsWith('/nix/store/') && ![0, process.getuid()].includes(before.uid)) throw new Error('Unsafe or oversized sealed input');
    const data = Buffer.alloc(before.size + 1), result = await fd.read(data, 0, data.length, 0), after = await fd.stat();
    if (result.bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Sealed input changed during read');
    return data.subarray(0, result.bytesRead);
  } finally { await fd.close(); }
}
export async function sealedJSON(descriptor) {
  const expected = seal(descriptor), data = await bytes(expected.path, 1024 * 1024);
  if (createHash('sha256').update(data).digest('hex') !== expected.sha256) throw new Error('Sealed input changed; explicit re-approval required');
  return JSON.parse(data.toString('utf8'));
}
export async function validatePolicy(execution) {
  if (execution?.interfaceVersion !== 2) return;
  const policy = await sealedJSON(execution.policy);
  if (!exact(policy, ['version', 'operator', 'settings']) || policy.version !== 1 || typeof policy.operator !== 'string'
    || !policy.operator || !policy.settings || typeof policy.settings !== 'object' || Array.isArray(policy.settings)) throw new Error('Invalid operator policy document');
  return policy;
}
export function preparedShape(value) {
  if (!exact(value, ['version', 'repository', 'policySha256', 'sourceInputs', 'checks', 'operator']) || value.version !== 1 || !absolute(value.repository) || !hash(value.policySha256)
    || !Array.isArray(value.sourceInputs) || !value.sourceInputs.length || value.sourceInputs.length > 512
    || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 8
    || !value.operator || typeof value.operator !== 'object' || Array.isArray(value.operator)) throw new Error('Invalid prepared-check manifest');
  const paths = new Set();
  for (const input of value.sourceInputs) {
    if (!exact(input, ['path', 'sha256']) || typeof input.path !== 'string' || !input.path || input.path.length > 4096
      || /[\\\x00-\x1f]/.test(input.path) || isAbsolute(input.path) || input.path.split('/').some(p => !p || ['.', '..', '.git'].includes(p))
      || paths.has(input.path) || !hash(input.sha256)) throw new Error('Invalid or duplicate protected preparation source input');
    paths.add(input.path);
  }
  for (const check of value.checks) {
    if (!exact(check, ['kind', 'targets']) || !['test', 'build'].includes(check.kind) || !Array.isArray(check.targets)
      || !check.targets.length || check.targets.length > 32 || new Set(check.targets).size !== check.targets.length
      || check.targets.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_/.:+@=][a-zA-Z0-9_/.:+@=-]{0,1023}$/.test(t))) throw new Error('Invalid prepared check targets');
  }
  return value;
}
export async function validatePrepared(task, source, verification) {
  if (task.execution?.interfaceVersion !== 2 || !task.execution.capabilities.checks) return;
  if (!verification?.prepared) throw new Error('Sandboxed checks require a pre-approved prepared-check manifest; no implicit provisioning');
  const manifest = preparedShape(await sealedJSON(verification.prepared));
  // The original main checkout is intentionally absent inside worker namespaces.
  // Its canonical identity was bound by the orchestrator; compare the frozen value.
  if (manifest.repository !== task.repository.main) throw new Error('Prepared check belongs to a different canonical repository');
  if (manifest.policySha256 !== task.execution.policy.sha256) throw new Error('Prepared check belongs to a different operator policy; re-approve explicitly');
  if (!task.checks.every(check => manifest.checks.some(allowed => allowed.kind === check.kind && JSON.stringify(allowed.targets) === JSON.stringify(check.targets)))) throw new Error('Check plan is not approved by the prepared manifest');
  for (const input of manifest.sourceInputs) {
    const path = join(source, input.path);
    if (await realpath(path) !== path) throw new Error('Protected preparation input follows a symlink');
    const data = await bytes(path, 64 * 1024 * 1024);
    if (createHash('sha256').update(data).digest('hex') !== input.sha256) throw new Error(`Preparation input changed: ${input.path}; re-prepare explicitly outside the worker`);
  }
  return manifest;
}
