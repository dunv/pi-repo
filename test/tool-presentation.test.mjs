import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import pueue from '../extensions/pueue/index.ts';
import delegate from '../extensions/delegate/index.ts';

const tools = new Map();
const api = { registerTool: tool => tools.set(tool.name, tool), on() {}, registerMessageRenderer() {}, registerCommand() {} };
pueue(api); delegate(api);
const theme = { fg: (_color, text) => text, bold: text => text };
const fixtures = {
  pueue_status: [{ nonce: 'job-1', id: 94, phase: 'EXITED', exitCode: 0 }, { nonce: 'job-2', phase: 'UNKNOWN' }],
  pueue_cancel: { nonce: 'job-1', signalRequested: true, cancellationRequested: true },
  delegate_models: { entries: [{ id: 'provider/model', backend: 'pi', capabilities: {} }], total: 2, nextOffset: 1 },
  delegate_environments: { environments: [{ id: 'source-review', capabilities: { source: 'read-only', checks: false }, verificationProfiles: [], isolation: { network: 'host' }, launcher: '/bin/launch', path: '/bin' }] },
  delegate_cleanup: { task: 'task-1', disposition: 'used', removed: ['/worktree'], branch: 'delegate/task-1', summary: 'retained facts', summaryRecorded: true },
};
function render(name, data, expanded = false, extra = {}) {
  const result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
  return tools.get(name).renderResult(result, { expanded, isPartial: false }, theme, { isError: false, ...extra });
}

test('previously bare tools have themed shells, compact summaries, expandable details, and safe fallbacks', () => {
  for (const [name, data] of Object.entries(fixtures)) {
    const tool = tools.get(name), before = structuredClone(data);
    assert.equal(tool.renderShell, 'default');
    for (const width of [5, 20, 80]) {
      const call = tool.renderCall({}, theme, {}).render(width);
      const lines = render(name, data).render(width);
      assert.ok([...call, ...lines].every(line => visibleWidth(line) <= width));
    }
    const collapsed = render(name, data).render(200).join('\n');
    assert.match(collapsed, /▸ (Pueue|Subagent)/);
    assert.doesNotMatch(collapsed, /Display unavailable/);
    assert.match(render(name, data, true).render(200).join('\n'), /▾/);
    assert.deepEqual(data, before);
    const error = tool.renderResult({ content: [{ type: 'text', text: 'State UNKNOWN\nDo not retry\x1b[31m' }] }, { expanded: false }, theme, { isError: true }).render(200).join('\n');
    assert.match(error, /Failed.*\n.*Do not retry/s);
    assert.doesNotMatch(error, /\x1b/);
    assert.match(tool.renderResult({ content: [] }, { isPartial: true }, theme, {}).render(200).join('\n'), /Working/);
    assert.match(render(name, null).render(200).join('\n'), /Display unavailable/);
  }
});

test('status and cancellation preserve uncertainty rather than claiming success', () => {
  const status = render('pueue_status', fixtures.pueue_status).render(200).join('\n');
  assert.match(status, /Pueue #94 · Done · exit 0/);
  assert.match(status, /Status unknown/);
  assert.doesNotMatch(status, /job-1/);
  assert.match(render('pueue_status', fixtures.pueue_status, true).render(200).join('\n'), /job-1/);
  assert.match(render('pueue_status', []).render(200).join('\n'), /absence is not completion/);
  for (const signalRequested of [true, false]) {
    const text = render('pueue_cancel', { ...fixtures.pueue_cancel, signalRequested }).render(200).join('\n');
    assert.match(text, signalRequested ? /SIGTERM requested/ : /No signal sent/);
    assert.match(text, /remain unverified/);
  }
});

test('cleanup distinguishes inspection from removal and hides the long summary until expanded', () => {
  assert.doesNotMatch(render('delegate_cleanup', fixtures.delegate_cleanup).render(200).join('\n'), /retained facts|\/worktree/);
  assert.match(render('delegate_cleanup', fixtures.delegate_cleanup, true).render(200).join('\n'), /Summary: "retained facts"/);
  const inspection = { task: 'task-1', paths: ['/worktree'], branch: 'delegate/task-1' };
  assert.match(render('delegate_cleanup', inspection).render(200).join('\n'), /inspected \(not removed\)/);
  assert.match(render('delegate_cleanup', inspection, true).render(200).join('\n'), /Removal scope/);
  assert.match(render('delegate_cleanup', { ...fixtures.delegate_cleanup, summaryRecorded: false }).render(200).join('\n'), /recording not confirmed/);
});

test('discovery shows routes, pagination and isolation limits without claiming readiness', () => {
  assert.match(render('delegate_models', fixtures.delegate_models).render(200).join('\n'), /provider-defined.*\n.*unverified.*\n.*offset "1"/s);
  assert.match(render('delegate_models', { entries: [], total: 0, nextOffset: null }).render(200).join('\n'), /0 of 0/);
  assert.match(render('delegate_environments', fixtures.delegate_environments).render(200).join('\n'), /not an OS sandbox/);
  const hostile = { ...fixtures.delegate_cleanup, summary: 'bad\x1b[31m\nnext\u009b', removed: ['/wide/界'] };
  const text = render('delegate_cleanup', hostile, true).render(200).join('\n');
  assert.doesNotMatch(text, /[\x1b\u009b]/);
  assert.match(text, /\\u001b/);
});
