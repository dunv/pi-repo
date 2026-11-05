import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timestampLines } from '../logging.mjs';

const time = '2026-11-05T09:42:17.123Z';
const prefix = `[${time}] `;

test('timestamps arrive on first bytes without buffering or repeating on chunks', () => {
  let calls = 0;
  const stamp = timestampLines(() => { calls++; return time; });
  assert.equal(stamp('').length, 0);
  assert.equal(stamp('hel').toString(), prefix + 'hel');
  assert.equal(stamp('lo').toString(), 'lo');
  assert.equal(stamp('\nnext\n\nlast').toString(), '\n' + prefix + 'next\n' + prefix + '\n' + prefix + 'last');
  assert.equal(calls, 4);
});

test('timestamps preserve split UTF-8, CRLF and unterminated lines verbatim', () => {
  const stamp = timestampLines(() => time);
  const raw = Buffer.from('café ☕\r\nlast');
  const output = Buffer.concat([...raw].map(byte => stamp(Buffer.from([byte]))));
  assert.equal(output.toString(), prefix + 'café ☕\r\n' + prefix + 'last');
});

test('each line uses its own first-byte observation time', () => {
  let tick = 0;
  const stamp = timestampLines(() => String(++tick));
  assert.equal(stamp('one').toString(), '[1] one');
  assert.equal(stamp(' continued\ntwo\nthree').toString(), ' continued\n[2] two\n[3] three');
});
