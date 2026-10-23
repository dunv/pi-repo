import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../backend.ts';
import { ENTRY, RECEIPT, intent, jobs, matching, noticed, view } from '../state.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owner = { session: 'session-one', file: '/session-one.jsonl', anchor: 'branch-anchor' };
const ns = '00000000-0000-4000-8000-000000000001';
test('recovery is reconstructed solely from supported entries; uncertain admission with backend evidence never becomes authorization', () => {
  const j = intent(owner, ns);
  const raw = { id: 4, label: j.label, created: '2026-10-22T00:00:00Z', phase: 'EXITED', exitCode: 0 };
  const entries = JSON.parse(JSON.stringify([{ type: 'custom', customType: ENTRY, data: j }]));
  const [restored] = jobs(entries, owner, ns);
  assert.equal(view(restored, [raw]).phase, 'ADMISSION_UNKNOWN');
  assert.equal(view(restored, [raw]).exitCode, undefined);
  assert.equal(view(restored, [raw]).id, 4);
  assert.equal(jobs(entries, { ...owner, session: 'fork' }, ns).length, 0);
  assert.equal(jobs(entries, { ...owner, file: '/clone.jsonl' }, ns).length, 0);
  assert.equal(jobs(entries, owner, 'other-namespace').length, 0);
  assert.equal(jobs([], owner, ns).length, 0);
  assert.equal(matching(j, [raw, raw]), undefined); // Ambiguous duplicate label is not admitted.
});

test('lost post-mutation add reply retains backend evidence and does not retry on its own', async () => {
  let added = 0;
  const b = new Backend({}, async args => {
    if (args[0] === 'add') { added++; throw new Error('Lost reply after backend mutation'); }
    return '{}';
  });
  await assert.rejects(b.add(['/bin/true'], '/repo', 'controlled-nonce-label', 'session-group'));
  assert.equal(added, 1);
  // No recovery engine/timer exists in Backend; policy reconstructs the intent as UNKNOWN.
});

test('real Pi session entries persist receipts before messages and follow only the active branch on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pueue-receipt-'));
  try {
    const sm = SessionManager.create(dir, dir);
    const root = sm.appendMessage({ role: 'user', content: 'authorized local check', timestamp: Date.now() });
    const owner = { session: sm.getSessionId(), file: sm.getSessionFile(), anchor: root };
    const j = intent(owner, ns);
    sm.appendCustomEntry(ENTRY, j);
    const key = `${j.nonce}:EXITED:0:false`;
    const receipt = sm.appendCustomEntry(RECEIPT, { key });
    assert.equal(noticed(sm.getBranch(), key), true);
    const reopened = SessionManager.open(sm.getSessionFile());
    assert.equal(noticed(reopened.getBranch(), key), true);
    assert.equal(jobs(reopened.getBranch(), owner, ns).length, 1);
    reopened.branch(root);
    assert.equal(noticed(reopened.getBranch(), key), false);
    assert.equal(jobs(reopened.getBranch(), owner, ns).length, 0);
    reopened.branch(receipt);
    assert.equal(noticed(reopened.getBranch(), key), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
