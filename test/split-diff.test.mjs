import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as strip } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { pairDiffLines } from '../src/diff-format.ts';
import { DiffViewer } from '../src/diff.ts';

const theme = { style: text => text, getColorMode: () => 'truecolor' };
const plain = viewer => viewer.render(120).map(strip);

test('pairs replacement blocks and leaves missing sides blank, respecting boundaries', () => {
  const removed = text => ({ kind: 'removed', text });
  const added = text => ({ kind: 'added', text });
  const context = { kind: 'context', text: 'same' };
  const meta = { kind: 'meta', text: '\\ No newline at end of file' };
  const lines = [removed('a'), removed('b'), added('c'), context, added('d'), meta, removed('e')];
  assert.deepEqual(pairDiffLines(lines), [
    { left: lines[0], right: lines[2] }, { left: lines[1], right: undefined },
    { left: context, right: context }, { left: undefined, right: lines[4] },
    { full: meta }, { left: lines[6], right: undefined },
  ]);
});

test('wide viewer defaults to old/new columns with independent numbers and toggle', () => {
  let renders = 0;
  const viewer = new DiffViewer('file.txt', '@@ -10,3 +20,3 @@\n same\n-old\n-removed\n+new\n+added',
    theme, () => 30, () => renders++, () => {});
  const lines = plain(viewer);
  assert.ok(lines.some(line => /10\s+same.*│.*20\s+same/.test(line)));
  assert.ok(lines.some(line => /11 - old.*│.*21 \+ new/.test(line)));
  assert.match(lines.join('\n'), /Old │ New/);
  viewer.handleInput('s');
  assert.match(plain(viewer).join('\n'), /Unified/);
  viewer.handleInput('s');
  assert.match(plain(viewer).join('\n'), /Old │ New/);
  assert.equal(renders, 2);
  assert.match(viewer.render(60).map(strip).join('\n'), /Unified/);
  assert.match(plain(viewer).join('\n'), /Old │ New/);
});

test('split wrapping aligns unequal heights, bounds widths, scrolls and invalidates', () => {
  const viewer = new DiffViewer('file.txt', '@@ -1,2 +1,2 @@\n-' + '界é '.repeat(60) + '\n+short\n tail',
    theme, () => 12, () => {}, () => {});
  for (const width of [120, 87, 86, 40, 160]) {
    const lines = viewer.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
    assert.ok(lines.length <= 12);
  }
  viewer.handleInput('G');
  assert.match(plain(viewer).join('\n'), /tail/);
  viewer.handleInput('g');
  viewer.invalidate();
  assert.match(plain(viewer).join('\n'), /short/);
});

test('metadata and binary/conflict summaries remain full-width', () => {
  const viewer = new DiffViewer('file.txt', 'Staged\nBinary files a/file and b/file differ\n@@@ -1,1 -1,1 +1,1 @@@\n++conflict',
    theme, () => 30, () => {}, () => {});
  const lines = plain(viewer);
  assert.ok(lines.some(line => line.includes('Binary files a/file and b/file differ')));
  assert.ok(lines.some(line => line.includes('++conflict')));
});
