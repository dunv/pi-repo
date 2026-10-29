// Exact model identities with a strict harness policy: Anthropic -> Claude Code;
// local and OpenAI -> Pi. No alternate backend, fuzzy matching or paid fallback.
import { workerBackend, modelFamily } from './core.mjs';

function claudeEntry(runtime, model, name = model) {
  workerBackend({ backend: 'claude', model, thinking: 'high' });
  return { id: `claude-code/${model}`, name, backend: 'claude', model,
    provider: 'claude-code', canonicalId: `claude-code/${model}`,
    endpoint: 'Claude Code configured endpoint (not inspected)',
    authentication: { source: 'Claude Code HOME login', hostConfigured: null, workerVerified: false },
    configured: Boolean(runtime.claude), capabilities: { sourceTools: true, plannedChecks: true, input: ['text'],
      thinking: ['low', 'medium', 'high', 'xhigh', 'max'], contextWindow: null }, cost: null };
}
export function cliEntries(runtime) {
  const entries = runtime.catalogue ?? [];
  if (!Array.isArray(entries) || entries.length > 128) throw new Error('Invalid delegate catalogue');
  const ids = new Set();
  return entries.map(entry => {
    if (!entry || entry.backend !== 'claude' || entry.id !== `claude-code/${entry.model}`
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 160 || /[\x00-\x1f]/.test(entry.name)
      || ids.has(entry.id)) throw new Error('Invalid or duplicate Claude Code catalogue entry');
    ids.add(entry.id);
    return claudeEntry(runtime, entry.model, entry.name);
  });
}
function piModels(registry) {
  const models = registry.getAll?.() ?? [];
  if (models.some(model => model.provider === 'claude-code')) throw new Error('Pi provider claude-code conflicts with reserved catalogue namespace');
  return models;
}
function piEntry(model, registry) {
  let endpoint = 'Pi provider configuration';
  try { endpoint = new URL(model.baseUrl).origin; } catch { /* Never expose URL credentials/paths or headers. */ }
  return { id: `${model.provider}/${model.id}`, name: model.name ?? model.id, backend: 'pi', model: `${model.provider}/${model.id}`,
    provider: model.provider, endpoint,
    authentication: { source: 'Pi HOME/provider configuration; foreground environment is not forwarded',
      hostConfigured: typeof registry.hasConfiguredAuth === 'function' ? registry.hasConfiguredAuth(model) : null, workerVerified: false },
    configured: true, capabilities: { sourceTools: true, plannedChecks: true, input: model.input ?? ['text'],
      reasoning: model.reasoning ?? null, contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null, thinkingLevelMap: model.thinkingLevelMap ?? null }, cost: model.cost ?? null };
}
function registryEntry(runtime, model, registry) {
  const family = modelFamily(model.provider, model.id);
  if (family.backend === 'pi') return piEntry(model, registry);
  if (!family.native) return null; // Vendor-specific aliases are not guessed or run through Pi.
  return { ...claudeEntry(runtime, family.native, model.name ?? model.id),
    id: `${model.provider}/${model.id}`, provider: model.provider };
}
export function catalogue(runtime, registry, filter = {}) {
  const external = cliEntries(runtime);
  const entries = piModels(registry).map(model => registryEntry(runtime, model, registry)).filter(Boolean);
  entries.push(...external);
  return entries.filter(entry => (!filter.backend || entry.backend === filter.backend)
    && (!filter.provider || entry.provider === filter.provider)
    && (!filter.query || `${entry.id} ${entry.name}`.toLowerCase().includes(filter.query.toLowerCase())))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function resolveSelection(input, runtime, registry, _previous) {
  if (typeof input.model !== 'string' || !input.model) throw new Error('Exact catalogue or native model ID required');
  piModels(registry);
  const external = cliEntries(runtime);
  let selected = external.find(entry => entry.id === input.model);
  if (!selected && input.model.startsWith('claude-code/')) throw new Error('Unknown Claude Code catalogue entry; no inferred route or fallback');
  if (!selected && /^claude-[a-z0-9][a-z0-9.-]*$/.test(input.model)) {
    selected = external.find(entry => entry.model === input.model) ?? claudeEntry(runtime, input.model);
  }
  if (!selected) {
    // Exact registry lookup, including nested provider/model IDs. Anthropic
    // catalogue entries supply discovery only, never Pi auth/endpoint/pricing.
    if (!/^[a-z0-9-]+\/.+$/i.test(input.model) || /[\x00-\x20]/.test(input.model)) throw new Error('Use an explicit provider/model ID');
    const [provider, ...parts] = input.model.split('/'), id = parts.join('/');
    const model = registry.find(provider, id);
    if (!model) throw new Error('Exact model not found in the host model registry; no fallback');
    selected = registryEntry(runtime, { ...model, provider, id }, registry);
    if (!selected) throw new Error('Anthropic vendor alias has no exact Claude Code model mapping; select a native claude-* model. Pi is forbidden.');
  }
  if (input.backend && input.backend !== selected.backend) throw new Error(`Backend override conflicts with harness policy: ${selected.id} requires ${selected.backend}; no fallback`);
  workerBackend({ ...input, backend: selected.backend, model: selected.model }, runtime);
  return { ...input, backend: selected.backend, model: selected.model,
    route: structuredClone({ ...selected, selection: input.model, explicitBackend: input.backend ?? null }) };
}
