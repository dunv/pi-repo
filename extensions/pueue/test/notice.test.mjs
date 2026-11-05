import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeText } from '../notice.ts';
import { extension } from '../index.ts';
import { NOTICE } from '../state.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const content = state => JSON.stringify(state) + '\nLong model-facing permission caveat';
test('compact notices show exit status/uncertainty without internal labels or warning walls', () => {
  assert.equal(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0 })), 'Pueue #1 · Done · exit 0');
  assert.equal(noticeText(content({ id: 2, phase: 'EXITED', exitCode: 7 })), 'Pueue #2 · Failed · exit 7');
  assert.equal(noticeText(content({ id: 2, phase: 'KILLED' })), 'Pueue #2 · Killed (backend terminal; termination unverified)');
  assert.equal(noticeText(content({ id: 2, phase: 'UNKNOWN' })), 'Pueue #2 · Status unknown');
  assert.equal(noticeText(content({ phase: 'ADMISSION_UNKNOWN' })), 'Pueue · Admission unknown');
  assert.match(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0, cancellationRequested: true })), /cancellation requested$/);
  assert.match(noticeText(content({ id: 1, phase: 'EXITED', exitCode: 0 }), true), /publication and descendant termination remain unverified/);
});

test('malformed/legacy contents cannot inject terminal codes or arbitrary status text', () => {
  for (const value of ['\x1b[31mSECRET', {}, null, content({ id: 'evil', phase: 'evil', exitCode: 'evil' })]) {
    assert.equal(noticeText(value), 'Pueue · Status unknown');
  }
  assert.equal(noticeText([{ type: 'text', text: content({ id: 4, phase: 'EXITED', exitCode: 1 }) }]), 'Pueue #4 · Failed · exit 1');
});

test('running notice cards have a single disclosure arrow', () => {
  let renderer;
  extension({ registerMessageRenderer: (_name, r) => { renderer = r; }, on() {}, registerTool() {}, registerCommand() {} });
  for (const expanded of [false, true]) {
    const component = renderer({ content: content({ id: 95, phase: 'RUNNING' }) }, { expanded, outputPad: 1 }, {
      fg: (_ink, text) => text, bg: (_ink, text) => text, bold: text => text,
    });
    assert.equal(component.render(160)[1].trim(), `${expanded ? '▾' : '▸'} Pueue #95 · Running`);
  }
});

test('renderer uses a tool-style card, supports click expansion, and never shows raw payloads', () => {
  let renderer;
  extension({ registerMessageRenderer: (name, r) => { assert.equal(name, NOTICE); renderer = r; },
    on() {}, registerTool() {}, registerCommand() {} });
  for (const state of [{ id: 1, phase: 'EXITED', exitCode: 0 }, { id: 1, phase: 'EXITED', exitCode: 7 },
    { id: 1, phase: 'KILLED' }, { id: 1, phase: 'UNKNOWN' }, { phase: 'ADMISSION_UNKNOWN' }]) {
    const inks = [], backgrounds = [], bold = [];
    const component = renderer({ content: content(state) }, { expanded: false, outputPad: 1 }, {
      fg: (ink, text) => { inks.push(ink); return text; },
      bg: (ink, text) => { backgrounds.push(ink); return text; },
      bold: text => { bold.push(text); return text; },
    });
    const lines = component.render(100);
    const text = lines.join('\n');
    assert.deepEqual(inks, [state.phase === 'EXITED' ? (state.exitCode === 0 ? 'success' : 'error') : 'warning', 'toolTitle']);
    const expectedBg = state.phase === 'EXITED' ? (state.exitCode === 0 ? 'toolSuccessBg' : 'toolErrorBg')
      : state.phase === 'KILLED' ? 'toolErrorBg' : 'toolPendingBg';
    assert.ok(backgrounds.length >= 2);
    assert.ok(backgrounds.every(ink => ink === expectedBg));
    assert.match(bold[0], /Pueue/);
    assert.equal(lines[0].trim(), '');
    assert.equal(lines.at(-1).trim(), '');
    assert.match(lines[1], /^ ▸ /);
    assert.match(text, /Pueue/);
    assert.doesNotMatch(text, /notice\.v1|\x1b\[|permission caveat|Submission details/);
    assert.equal(component.handleMouse({ type: 'click', button: 'left', x: 0, y: 0 }), undefined);
    assert.deepEqual(component.handleMouse({ type: 'click', button: 'left', x: 0, y: 1 }), { handled: true, render: true });
    assert.match(component.render(100).join('\n'), /Submission details unavailable/);
    assert.match(component.render(100).join('\n'), /publication and descendant termination remain unverified/);
    for (const width of [4, 12, 40]) {
      assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    }
    assert.deepEqual(component.handleMouse({ type: 'click', button: 'left', x: 0, y: 1 }), { handled: true, render: true });
    assert.doesNotMatch(component.render(100).join('\n'), /Submission details unavailable/);
  }
});
