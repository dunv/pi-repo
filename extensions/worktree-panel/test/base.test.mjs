import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readSnapshot, readBranchSnapshot, readDiff } from '../src/core.ts';
import { restorePanelTarget } from '../src/target.ts';
import worktreePanel from '../src/index.ts';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'panel-base-'));
  try {
    await git(root, ['init', '-b', 'develop']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'user.name', 'Test']);
    await writeFile(join(root, 'same.txt'), 'initial\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    await git(root, ['checkout', '-b', 'v3']);
    await writeFile(join(root, 'released.txt'), 'released\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'release']);
    await git(root, ['tag', '-a', 'release-tag', '-m', 'release']);
    await git(root, ['update-ref', 'refs/releases/v3', 'HEAD']);
    await git(root, ['checkout', '-b', 'feature']);
    await writeFile(join(root, 'same.txt'), 'feature\n');
    await git(root, ['commit', '-am', 'feature']);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function dirty(root) {
  await writeFile(join(root, 'same.txt'), 'staged\n');
  await git(root, ['add', 'same.txt']);
  await writeFile(join(root, 'same.txt'), 'unstaged\n');
  await writeFile(join(root, 'new.txt'), 'untracked\n');
}

test('explicit base affects only committed area in main and linked checkouts, with pinned diffs', async () => fixture(async root => {
  const tree = join(root, 'linked');
  await git(root, ['worktree', 'add', '--detach', tree, 'HEAD']);
  for (const checkout of [root, tree]) {
    await dirty(checkout);
    const before = await git(checkout, ['status', '--porcelain=v1']);
    const head = await git(checkout, ['rev-parse', 'HEAD']);
    const index = await git(checkout, ['write-tree']);
    const automatic = await readSnapshot(checkout);
    assert.deepEqual(automatic.committed.files.map(f => f.path), ['released.txt', 'same.txt']);
    const commit = (await git(root, ['rev-parse', 'refs/heads/v3'])).trim();
    for (const base of ['v3', 'release-tag', 'refs/releases/v3', commit]) {
      const data = await readSnapshot(checkout, base);
      assert.deepEqual(data.committed.files.map(f => f.path), ['same.txt']);
      assert.deepEqual(data.files, automatic.files);
      const diff = await readDiff(checkout, data.committed.files[0], data.committed.source);
      assert.match(diff, /\+feature/);
      assert.doesNotMatch(diff, /staged|unstaged|released/);
      const working = await readDiff(checkout, data.files.find(f => f.path === 'same.txt'));
      assert.match(working, /Staged/);
      assert.match(working, /Unstaged/);
      assert.match(working, /\+staged/);
      assert.match(working, /\+unstaged/);
      assert.match(await readDiff(checkout, data.files.find(f => f.path === 'new.txt')), /\+untracked/);
    }
    const readonly = await readBranchSnapshot(checkout, 'feature', 'v3');
    assert.equal(readonly.branchOnly, true);
    assert.deepEqual(readonly.files, []);
    assert.deepEqual(readonly.committed.files.map(f => f.path), ['same.txt']);
    assert.equal(await git(checkout, ['status', '--porcelain=v1']), before);
    assert.equal(await git(checkout, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(checkout, ['write-tree']), index);
  }
  // Advancing either ref never changes the diff selected from the old snapshot.
  const pinned = await readSnapshot(root, 'v3');
  await git(root, ['update-ref', 'refs/heads/v3', 'feature']);
  assert.equal((await readSnapshot(root, 'v3')).committed.files.length, 0);
  assert.match(await readDiff(root, pinned.committed.files[0], pinned.committed.source), /\+feature/);
  await git(root, ['branch', '-D', 'v3']);
  const unavailable = await readSnapshot(root, 'refs/heads/v3');
  assert.match(unavailable.committed.error, /Comparison base unavailable/);
  assert.deepEqual(unavailable.files, pinned.files);
  for (const base of ['missing', '--help', 'HEAD:same.txt']) {
    assert.match((await readSnapshot(root, base)).committed.error, /Comparison base unavailable/);
  }
  const unrelated = (await git(root, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated'])).trim();
  assert.match((await readSnapshot(root, unrelated)).committed.error, /no merge base/);
}));

function harness(root, history) {
  const tools = new Map(), commands = new Map(), events = new Map(), notices = [];
  const ctx = { cwd: root, mode: 'print', hasUI: false, sessionManager: { getBranch: () => history }, ui: { notify: message => notices.push(message) } };
  worktreePanel({
    registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c),
    registerShortcut() {}, on: (n, h) => events.set(n, h),
    appendEntry: (customType, data) => history.push({ type: 'custom', customType, data }),
  });
  events.get('session_start')({}, ctx);
  return {
    target: args => tools.get('worktree_panel_target').execute('test', args, undefined, undefined, ctx),
    base: arg => commands.get('worktree-base').handler(arg, ctx),
    stop: () => events.get('session_shutdown')(), notices,
  };
}

test('base tool/command validates before saving, persists independently, and resets to automatic', async () => fixture(async root => {
  const history = [];
  let h = harness(root, history);
  try {
    await h.base('v3'); // Main-checkout opt-in without a prior target.
    assert.deepEqual(restorePanelTarget(history), { path: root, base: 'refs/heads/v3' });
    const result = await h.target({ path: root, base: 'v3' });
    assert.equal(result.details.base, 'refs/heads/v3');
    assert.equal(result.details.branch, undefined);
    assert.deepEqual(restorePanelTarget(history), { path: root, base: 'refs/heads/v3' });
    const count = history.length;
    for (const base of ['missing', '--help', '', 'HEAD:same.txt']) {
      await assert.rejects(h.target({ path: root, base }));
    }
    await assert.rejects(h.target({ path: null, base: 'v3' }));
    assert.equal(history.length, count);
    h.stop();
    h = harness(root, history);
    await h.base('release-tag');
    assert.deepEqual(restorePanelTarget(history), { path: root, base: 'refs/tags/release-tag' });
    await h.base('missing');
    assert.match(h.notices.at(-1), /Cannot select comparison base/);
    assert.equal(restorePanelTarget(history).base, 'refs/tags/release-tag');
    await h.base('auto');
    assert.deepEqual(restorePanelTarget(history), { path: root });
    const tree = join(root, 'selected');
    await git(root, ['worktree', 'add', '--detach', tree, 'HEAD']);
    await h.target({ path: tree, base: 'v3' });
    h.stop();
    h = harness(root, history);
    await h.base('release-tag');
    assert.deepEqual(restorePanelTarget(history), { path: tree, base: 'refs/tags/release-tag' });
    await h.target({ path: root, branch: 'feature', base: 'v3' });
    h.stop();
    h = harness(root, history);
    await h.base('release-tag');
    assert.deepEqual(restorePanelTarget(history), { path: root, branch: 'refs/heads/feature', base: 'refs/tags/release-tag' });
    const pinned = await h.target({ path: root, base: 'HEAD~1' });
    assert.equal(pinned.details.base, (await git(root, ['rev-parse', 'HEAD~1'])).trim());
    await h.target({ path: root });
    assert.deepEqual(restorePanelTarget(history), { path: root });
    await h.target({ path: null });
    assert.equal(restorePanelTarget(history), undefined);
  } finally { h.stop(); }
}));
