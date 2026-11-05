// Operator-scoped Pi admission policy, not a model router or readiness claim.
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function parsePiModelPolicy(runtime) {
  if (runtime?.piModelPolicy === undefined) return new Map(); // Legacy runtimes unchanged.
  const configured = runtime.piModelPolicy;
  if (!object(configured) || Object.keys(configured).length > 64) throw new Error('Invalid Pi delegate model policy');
  const result = new Map();
  for (const [provider, models] of Object.entries(configured)) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(provider) || !object(models) || Object.keys(models).length > 128)
      throw new Error('Invalid Pi delegate model policy');
    const allowed = new Map();
    for (const [id, thinking] of Object.entries(models)) {
      if (!id || id.length > 512 || /[\s\x00-\x1f\x7f]/.test(id) || !Array.isArray(thinking)
        || !thinking.length || thinking.length > levels.size || new Set(thinking).size !== thinking.length
        || thinking.some(level => !levels.has(level))) throw new Error('Invalid Pi delegate model policy');
      allowed.set(id, [...thinking]);
    }
    result.set(provider, allowed);
  }
  return result;
}

// Omitted provider: unrestricted. Configured empty map: disabled. An allowed
// model has explicit thinking levels; no aliases, clamping or fallback here.
export function allowedPiThinking(policy, provider, id) {
  const key = provider.toLowerCase();
  if (!policy.has(key)) return undefined;
  return policy.get(key).get(id) ?? null;
}
export function assertPiModelAllowed(policy, provider, id, thinking) {
  const allowed = allowedPiThinking(policy, provider, id);
  if (allowed === null) throw new Error('Pi model excluded by delegate model policy; choose an allowed route explicitly, no fallback');
  if (allowed && !allowed.includes(thinking)) throw new Error(`Thinking level excluded by delegate model policy; allowed: ${allowed.join(', ')}`);
}
