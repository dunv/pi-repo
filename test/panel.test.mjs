import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorktreePanel } from '../src/panel.ts';

const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
const layout = { truncate: (text, width) => text.length > width ? text.slice(0, width - 1) + '…' : text, measure: text => text.length };
const fixture = (count = 0) => ({ root: '/tmp/worktree', branch: 'feature/test', files: Array.from({ length: count }, (_, i) => ({ status: ' M', path: `file-${String(i).padStart(3, '0')}.txt` })) });

test('bounded bordered layout, cached output, update invalidation', () => {
  const panel = new WorktreePanel(fixture(3), false, theme, layout, () => 20);
  const lines = panel.render(44);
  assert.ok(lines.every(line => line.length === 44));
  assert.ok(lines.length <= 20);
  assert.equal(panel.render(44), lines);
  panel.update(fixture(), true);
  const clean = panel.render(30);
  assert.ok(clean.some(line => line.includes('[preview]')));
  assert.ok(clean.some(line => line.includes('Clean')));
  assert.ok(clean.every(line => line.length === 30));
});
test('long lists paginate and adapt to terminal height without losing access to files', () => {
  let rows = 14;
  const panel = new WorktreePanel(fixture(37), false, theme, layout, () => rows);
  assert.ok(panel.render(44).length <= rows);
  assert.ok(panel.render(44).some(line => line.includes('file-000')));
  panel.movePage(1);
  assert.ok(panel.render(44).some(line => line.includes('file-005')));
  panel.movePage(100);
  assert.ok(panel.render(44).some(line => line.includes('file-036')));
  rows = 10;
  assert.ok(panel.render(44).length <= rows);
  panel.movePage(-100);
  assert.ok(panel.render(44).some(line => line.includes('file-000')));
});
test('terminal controls in paths and branches are escaped', () => {
  const data = fixture(1);
  data.branch = 'bad\x1b[2J';
  data.files[0].path = 'name\nfile';
  const panel = new WorktreePanel(data, false, theme, layout, () => 20);
  const text = panel.render(44).join('\n');
  assert.ok(text.includes('\\x1b'));
  assert.ok(text.includes('name\\x0afile'));
  assert.ok(!text.includes('\x1b'));
});
test('interactive selection spans pages, survives refresh, and dispatches diff/editor actions', () => {
  const data = fixture(20);
  const calls = [];
  let rows = 14;
  const panel = new WorktreePanel(data, false, theme, layout, () => rows, {
    diff: (_root, file) => calls.push(['diff', file.path]),
    edit: (_root, file) => calls.push(['edit', file.path]),
    close: () => calls.push(['close']), render() {},
  });
  panel.handleInput('\r'); // Passive sidebar must not process input.
  assert.deepEqual(calls, []);
  panel.setActive(true);
  panel.render(64);
  for (let i = 0; i < 6; i++) panel.handleInput('j');
  assert.ok(panel.render(64).some(line => line.includes('›  M file-006')));
  const updated = { ...data, files: data.files.slice(2) };
  panel.update(updated, false);
  panel.handleInput('\r');
  panel.handleInput('e');
  assert.deepEqual(calls, [['diff', 'file-006.txt'], ['edit', 'file-006.txt']]);
  rows = 10;
  assert.ok(panel.render(64).length <= rows);
  panel.update(fixture(), false);
  panel.handleInput('\r');
  assert.equal(calls.length, 2);
  panel.handleInput('q');
  assert.deepEqual(calls.at(-1), ['close']);
});
