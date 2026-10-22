import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, linkedRoot, readSnapshot, parseStatus, display, editorArgs, shellQuote, fileTarget } from '../src/core.ts';

test('porcelain parses both columns, spaces, newlines, rename destination and source', () => {
  assert.deepEqual(parseStatus(' M a b\0R  new name\0old name\0?? new\nfile\0'), [
    { status: ' M', path: 'a b' }, { status: '??', path: 'new\nfile' },
    { status: 'R ', path: 'new name', from: 'old name' },
  ]);
});
test('editor arguments are parsed without shell evaluation', () => {
  assert.deepEqual(editorArgs('nvim -c "set number"'), ['nvim', '-c', 'set number']);
  assert.deepEqual(editorArgs("'/path with spaces/editor' --wait"), ['/path with spaces/editor', '--wait']);
  assert.throws(() => editorArgs('nvim "'));
  assert.throws(() => editorArgs(''));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(display('bad\x1b[2J\nfile'), 'bad\\x1b[2J\\x0afile');
  assert.throws(() => fileTarget('/tmp/root', '../evil'));
  assert.equal(fileTarget('/tmp/root', 'a b'), '/tmp/root/a b');
});
test('real Git: main hidden, linked worktree detected, clean/staged/unstaged/untracked/renames', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-worktree-unit-'));
  try {
    await git(base, ['init']);
    await git(base, ['config', 'user.email', 'test@example.invalid']);
    await git(base, ['config', 'user.name', 'Test']);
    await writeFile(join(base, 'tracked.txt'), 'original\n');
    await git(base, ['add', '.']);
    await git(base, ['commit', '-m', 'fixture']);
    assert.equal(await linkedRoot(base), undefined);
    const linked = join(base, 'linked');
    await git(base, ['worktree', 'add', '--detach', linked, 'HEAD']);
    assert.equal(await linkedRoot(linked), linked);
    assert.equal((await readSnapshot(linked)).files.length, 0);
    await writeFile(join(linked, 'tracked.txt'), 'changed\n');
    await writeFile(join(linked, 'untracked space.txt'), 'new\n');
    assert.deepEqual((await readSnapshot(linked)).files.map(f => f.status), [' M', '??']);
    await git(linked, ['add', 'tracked.txt']);
    assert.equal((await readSnapshot(linked)).files[0].status, 'M ');
    await git(linked, ['commit', '-m', 'updated fixture']);
    await git(linked, ['mv', 'tracked.txt', 'renamed.txt']);
    const renamed = (await readSnapshot(linked)).files.find(f => f.path === 'renamed.txt');
    assert.equal(renamed?.from, 'tracked.txt');
  } finally { await rm(base, { recursive: true, force: true }); }
});
