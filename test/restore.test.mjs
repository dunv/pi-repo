import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/core.ts';
import { restoreTarget, TARGET_ENTRY } from '../src/target.ts';
import worktreePanel from '../src/index.ts';

const custom = path => ({ type: 'custom', customType: TARGET_ENTRY, data: { path } });
const result = (path, isError = false) => ({ type: 'message', message: {
  role: 'toolResult', toolName: 'worktree_panel_target', details: { path }, isError,
} });
const theme = { fg: (_color, text) => text, bg: (_color, text) => text };

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
