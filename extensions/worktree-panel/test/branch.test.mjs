import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, branchTarget, readBranchSnapshot, readDiff } from '../src/core.ts';
import { restorePanelTarget, TARGET_ENTRY } from '../src/target.ts';
import { WorktreePanel } from '../src/panel.ts';
import worktreePanel from '../src/index.ts';

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, style: t => t, getColorMode: () => 'truecolor' };
const layout = { truncate: (t, n) => t.slice(0, n), measure: t => t.length };

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'panel-branch-'));
  try {
    await git(root, ['init', '-b', 'master']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'user.name', 'Test']);
    await writeFile(join(root, 'file.txt'), 'base\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'base']);
    await git(root, ['checkout', '-b', 'feature/demo']);
    await writeFile(join(root, 'file.txt'), 'feature\n');
    await git(root, ['commit', '-am', 'feature']);
    await git(root, ['checkout', 'master']);
    await writeFile(join(root, 'dirty.txt'), 'untracked, must not appear\n');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('branch-only snapshots and pinned diffs require no worktree or checkout', async () => fixture(async root => {
  const before = await git(root, ['status', '--porcelain=v1']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  const data = await readBranchSnapshot(root, 'feature/demo');
  assert.equal(data.branchOnly, true);
  assert.equal(data.branch, 'feature/demo');
  assert.deepEqual(data.files, []);
  assert.deepEqual(data.committed.files.map(f => f.path), ['file.txt']);
  const file = data.committed.files[0];
  assert.match(await readDiff(root, file, data.committed.source), /\+feature/);
  // Moving the branch doesn't alter an already selected comparison.
  await git(root, ['update-ref', 'refs/heads/feature/demo', head.trim()]);
  assert.match(await readDiff(root, file, data.committed.source), /\+feature/);
  assert.equal((await readBranchSnapshot(root, 'feature/demo')).committed.files.length, 0);
  assert.equal(await git(root, ['status', '--porcelain=v1']), before);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
}));

test('branch targets accept local and remote refs, reject revisions and missing branches', async () => fixture(async root => {
  await git(root, ['update-ref', 'refs/remotes/origin/demo', 'refs/heads/feature/demo']);
  assert.equal((await branchTarget(root, 'origin/demo')).branch, 'refs/remotes/origin/demo');
  assert.equal((await branchTarget(root, 'refs/heads/feature/demo')).branch, 'refs/heads/feature/demo');
  for (const bad of ['missing', '--help', 'feature/demo~1', 'refs/tags/demo', 'feature/demo^{commit}']) {
    await assert.rejects(branchTarget(root, bad), /Branch unavailable/);
  }
}));

test('branch panel has only committed area, pagination and no editor action', async () => fixture(async root => {
  const data = await readBranchSnapshot(root, 'feature/demo');
  data.committed.files = Array.from({ length: 30 }, (_, i) => ({ status: 'M ', path: `${i}.txt` }));
  const diffs = [], edits = [];
  const panel = new WorktreePanel(data, true, theme, layout, () => 8, {
    diff: (...a) => diffs.push(a), edit: (...a) => edits.push(a), close() {}, render() {},
  });
  panel.setActive(true);
  let text = panel.render(100).join('\n');
  assert.match(text, /Branch \(read-only\)/);
  assert.doesNotMatch(text, /Uncommitted|e edit|dirty.txt/);
  panel.handleInput('e');
  assert.equal(edits.length, 0);
  panel.handleInput('\r');
  assert.equal(diffs.length, 1);
  panel.handleInput('\u001b[F'); // End
  text = panel.render(100).join('\n');
  assert.match(text, /29.txt/);
  assert.ok(panel.render(100).length <= 8);
}));

test('branch tool/command persistence, reset and unavailable-target handling', async () => fixture(async root => {
  const history = [], tools = new Map(), commands = new Map(), events = new Map(), notices = [], views = [];
  const ctx = { cwd: root, mode: 'tui', hasUI: true, sessionManager: { getBranch: () => history }, ui: {
    notify: message => notices.push(message), setWidget() {},
    custom(factory, options) { return new Promise(resolve => {
      views.push(factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve));
      options.onHandle?.({ focus() {}, unfocus() {}, setHidden() {} });
    }); },
  } };
  const load = () => worktreePanel({
    registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c),
    registerShortcut() {}, on: (n, h) => events.set(n, h),
    appendEntry: (customType, data) => history.push({ type: 'custom', customType, data }),
  });
  const target = args => tools.get('worktree_panel_target').execute('test', args, undefined, undefined, ctx);
  const open = () => commands.get('worktree-open').handler('', ctx);
  load();
  try {
    const result = await target({ path: root, branch: 'feature/demo' });
    assert.equal(result.details.branch, 'refs/heads/feature/demo');
    assert.deepEqual(restorePanelTarget(history), { path: root, branch: 'refs/heads/feature/demo' });
    await assert.rejects(target({ path: root, branch: 'missing' }));
    await assert.rejects(target({ path: null, branch: 'feature/demo' }));
    assert.equal(history.length, 1);
    await open();
    assert.match(views.at(-1).render(100).join('\n'), /file.txt/);
    events.get('session_shutdown')();
    load();
    events.get('session_start')({}, ctx);
    await open();
    assert.match(views.at(-1).render(100).join('\n'), /Branch \(read-only\)/);
    await git(root, ['branch', '-D', 'feature/demo']);
    const count = views.length;
    await open();
    assert.equal(views.length, count);
    assert.match(notices.at(-1), /Branch unavailable/);
    await commands.get('worktree-branch').handler('master', ctx);
    assert.equal(restorePanelTarget(history).branch, 'refs/heads/master');
    await commands.get('worktree-preview').handler('off', ctx);
    assert.equal(restorePanelTarget(history), undefined);
    assert.equal(history.at(-1).customType, TARGET_ENTRY);
    await commands.get('worktree-branch').handler('master', ctx);
    await target({ path: null });
    assert.equal(restorePanelTarget(history), undefined);
  } finally { events.get('session_shutdown')(); }
}));
