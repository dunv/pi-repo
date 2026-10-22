import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { styleText, visibleWidth } from '@earendil-works/pi-tui';
import { formatDiff } from '../src/diff-format.ts';
import { DiffViewer } from '../src/diff.ts';
import { WorktreePanel } from '../src/panel.ts';
import { darkSurface, readableSyntax } from '../src/surface.ts';

const theme = mode => ({ getColorMode: () => mode, style: (text, options) => styleText(text, options, mode) });
const patch = `Staged
diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -10,4 +10,4 @@
 /* comment
-old comment
+new comment
  */
-const oldValue = 1;
+const newValue = 2;
`;

test('hunk highlighting reconstructs old/new source separately and keeps line numbers and metadata intact', () => {
  const calls = [];
  const rows = formatDiff(patch, 'example.ts', theme('truecolor'), (code, language) => {
    calls.push({ code, language });
    return code.split('\n').map(line => `\x1b[38;2;100;200;255m${line}\x1b[39m`);
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.language === 'typescript'));
  assert.match(calls[0].code, /old comment/);
  assert.doesNotMatch(calls[0].code, /new comment/);
  assert.match(calls[1].code, /new comment/);
  assert.doesNotMatch(calls[1].code, /old comment/);
  const removed = rows.find(row => row.kind === 'removed');
  const added = rows.find(row => row.kind === 'added');
  assert.equal(removed.old, 11);
  assert.equal(removed.next, undefined);
  assert.equal(added.old, undefined);
  assert.equal(added.next, 11);
  assert.equal(stripVTControlCharacters(added.text), 'new comment');
  assert.equal(rows.find(row => row.text === '+++ b/example.ts').kind, 'meta');
});

test('Nix files use the host Nix highlighter even when absent from its extension map', () => {
  let language;
  formatDiff('@@ -0,0 +1 @@\n+{ enable = true; }', 'module.nix', theme('truecolor'), (code, lang) => {
    language = lang;
    return code.split('\n');
  });
  assert.equal(language, 'nix');
});

test('real syntax colors survive multiline comments, light themes, wrapping and theme invalidation', () => {
  for (const appearance of ['dark', 'light']) {
    initTheme(appearance, false);
    const styled = formatDiff(patch, 'example.ts', theme('truecolor'));
    const added = styled.find(row => row.kind === 'added');
    assert.match(added.text, /\x1b\[38;/); // A comment continued from the previous line.
    const keyword = styled.find(row => row.kind === 'added' && row.text.includes('newValue'));
    assert.match(keyword.text, /\x1b\[38;/);
    const viewer = new DiffViewer('example.ts', patch, theme('truecolor'), () => 200, () => {}, () => {});
    for (const width of [18, 30, 64, 100]) {
      const lines = viewer.render(width);
      assert.ok(lines.every(line => visibleWidth(line) === width));
      assert.ok(lines.every(line => line.includes('\x1b[48;2;'))); // Every full row is opaque.
      assert.ok(lines.some(line => line.includes('48;2;20;42;33m'))); // Added tint.
      assert.ok(lines.some(line => line.includes('48;2;48;29;37m'))); // Removed tint.
    }
    const plain = viewer.render(100).map(stripVTControlCharacters).join('\n');
    assert.match(plain, /11\s+- old comment/);
    assert.match(plain, /11\s+\+ new comment/);
    viewer.invalidate();
    assert.match(viewer.render(100).join('\n'), /48;2;32;44;58m/); // Title/hunk band.
  }
});

test('unknown/binary/combined diffs remain readable, terminal controls are escaped before highlighting', () => {
  let called = false;
  const unknown = formatDiff('Binary files differ\n@@@ combined\n++plain', 'unknown.xyzxyz', theme('truecolor'), () => {
    called = true; return [];
  });
  assert.equal(called, false);
  assert.equal(unknown.length, 3);
  const rows = formatDiff('@@ -0,0 +1 @@\n+const x = "bad\x1b[2J";', 'safe.ts', theme('truecolor'), code => {
    assert.ok(!code.includes('\x1b'));
    assert.match(code, /\\x1b/);
    return code.split('\n');
  });
  assert.match(rows.at(-1).text, /\\x1b/);
});

test('dark surfaces restore background after nested resets and support 256 colors', () => {
  for (const mode of ['truecolor', '256color']) {
    const th = theme(mode);
    const surface = darkSurface(th);
    const filled = surface.fill('before\x1b[0mafter\x1b[49mtail');
    assert.equal(stripVTControlCharacters(filled), 'beforeaftertail');
    assert.match(filled, /\x1b\[48;/);
    assert.ok(!filled.includes('\x1b[49mtail'));
    const lifted = readableSyntax('\x1b[38;2;0;0;0mblack\x1b[39m', th);
    assert.ok(!lifted.includes('38;2;0;0;0m'));
    const indexed = readableSyntax('\x1b[38;5;0mblack\x1b[39m', th);
    assert.ok(!indexed.includes('38;5;0m'));
    const panel = new WorktreePanel({ root: '/tmp/worktree', branch: 'feature', files: [{ status: ' M', path: 'file.ts' }] },
      false, th, { truncate: text => text, measure: visibleWidth }, () => 12);
    const passive = panel.render(100);
    assert.ok(passive.every(line => visibleWidth(line) === 100));
    assert.ok(passive.every(line => line.includes('\x1b[48;')));
    panel.setActive(true);
    const active = panel.render(100);
    assert.notDeepEqual(active, passive);
    assert.match(active.map(stripVTControlCharacters).join('\n'), /›  M file.ts/);
  }
});
