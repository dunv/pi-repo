import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, readSnapshot, readDiff } from '../src/core.ts';
import { restoreTarget, TARGET_ENTRY } from '../src/target.ts';
import worktreePanel from '../src/index.ts';

const custom = path => ({ type: 'custom', customType: TARGET_ENTRY, data: { path } });
const result = (path, isError = false) => ({ type: 'message', message: {
  role: 'toolResult', toolName: 'worktree_panel_target', details: { path }, isError,
} });
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, style: text => text, getColorMode: () => 'truecolor' };

test('restore honors latest valid target/reset and supports successful legacy results only', () => {
  assert.equal(restoreTarget([result('/legacy')]), '/legacy');
  assert.equal(restoreTarget([result('/legacy'), custom('/new')]), '/new');
  assert.equal(restoreTarget([custom('/target'), result('/bad', true)]), '/target');
  assert.equal(restoreTarget([custom('/target'), custom('relative'), custom(17)]), '/target');
  assert.equal(restoreTarget([result('/legacy'), custom(null)]), undefined);
  assert.equal(restoreTarget([custom('/target'), result(null)]), undefined);
  assert.equal(restoreTarget([custom('/target'), { type: 'custom', customType: 'other', data: { path: '/other' } }]), '/target');
});

function harness(cwd, history) {
  const commands = new Map(), events = new Map(), tools = new Map();
  const views = [], notifications = [];
  const ctx = { cwd, mode: 'tui', hasUI: true, sessionManager: { getBranch: () => history }, ui: {
    notify: message => notifications.push(message), setWidget() {},
    custom(factory, options) {
      return new Promise(resolve => {
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve);
        views.push(component);
        options.onHandle?.({ focus() {}, unfocus() {}, setHidden() {} });
      });
    },
  } };
  worktreePanel({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool),
    registerShortcut() {},
    appendEntry: (customType, data) => history.push({ type: 'custom', customType, data }),
  });
  return {
    start: reason => events.get('session_start')({ reason }, ctx),
    tree: () => events.get('session_tree')({}, ctx),
    open: () => commands.get('worktree-open').handler('', ctx),
    preview: path => commands.get('worktree-preview').handler(path, ctx),
    target: path => tools.get('worktree_panel_target').execute('test', { path }, undefined, undefined, ctx),
    stop: () => events.get('session_shutdown')(),
    views, notifications,
  };
}

test('tool-selected worktree opens from main cwd and survives reload/resume, reset, old versions and tree navigation', async () => {
  const main = await mkdtemp(join(tmpdir(), 'panel-restore-'));
  const tree = join(main, 'linked');
  let h;
  try {
    await git(main, ['init']);
    await git(main, ['config', 'user.email', 'test@example.invalid']);
    await git(main, ['config', 'user.name', 'Test']);
    await git(main, ['commit', '--allow-empty', '-m', 'fixture']);
    await git(main, ['worktree', 'add', '-b', 'feature', tree]);
    await writeFile(join(tree, 'worktree-only.txt'), 'content\n');
    const history = [];
    h = harness(main, history);
    h.start('startup');
    await h.target(tree);
    await h.open();
    assert.match(h.views.at(-1).render(80).join('\n'), /worktree-only.txt/);
    assert.deepEqual(h.notifications, []);
    h.stop();
    for (const reason of ['reload', 'resume']) {
      h = harness(main, history);
      h.start(reason);
      await h.open();
      assert.match(h.views.at(-1).render(80).join('\n'), /worktree-only.txt/);
      assert.deepEqual(h.notifications, []);
      h.stop();
    }
    // Upgrade from the old extension: recover the original successful tool result.
    const legacy = [result(tree)];
    h = harness(main, legacy);
    h.start('reload');
    await h.open();
    assert.match(h.views.at(-1).render(80).join('\n'), /worktree-only.txt/);
    await h.target(null);
    h.stop();
    h = harness(main, legacy);
    h.start('reload');
    await h.open();
    assert.equal(h.views.length, 0);
    assert.match(h.notifications.at(-1), /No worktree target selected/);
    // A tree branch has its own state; no global target leaks between branches.
    legacy.splice(0, legacy.length, custom(tree));
    h.tree();
    await h.open();
    assert.match(h.views.at(-1).render(80).join('\n'), /worktree-only.txt/);
    legacy.splice(0, legacy.length);
    h.tree();
    await h.open();
    assert.match(h.notifications.at(-1), /No worktree target selected/);
    h.stop();
    // Deleted targets remain explicit errors, not silent fallback to another cwd.
    await git(main, ['worktree', 'remove', '--force', tree]);
    h = harness(main, [custom(tree)]);
    h.start('reload');
    await h.open();
    assert.match(h.notifications.at(-1), /Worktree target is unavailable/);
    assert.equal(h.views.length, 0);
  } finally {
    h?.stop();
    await rm(main, { recursive: true, force: true });
  }
});

test('explicit main checkout shows v3 working changes and survives restore without changing Git state', async () => {
  const main = await mkdtemp(join(tmpdir(), 'panel-main-'));
  let h;
  try {
    await git(main, ['init', '-b', 'master']);
    await git(main, ['config', 'user.email', 'test@example.invalid']);
    await git(main, ['config', 'user.name', 'Test']);
    await writeFile(join(main, 'file.txt'), 'base\n');
    await git(main, ['add', '.']);
    await git(main, ['commit', '-m', 'base']);
    await git(main, ['checkout', '-b', 'v3']);
    await writeFile(join(main, 'file.txt'), 'committed\n');
    await git(main, ['commit', '-am', 'v3 change']);
    await writeFile(join(main, 'file.txt'), 'staged\n');
    await git(main, ['add', 'file.txt']);
    await writeFile(join(main, 'file.txt'), 'unstaged\n');
    await writeFile(join(main, 'new.txt'), 'untracked\n');
    const before = await git(main, ['status', '--porcelain=v1']);
    const head = await git(main, ['rev-parse', 'HEAD']);
    const index = await git(main, ['write-tree']);
    const history = [];
    h = harness(main, history);
    h.start('startup');
    await h.open();
    assert.equal(h.views.length, 0); // Still opt-in for main checkouts.
    for (const select of [() => h.target(main), () => h.preview('.')]) {
      await select();
      assert.equal(restoreTarget(history), main);
      await h.open();
      const text = h.views.at(-1).render(100).join('\n');
      assert.match(text, /v3/);
      assert.match(text, /Committed vs master/);
      assert.match(text, /Uncommitted/);
      assert.match(text, /file.txt/);
      h.views.at(-1).handleInput('\u001b[F'); // End: reveal the last uncommitted file.
      assert.match(h.views.at(-1).render(100).join('\n'), /new.txt/);
      h.stop();
      h = harness(main, history);
      h.start('reload');
      await h.open();
      h.views.at(-1).handleInput('\u001b[F');
      assert.match(h.views.at(-1).render(100).join('\n'), /new.txt/);
    }
    const snapshot = await readSnapshot(main);
    const file = snapshot.files.find(f => f.path === 'file.txt');
    assert.equal(file.status, 'MM');
    const diff = await readDiff(main, file);
    assert.match(diff, /Staged/);
    assert.match(diff, /Unstaged/);
    assert.match(diff, /\+staged/);
    assert.match(diff, /\+unstaged/);
    const untracked = snapshot.files.find(f => f.path === 'new.txt');
    assert.match(await readDiff(main, untracked), /\+untracked/);
    await h.preview('off');
    await h.open();
    assert.equal(restoreTarget(history), undefined);
    assert.match(h.notifications.at(-1), /No worktree target selected/);
    assert.equal(await git(main, ['status', '--porcelain=v1']), before);
    assert.equal(await git(main, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(main, ['write-tree']), index);
  } finally {
    h?.stop();
    await rm(main, { recursive: true, force: true });
  }
});

test('manual preview and off share saved tool target state', async () => {
  const main = await mkdtemp(join(tmpdir(), 'panel-preview-'));
  let h;
  try {
    await git(main, ['init']);
    await git(main, ['config', 'user.email', 'test@example.invalid']);
    await git(main, ['config', 'user.name', 'Test']);
    await git(main, ['commit', '--allow-empty', '-m', 'fixture']);
    const tree = join(main, 'linked');
    await git(main, ['worktree', 'add', '-b', 'feature', tree]);
    const history = [];
    h = harness(main, history);
    h.start('startup');
    await h.preview(tree);
    assert.equal(restoreTarget(history), tree);
    await h.preview('off');
    assert.equal(restoreTarget(history), undefined);
  } finally {
    h?.stop();
    await rm(main, { recursive: true, force: true });
  }
});
