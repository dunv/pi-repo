import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeText } from '../notice.ts';
import { extension } from '../index.ts';
import { NOTICE } from '../state.ts';

const content = state => JSON.stringify(state) + '\nLong model-facing permission caveat';
test('compact notices show exit status/uncertainty without internal labels or warning walls', () => {
  assert.equal(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0 })), 'Pueue job #1 finished · exit 0');
  assert.equal(noticeText(content({ id: 2, phase: 'EXITED', exitCode: 7 })), 'Pueue job #2 finished · exit 7');
  assert.equal(noticeText(content({ id: 2, phase: 'UNKNOWN' })), 'Pueue job #2 state unknown');
  assert.equal(noticeText(content({ phase: 'ADMISSION_UNKNOWN' })), 'Pueue job admission unknown');
  assert.match(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0, cancellationRequested: true })), /cancellation requested$/);
  assert.match(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0 }), true), /publication and descendant termination remain unverified/);
});

test('malformed/legacy contents cannot inject terminal codes or arbitrary status text', () => {
  for (const value of ['\x1b[31mSECRET', {}, null, content({ id: 'evil', phase: 'evil', exitCode: 'evil' })]) {
    assert.equal(noticeText(value), 'Pueue job state unknown');
  }
  assert.equal(noticeText([{ type: 'text', text: content({ id: 4, phase: 'EXITED', exitCode: 1 }) }]), 'Pueue job #4 finished · exit 1');
});

test('renderer uses only neutral muted styling, even for nonzero/unknown states', () => {
  let renderer;
  extension({ registerMessageRenderer: (name, r) => { assert.equal(name, NOTICE); renderer = r; },
    on() {}, registerTool() {}, registerCommand() {} });
  for (const state of [{ id: 1, phase: 'EXITED', exitCode: 7 }, { id: 1, phase: 'UNKNOWN' }]) {
    const inks = [];
    const component = renderer({ content: content(state) }, { expanded: false, outputPad: 1 }, {
      fg: (ink, text) => { inks.push(ink); return text; },
    });
    assert.deepEqual(inks, ['muted']);
    const text = component.render(100).join('\n');
    assert.match(text, /Pueue job #1/);
    assert.doesNotMatch(text, /notice\.v1|\x1b\[|permission caveat/);
  }
});
