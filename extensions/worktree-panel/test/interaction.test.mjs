import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { git } from '../src/core.ts';
import worktreePanel from '../src/index.ts';

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, style: text => text, getColorMode: () => 'truecolor' };

test('existing commands focus the same panel; Enter opens diff and Esc restores panel/Pi focus', async () => {
  const base = await mkdtemp(join(tmpdir(), 'panel-interaction-'));
  const commands = new Map(), events = new Map(), shortcuts = new Map(), views = [];
  const notifications = [];
  let focus;
  worktreePanel({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool() {},
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
  });
  const ctx = { cwd: join(base, 'linked'), mode: 'tui', hasUI: true, ui: {
    notify: message => notifications.push(message),
    setWidget() {},
    select() { throw new Error('Must use existing panel, not a picker'); },
    custom(factory, options) {
      return new Promise(resolve => {
        const view = { options, component: undefined, focused: false };
        const previous = focus;
        view.component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, () => {
          focus = previous;
          resolve();
        });
        views.push(view);
        const handle = {
          focus() { focus = view; },
          unfocus() { if (focus === view) focus = undefined; },
          setHidden() {},
        };
        options.onHandle?.(handle);
        if (!options.overlayOptions.nonCapturing) focus = view;
      });
    },
  } };
  try {
    await git(base, ['init']);
    await git(base, ['config', 'user.email', 'test@example.invalid']);
    await git(base, ['config', 'user.name', 'Test']);
    await git(base, ['commit', '--allow-empty', '-m', 'fixture']);
    await git(base, ['branch', 'develop']);
    await git(base, ['worktree', 'add', '-b', 'feature', ctx.cwd]);
    await writeFile(join(ctx.cwd, 'committed.txt'), 'branch content\n');
    await git(ctx.cwd, ['add', 'committed.txt']);
    await git(ctx.cwd, ['commit', '-m', 'branch change']);
    await writeFile(join(ctx.cwd, 'new.txt'), 'new content\n');
    assert.deepEqual([...commands.keys()].sort(), ['worktree-branch', 'worktree-open', 'worktree-panel', 'worktree-preview', 'worktree-refresh']);
    assert.deepEqual([...shortcuts.keys()], ['alt+w']);
    await shortcuts.get('alt+w').handler(ctx);
    assert.equal(views.length, 1);
    const panel = views[0];
    assert.equal(focus, panel);
    assert.equal(panel.component.active, true);
    assert.equal(panel.options.overlayOptions.visible(80, 40), true);
    assert.equal(panel.options.overlayOptions.maxHeight, Math.floor(40 / 3));
    assert.equal(panel.options.overlayOptions.visible(80, 24), true);
    assert.equal(panel.options.overlayOptions.maxHeight, 8);
    assert.ok(panel.component.render(64).length <= 8);
    assert.equal(panel.options.overlayOptions.visible(80, 23), false);
    assert.equal(panel.options.overlayOptions.visible(80, 40), true);
    const lines = panel.component.render(64).join('\n');
    assert.match(lines, /Committed vs develop/);
    assert.match(lines, /Uncommitted/);
    panel.component.handleInput('\r');
    for (let i = 0; i < 100 && views.length < 2; i++) await setTimeout(10);
    assert.equal(views.length, 2);
    assert.deepEqual(views[1].options.overlayOptions, {
      anchor: 'center', width: '90%', maxHeight: '100%', margin: { top: 1, bottom: 1 },
    });
    assert.equal(views[1].component.render(80).length, 38); // 40 terminal rows minus popup margins.
    const committed = views[1].component.render(80).join('\n');
    assert.match(committed, /Committed vs develop/);
    assert.match(committed, /\+ branch content/);
    assert.doesNotMatch(committed, /new content/);
    views[1].component.handleInput('q');
    await setTimeout(0);
    assert.equal(focus, panel);
    panel.component.handleInput('\t');
    panel.component.handleInput('\r');
    for (let i = 0; i < 100 && views.length < 3; i++) await setTimeout(10);
    assert.equal(views.length, 3);
    assert.match(views[2].component.render(80).join('\n'), /\+ new content/);
    views[2].component.handleInput('q');
    await setTimeout(0);
    assert.equal(focus, panel);
    panel.component.handleInput('\x1bw'); // Alt+W is routed to the focused component.
    assert.equal(panel.component.active, false);
    assert.equal(focus, undefined);
    assert.equal(panel.options.overlayOptions.visible(80, 40), false);
    await commands.get('worktree-panel').handler('', ctx);
    assert.equal(focus, panel);
    assert.equal(views.length, 3); // Reuses the sidebar, not another picker/panel.
    await shortcuts.get('alt+w').handler(ctx);
    assert.equal(focus, undefined);
    assert.equal(panel.component.active, false);
    await shortcuts.get('alt+w').handler(ctx);
    assert.equal(focus, panel);
    await commands.get('worktree-panel').handler('hide', ctx);
    assert.equal(panel.component.active, false);
    assert.equal(focus, undefined);
    assert.deepEqual(notifications, []);
  } finally {
    events.get('session_shutdown')();
    await rm(base, { recursive: true, force: true });
  }
});
