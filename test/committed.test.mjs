import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readSnapshot, readDiff, parseNameStatus } from '../src/core.ts';

async function fixture(run) {
  const base = await mkdtemp(join(tmpdir(), 'panel-committed-'));
  try {
    await git(base, ['init', '-b', 'develop']);
    await git(base, ['config', 'user.email', 'test@example.invalid']);
    await git(base, ['config', 'user.name', 'Test']);
    await writeFile(join(base, 'same.txt'), 'original\n');
    await git(base, ['add', '.']);
    await git(base, ['commit', '-m', 'base']);
    const tree = join(base, 'linked');
    await git(base, ['worktree', 'add', '-b', 'feature', tree]);
    await run(base, tree);
  } finally { await rm(base, { recursive: true, force: true }); }
}

test('name-status parser handles renames, copies and control characters without splitting paths', () => {
  assert.deepEqual(parseNameStatus('M\0space name\0R100\0old\nname\0new\nname\0C075\0source\0copy\0'), [
    { status: 'C ', path: 'copy', from: 'source' },
    { status: 'R ', path: 'new\nname', from: 'old\nname' },
    { status: 'M ', path: 'space name' },
  ]);
  assert.throws(() => parseNameStatus('R100\0old\0'), /destination/);
});

test('committed comparison uses merge base, excludes develop-only and worktree edits, even for the same file', async () => {
  await fixture(async (base, tree) => {
    await writeFile(join(tree, 'same.txt'), 'committed feature\n');
    await git(tree, ['add', '.']);
    await git(tree, ['commit', '-m', 'feature commit']);
    // Develop advances independently: its changes must not appear as feature deletions.
    await writeFile(join(base, 'develop-only.txt'), 'upstream\n');
    await git(base, ['add', 'develop-only.txt']);
    await git(base, ['commit', '-m', 'develop advance']);
    await writeFile(join(tree, 'same.txt'), 'staged feature\n');
    await git(tree, ['add', 'same.txt']);
    await writeFile(join(tree, 'same.txt'), 'unstaged feature\n');
    await writeFile(join(tree, 'new.txt'), 'untracked\n');
    const snapshot = await readSnapshot(tree);
    assert.equal(snapshot.committed.ref, 'develop');
    assert.deepEqual(snapshot.committed.files, [{ status: 'M ', path: 'same.txt' }]);
    assert.equal(snapshot.files.find(file => file.path === 'same.txt').status, 'MM');
    const committed = await readDiff(tree, snapshot.committed.files[0], snapshot.committed.source);
    assert.match(committed, /Committed vs develop/);
    assert.match(committed, /-original/);
    assert.match(committed, /\+committed feature/);
    assert.doesNotMatch(committed, /staged feature|develop-only/);
    const uncommitted = await readDiff(tree, snapshot.files.find(file => file.path === 'same.txt'));
    assert.match(uncommitted, /-committed feature/);
    assert.match(uncommitted, /\+staged feature/);
    assert.match(uncommitted, /\+unstaged feature/);
    assert.doesNotMatch(uncommitted, /-original/);
    // A clean worktree still has committed branch changes.
    await git(tree, ['reset', '--hard', 'HEAD']);
    await rm(join(tree, 'new.txt'));
    const clean = await readSnapshot(tree);
    assert.equal(clean.files.length, 0);
    assert.equal(clean.committed.files.length, 1);
  });
});

test('comparison supports committed renames/deletions and remains pinned to the displayed HEAD', async () => {
  await fixture(async (_base, tree) => {
    await git(tree, ['mv', 'same.txt', 'renamed.txt']);
    await git(tree, ['commit', '-m', 'rename']);
    const snapshot = await readSnapshot(tree);
    assert.equal(snapshot.committed.files[0].from, 'same.txt');
    assert.match(await readDiff(tree, snapshot.committed.files[0], snapshot.committed.source), /rename from same.txt/);
    await git(tree, ['rm', 'renamed.txt']);
    await git(tree, ['commit', '-m', 'delete']);
    assert.match(await readDiff(tree, snapshot.committed.files[0], snapshot.committed.source), /rename from same.txt/);
    const deleted = await readSnapshot(tree);
    assert.deepEqual(deleted.committed.files, [{ status: 'D ', path: 'same.txt' }]);
    assert.match(await readDiff(tree, deleted.committed.files[0], deleted.committed.source), /-original/);
  });
});

test('origin/develop fallback and missing/unrelated develop leave worktree changes available', async () => {
  await fixture(async (base, tree) => {
    await git(base, ['update-ref', 'refs/remotes/origin/develop', 'develop']);
    // Rename the currently checked out develop; linked feature stays valid.
    await git(base, ['branch', '-m', 'develop', 'main']);
    assert.equal((await readSnapshot(tree)).committed.ref, 'origin/develop');
    await git(base, ['update-ref', '-d', 'refs/remotes/origin/develop']);
    await writeFile(join(tree, 'new.txt'), 'new\n');
    const missing = await readSnapshot(tree);
    assert.match(missing.committed.error, /No develop/);
    assert.equal(missing.files[0].path, 'new.txt');
    await git(base, ['checkout', '--orphan', 'develop']);
    await git(base, ['commit', '-m', 'unrelated root']);
    assert.match((await readSnapshot(tree)).committed.error, /no merge base/);
  });
});
