// Deterministic /proc fixtures: no real process stopping or lucky scan retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observeRetirementProcesses, retirementVisibilityPermitted, retirementBackendObservation } from '../retire.mjs';

const task = { id: randomUUID(), worktree: '/fixture/worker', directory: '/fixture/state' };
const denied = () => { throw Object.assign(new Error('permission limited'), { code: 'EACCES' }); };
const gone = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
function proc({ pids = ['701'], hidden = true, disappear = false, reuse = false, cmd = 'unrelated\0', cwd = '/unrelated', fd = '/unrelated/file', bootChange = false, identityDenied = false } = {}) {
  const boot = randomUUID(); let boots = 0, stats = 0;
  return {
    lstat: async () => ({ uid: process.getuid() }),
    readdir: async path => path === '/proc' ? pids : ['3'],
    readlink: async path => {
      if (disappear) return gone();
      if (path.endsWith('/cwd')) return cwd;
      if (hidden) return denied();
      return fd;
    },
    readFile: async path => {
      if (path.endsWith('/boot_id')) return bootChange && boots++ ? randomUUID() : boot;
      if (path.endsWith('/stat')) {
        if (identityDenied) return denied();
        return `701 (fixture name) ${Array(19).fill('0').join(' ')} ${reuse && stats++ ? '222' : '111'} 0`;
      }
      return Buffer.from(path.endsWith('/cmdline') ? cmd : '0::/unrelated.slice\n');
    },
  };
}

test('readable unrelated process churn and disappeared PIDs do not change task evidence', async () => {
  for (const options of [{ hidden: false }, { disappear: true }]) {
    const observation = await observeRetirementProcesses(task, proc(options));
    assert.deepEqual(observation.uninspectablePids, []);
    assert.equal(observation.stoppedProof, false);
  }
});
test('opaque process identities bind PID/start/command/cgroup and visibility gaps; disappearing gaps are allowed, new or changed gaps are not', async () => {
  const io = proc(), confirmed = await observeRetirementProcesses(task, io);
  assert.deepEqual(confirmed.uninspectablePids, [701]);
  assert.equal(confirmed.visibilityRecords[0].startTime, '111');
  assert.deepEqual(confirmed.visibilityRecords[0].unavailable, ['fd-target']);
  assert.equal(retirementVisibilityPermitted(confirmed, confirmed), true);
  assert.equal(retirementVisibilityPermitted({ ...confirmed, uninspectablePids: [], visibilityRecords: [] }, confirmed), true);
  for (const change of [{ pid: 702 }, { startTime: '222' }, { commandSha256: 'a'.repeat(64) }, { cgroupSha256: 'b'.repeat(64) }, { unavailable: ['cwd'] }]) {
    const row = { ...confirmed.visibilityRecords[0], ...change };
    assert.equal(retirementVisibilityPermitted({ ...confirmed, uninspectablePids: [row.pid], visibilityRecords: [row] }, confirmed), false);
  }
  assert.equal(retirementVisibilityPermitted({ ...confirmed, bootId: randomUUID() }, confirmed), false);
});
test('positive cwd/open-file/UUID references, unreadable identities, PID reuse and changed boots remain blockers', async () => {
  for (const options of [{ cwd: task.worktree }, { hidden: false, fd: task.directory + '/record' },
    { cmd: 'node\0' + task.id }, { reuse: true }, { identityDenied: true }, { bootChange: true }]) {
    await assert.rejects(observeRetirementProcesses(task, proc(options)));
  }
});
test('retirement-only numeric recycling never gives unrelated jobs original authority; labels, creation and namespace remain exact', () => {
  const job = { namespace: randomUUID(), nonce: randomUUID(), id: 12, label: 'exact-original-label', created: '2026-11-01T00:00:00Z' };
  const snapshot = tasks => ({ namespace: job.namespace, tasks });
  assert.equal(retirementBackendObservation(job, snapshot([{ id: job.id, label: 'unrelated', created: 'later', phase: 'RUNNING' }])), null);
  assert.deepEqual(retirementBackendObservation(job, snapshot([{ ...job, phase: 'KILLED' }])), { nonce: job.nonce, phase: 'KILLED' });
  for (const rows of [[{ ...job, id: 99 }], [{ ...job, created: 'later' }], [{ ...job }, { ...job }]]) {
    assert.throws(() => retirementBackendObservation(job, snapshot(rows)), /reused/);
  }
  for (const invalid of [null, {}, { namespace: randomUUID(), tasks: [] }]) assert.throws(() => retirementBackendObservation(job, invalid), /unavailable/);
});
