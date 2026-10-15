import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { git } from '../src/core.ts';
import worktreePanel from '../src/index.ts';

const theme = { fg: (_color, text) => text, bg: (_color, text) => text };

test('existing commands focus the same panel; Enter opens diff and Esc restores panel/Pi focus', async () => {
  const base = await mkdtemp(join(tmpdir(), 'panel-interaction-'));
  const commands = new Map(), events = new Map(), views = [];
  const notifications = [];
  let focus;
  worktreePanel({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool() {},
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
    await git(base, ['worktree', 'add', '-b', 'feature', ctx.cwd]);
    await writeFile(join(ctx.cwd, 'new.txt'), 'new content\n');
    assert.deepEqual([...commands.keys()].sort(), ['worktree-open', 'worktree-panel', 'worktree-preview', 'worktree-refresh']);
    await commands.get('worktree-open').handler('', ctx);
    assert.equal(views.length, 1);
    const panel = views[0];
    assert.equal(focus, panel);
    assert.equal(panel.component.active, true);
    assert.equal(panel.options.overlayOptions.visible(80, 40), true);
    panel.component.render(64);
    panel.component.handleInput('\r');
    for (let i = 0; i < 100 && views.length < 2; i++) await setTimeout(10);
    assert.equal(views.length, 2);
    assert.match(views[1].component.render(80).join('\n'), /\+new content/);
    views[1].component.handleInput('q');
    await setTimeout(0);
    assert.equal(focus, panel);
    panel.component.handleInput('\x1b');
    assert.equal(panel.component.active, false);
    assert.equal(focus, undefined);
    assert.equal(panel.options.overlayOptions.visible(80, 40), false);
    await commands.get('worktree-panel').handler('', ctx);
    assert.equal(focus, panel);
    assert.equal(views.length, 2); // Reuses the sidebar, not another picker/panel.
    await commands.get('worktree-panel').handler('hide', ctx);
    assert.equal(panel.component.active, false);
    assert.equal(focus, undefined);
    assert.deepEqual(notifications, []);
  } finally {
    events.get('session_shutdown')();
    await rm(base, { recursive: true, force: true });
  }
});
