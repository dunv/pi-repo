import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import worktreePanel from '../src/index.ts';

function harness(cwd) {
  const tools = new Map();
  const events = new Map();
  worktreePanel({
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name, handler) => events.set(name, handler),
  });
  const ctx = { cwd, mode: 'print', hasUI: false };
  return {
    call: path => tools.get('worktree_panel_target').execute('test', { path }, undefined, undefined, ctx),
    stop: () => events.get('session_shutdown')(),
  };
}

test('panel target validates linked worktrees, normalizes subdirs and clears without changing cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'panel-target-'));
  const main = join(base, 'main');
  const tree = join(base, 'tree');
  await mkdir(main);
  const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'pipe' });
  git('init');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  git('worktree', 'add', '-b', 'feature/test', tree);
  await mkdir(join(tree, 'sub'));
  const before = process.cwd();
  const h = harness(main);
  try {
    const result = await h.call(join(tree, 'sub'));
    assert.deepEqual(result.details, { path: tree, cwdChanged: false, panelAvailable: false });
    for (const invalid of ['relative/path', main, join(base, 'missing')]) {
      await assert.rejects(h.call(invalid), /absolute|linked Git worktree/);
    }
    assert.equal(process.cwd(), before);
    const cleared = await h.call(null);
    assert.equal(cleared.details.path, null);
    assert.equal(cleared.details.cwdChanged, false);
  } finally {
    h.stop();
    await rm(base, { recursive: true, force: true });
  }
});
