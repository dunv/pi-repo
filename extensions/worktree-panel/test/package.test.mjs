import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('Pi manifest exposes one source entry and no bundled runtime dependencies', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.name, 'pi-worktree-panel');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./src/index.ts']);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-tui'], '*');
  assert.ok(!manifest.files.some(path => /node_modules|test|\.git/.test(path)));
  for (const path of ['src/index.ts', 'src/core.ts', 'src/panel.ts', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    await access(new URL(path, root));
  }
});
