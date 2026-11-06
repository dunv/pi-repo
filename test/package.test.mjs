import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('root manifest exposes exactly four entries; Pi 1.3.0 extension-directory autodiscovery loads each once without starting resources', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, ['./extensions/worktree-panel/index.ts', './extensions/pueue/index.ts', './extensions/repo-snapshot/index.ts', './extensions/delegate/index.ts']);
  assert.equal(manifest.dependencies, undefined);
  for (const range of Object.values(manifest.peerDependencies)) assert.equal(range, '*');
  const temp = await mkdtemp(join(tmpdir(), 'pi-package-test-'));
  try {
    const agentDir = join(temp, 'agent'), cwd = join(temp, 'project');
    await mkdir(join(agentDir, 'extensions'), { recursive: true }); await mkdir(cwd);
    await symlink(root, join(agentDir, 'extensions', 'pi-repo'));
    const loaded = await discoverAndLoadExtensions([], cwd, agentDir);
    assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
    assert.equal(loaded.extensions.length, 4);
    const toolNames = loaded.extensions.flatMap(e => [...e.tools.keys()]);
    assert.deepEqual(toolNames.sort(), ['delegate_feedback', 'delegate_finalize', 'delegate_models', 'delegate_resume', 'delegate_review', 'delegate_revise', 'delegate_task', 'pueue_cancel', 'pueue_result', 'pueue_status', 'pueue_submit', 'repo_snapshot', 'worktree_panel_target']);
    assert.equal(new Set(toolNames).size, toolNames.length);

    // Bound model-facing prose, including repeated parameter descriptions.
    // Character budgets are deterministic; actual token counts depend on the model.
    const tools = new Map(loaded.extensions.flatMap(e => [...e.tools].map(([name, tool]) => [name, tool.definition])));
    let descriptionCharacters = 0;
    const countDescriptions = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'description' && typeof child === 'string') descriptionCharacters += child.length;
        else countDescriptions(child);
      }
    };
    for (const tool of tools.values()) {
      assert.ok(tool.description.length <= 1600, `${tool.name}: keep descriptions concise`);
      countDescriptions({ description: tool.description, parameters: tool.parameters });
    }
    assert.ok(descriptionCharacters <= 9000, `model-facing description budget exceeded: ${descriptionCharacters}`);
    assert.match(tools.get('delegate_task').description, /NOT an OS sandbox/);
    assert.match(tools.get('delegate_review').description, /main agent must review the entire trackedPatch, every untracked file/);
    assert.match(tools.get('delegate_review').description, /current checks.*delegate_feedback/);
    assert.match(tools.get('delegate_resume').description, /fresh interactive user confirmation/);
    assert.match(tools.get('delegate_resume').description, /cgroup-v2 proof.*descendants stopped/);
    assert.match(tools.get('delegate_finalize').description, /fresh interactive user confirmation/);
    assert.match(tools.get('delegate_finalize').description, /EVERY attempt/);
    assert.match(tools.get('pueue_submit').description, /NEVER include secrets/);
    assert.match(tools.get('pueue_status').description, /UNKNOWN\/absence never authorizes retry\/takeover/);
    assert.match(tools.get('pueue_cancel').description, /explicit user confirmation/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
