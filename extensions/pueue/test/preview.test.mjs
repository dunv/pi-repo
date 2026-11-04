import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import preview, { samples } from './preview.mjs';

test('visual gallery loads only renderers and its command; all examples are passive and width-safe', async () => {
  const renderers = new Map(), commands = new Map(), messages = [];
  preview({
    registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: (message, options) => { assert.deepEqual(options, { triggerTurn: false }); messages.push(message); },
    on() { assert.fail('preview must not register backend hooks'); },
    registerTool() { assert.fail('preview must not expose tools'); },
  });
  assert.deepEqual([...commands.keys()], ['pueue-preview']);
  assert.equal(renderers.size, 2);
  await commands.get('pueue-preview').handler('', {});
  assert.equal(messages.length, 25);
  const before = structuredClone(messages);
  const theme = { fg: (_ink, text) => text, bg: (_ink, text) => text, bold: text => text };
  for (const message of messages) for (const expanded of [false, true]) for (const outputPad of [0, 1, 3]) {
    const component = renderers.get(message.customType)(message, { expanded, outputPad }, theme);
    for (const width of [4, 12, 80, 160]) {
      assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    }
    assert.deepEqual(component.handleMouse({ type: 'click', button: 'left', x: 0, y: 1 }), { handled: true, render: true });
    component.render(80);
  }
  assert.deepEqual(messages, before);
  assert.equal(samples('notices').length, 8);
  assert.equal(samples('submit').length, 8);
  assert.equal(samples('logs').length, 9);
  await commands.get('pueue-preview').handler('invalid', { ui: { notify: text => assert.match(text, /Usage/) } });
  assert.equal(messages.length, 25);
});
