import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('root manifest exposes exactly two entries; Pi 1.3.0 Nix-style autodiscovery loads each once without starting resources', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.extensions, ['./extensions/worktree-panel/index.ts', './extensions/pueue/index.ts']);
  assert.equal(manifest.dependencies, undefined);
  for (const range of Object.values(manifest.peerDependencies)) assert.equal(range, '*');
  const temp = await mkdtemp(join(tmpdir(), 'pi-package-test-'));
  try {
    const agentDir = join(temp, 'agent'), cwd = join(temp, 'project');
    await mkdir(join(agentDir, 'extensions'), { recursive: true }); await mkdir(cwd);
    await symlink(root, join(agentDir, 'extensions', 'pi-repo'));
    const loaded = await discoverAndLoadExtensions([], cwd, agentDir);
    assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
    assert.equal(loaded.extensions.length, 2);
    const toolNames = loaded.extensions.flatMap(e => [...e.tools.keys()]);
    assert.deepEqual(toolNames.sort(), ['pueue_result', 'pueue_status', 'pueue_submit', 'worktree_panel_target']);
    assert.equal(new Set(toolNames).size, toolNames.length);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
