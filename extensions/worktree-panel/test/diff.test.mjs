import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readSnapshot, readDiff } from '../src/core.ts';
import { DiffViewer } from '../src/diff.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, style: text => text, getColorMode: () => 'truecolor' };

test('diffs include staged and unstaged content, literal paths, renames, deletions and untracked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-diff-'));
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'user.name', 'Test']);
    const name = 'file[1].txt';
    await writeFile(join(root, name), 'original\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'fixture']);
    await writeFile(join(root, name), 'staged\n');
    await git(root, ['add', '.']);
    await writeFile(join(root, name), 'unstaged\n');
    const patch = await readDiff(root, (await readSnapshot(root)).files[0]);
    assert.match(patch, /Staged\n/);
    assert.match(patch, /Unstaged\n/);
    assert.match(patch, /\+staged/);
    assert.match(patch, /\+unstaged/);
    await git(root, ['reset', '--hard', 'HEAD']);
    await git(root, ['mv', name, 'renamed']);
    assert.match(await readDiff(root, (await readSnapshot(root)).files[0]), /rename from/);
    await git(root, ['reset', '--hard', 'HEAD']);
    await rm(join(root, name));
    assert.match(await readDiff(root, (await readSnapshot(root)).files[0]), /-original/);
    await writeFile(join(root, '-new\nfile'), 'new content\n');
    assert.match(await readDiff(root, { status: '??', path: '-new\nfile' }), /\+new content/);
    await writeFile(join(root, 'empty'), '');
    assert.match(await readDiff(root, { status: '??', path: 'empty' }), /Untracked/);
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
    assert.match(await readDiff(root, { status: '??', path: 'binary' }), /Binary files/);
    await assert.rejects(readDiff(root, { status: '??', path: '../outside' }), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('viewer wraps wide content, bounds scrolling, resizes and escapes terminal controls', () => {
  let rows = 12, renders = 0, closed = 0;
  const viewer = new DiffViewer('bad\x1btitle', Array.from({ length: 40 }, (_, i) => `+${i} 界`.repeat(10)).join('\n') + '\n+bad\x1b[2J',
    theme, () => rows, () => renders++, () => closed++);
  for (const width of [64, 30, 15]) {
    const lines = viewer.render(width);
    assert.ok(lines.length <= rows);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(!lines.join('').includes('\x1b[2J'));
    assert.ok(!lines.join('').includes('\x1btitle'));
  }
  viewer.handleInput('G');
  assert.match(viewer.render(64).join('\n'), /\\x1b/);
  rows = 8;
  assert.ok(viewer.render(30).length <= rows);
  viewer.handleInput('g');
  assert.match(viewer.render(64).join('\n'), /\+0/);
  viewer.handleInput('j');
  assert.ok(renders > 0);
  viewer.handleInput('q');
  assert.equal(closed, 1);
});
