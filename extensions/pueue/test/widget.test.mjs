import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetLines } from '../widget.ts';

const row = (phase, id = 0) => ({ nonce: '00000000-0000-4000-8000-000000000001', id, phase });

test('widget hides empty/finished history and counts all unresolved states', () => {
  assert.equal(widgetLines([], true), undefined);
  assert.equal(widgetLines([row('EXITED'), row('KILLED')], true), undefined);
  const rows = ['RUNNING', 'QUEUED', 'PAUSED', 'STASHED', 'UNKNOWN', 'ADMISSION_UNKNOWN', 'EXITED', 'KILLED'].map(row);
  const expanded = widgetLines(rows, true);
  assert.equal(expanded.length, 7);
  assert.match(expanded[0], /1 running · 1 queued · 1 paused · 1 stashed · 1 unknown · 1 admission unknown/);
  assert.match(expanded[0], /\/pueue collapse/);
  assert.equal(widgetLines(rows, false).length, 1);
  assert.match(widgetLines(rows, false)[0], /\/pueue expand/);
});

test('widget bounds details and keeps uncertainty/cancellation explicit without raw workload data', () => {
  const rows = Array.from({ length: 9 }, (_, id) => ({ ...row('RUNNING', id), command: 'SECRET', cancellationRequested: id === 0 }));
  const lines = widgetLines(rows, true, true);
  assert.equal(lines.length, 8);
  assert.match(lines[0], /status unavailable/);
  assert.match(lines[1], /#0 · RUNNING · SIGTERM requested/);
  assert.match(lines.at(-1), /3 more active jobs/);
  assert.doesNotMatch(lines.join('\n'), /SECRET/);
  assert.match(widgetLines([{ ...row('ADMISSION_UNKNOWN'), id: undefined }], true)[1], /pending/);
});
