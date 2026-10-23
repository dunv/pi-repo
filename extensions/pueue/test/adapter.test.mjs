import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Backend, project, command, minimalEnvironment, runner, configuration, sliceLog, privateDirectory } from '../backend.ts';
import { ENTRY, NOTICE, RECEIPT, jobs, matching, sessionGroup, view } from '../state.ts';
import { extension } from '../index.ts';
import { hint } from '../callback.mjs';

const ns = '00000000-0000-4000-8000-000000000001';
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pueue-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'task_logs'));
  const config = { binary: '/fake/pueue', config: join(dir, 'pueue.yml'), data: dir, namespace: ns, home: dir, path: '/usr/bin:/bin' };
  return { dir, config };
}
class Fake {
  tasks = {}; calls = []; groups = new Map(); next = 0; fail; hook; loseReply;
  async run(args) {
    this.calls.push(structuredClone(args));
    await this.hook?.(args);
    if (this.fail?.(args)) throw new Error('SIMULATED_SECRET: raw CLI error');
    if (args[0] === '--version') return 'pueue 4.0.4\n';
    if (args[0] === 'status') return JSON.stringify({ tasks: this.tasks, envs: { OTHER_SECRET: 'must-not-escape' } });
    if (args[0] === 'group') {
      if (args[1] === '--json') return JSON.stringify(Object.fromEntries(this.groups));
      assert.equal(args[1], 'add');
      const name = args.at(-1);
      if (this.groups.has(name)) return `Group "${name}" already exists`;
      this.groups.set(name, { status: 'Running', parallel_tasks: Number(args[args.indexOf('--parallel') + 1]) });
      return `New group "${name}" has been created`;
    }
    if (args[0] === 'add') {
      const id = this.next++;
      this.tasks[id] = { id, created_at: `2026-10-22T12:00:${String(id).padStart(2, '0')}+00:00`,
        group: args[args.indexOf('--group') + 1],
        label: args[args.indexOf('--label') + 1], envs: { SECRET: 'must-not-escape' },
        command: 'secret-command', status: { Stashed: { enqueue_at: null } } };
      if (this.loseReply === 'add') throw new Error('SECRET lost admission reply');
      return `${id}\n`;
    }
    if (args[0] === 'enqueue') {
      const task = this.tasks[args[1]], group = this.groups.get(task.group);
      assert.ok(group, 'every submission explicitly selects an existing group');
      const running = Object.values(this.tasks).filter(t => t.group === task.group && t.status.Running).length;
      task.status = running < group.parallel_tasks && group.status === 'Running'
        ? { Running: { start: 'now' } } : { Queued: {} };
      if (this.loseReply === 'enqueue') throw new Error('SECRET lost enqueue reply');
    }
    if (args[0] === 'kill') this.finish(Number(args.at(-1)), 'Success'); // SIGTERM handler can exit zero!
    return 'ok';
  }
  finish(id, result) { this.tasks[id].status = { Done: { result, end: 'now' } }; }
}
async function harness({ history = [], session = 'origin', file = '/sessions/origin.jsonl', fake = new Fake(), config, delayedDelivery = false } = {}) {
  config ??= (await fixture()).config;
  const env = { PI_PUEUE_BINARY: config.binary, PI_PUEUE_CONFIG: config.config,
    PI_PUEUE_DATA: config.data, PI_PUEUE_NAMESPACE: config.namespace, PI_PUEUE_PATH: config.path,
    PI_PUEUE_CONFIRM_SUBMIT: config.confirmSubmit ? '1' : '0',
    ...(config.hints ? { PI_PUEUE_HINTS: config.hints } : {}) };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  cleanups.push(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const events = new Map(), tools = new Map(), commands = new Map(), messages = [], notifications = [];
  const h = { history, session, file, confirm: true, confirmations: 0, hasUI: true };
  const ctx = { cwd: '/repo', mode: 'tui', get hasUI() { return h.hasUI; },
    sessionManager: { getSessionId: () => h.session, getSessionFile: () => h.file,
      getLeafId: () => h.history.at(-1)?.id ?? null, getBranch: () => h.history },
    ui: { confirm: async () => { h.confirmations++; return h.confirm; }, notify: text => notifications.push(text) } };
  const pi = {
    on: (name, fn) => events.set(name, fn), registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c),
    registerMessageRenderer() {},
    appendEntry: (customType, data) => h.history.push({ type: 'custom', id: `entry-${h.history.length}`, customType, data: structuredClone(data) }),
    sendMessage: (message, options) => {
      messages.push({ ...message, options });
      // Pi's void sendMessage can queue through startup/streaming before persistence.
      if (!delayedDelivery) h.history.push({ type: 'custom_message', ...structuredClone(message) });
      h.onSend?.(message);
    },
  };
  extension(pi, c => new Backend(c, args => fake.run(args)));
  const stop = () => events.get('session_shutdown')({}, ctx);
  cleanups.push(stop);
  const start = () => events.get('session_start')({ reason: 'resume' }, ctx);
  const call = async (name, input = {}, signal) => tools.get(name).execute('tool', input, signal, undefined, ctx);
  const submit = input => call('pueue_submit', { argv: ['/bin/echo', 'hello'], cwd: '/repo', ...input });
  const status = async (input = {}) => JSON.parse((await call('pueue_status', input)).content[0].text);
  const job = () => h.history.filter(e => e.customType === ENTRY).at(-1)?.data;
  const cancel = nonce => commands.get('pueue-cancel').handler(nonce ?? job().nonce, ctx);
  await start();
  return Object.assign(h, { fake, config, events, tools, commands, ctx, messages, notifications, start, stop, call, submit, status, job, cancel });
}

test('literal argv is shell-safe including quotes/newlines/option-looking arguments; no shell expansion', () => {
  const argv = [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', "a'b", '$(echo expanded)', 'x\ny', '--flag', 'a; false'];
  assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', command(argv)], { encoding: 'utf8' })), argv.slice(4));
  for (const args of [[], ['relative'], ['/bin/echo', '\0']]) assert.throws(() => command(args));
});

test('minimal CLI environment, pinned version, safe CLI diagnostics and bounded private status projection', async () => {
  const { dir, config } = await fixture();
  assert.deepEqual(minimalEnvironment(config), { HOME: dir, PATH: config.path, LANG: 'C.UTF-8' });
  assert.equal(configuration({}), undefined);
  assert.throws(() => configuration({ PI_PUEUE_BINARY: '/bin/pueue' }));
  const script = join(dir, 'fake-pueue');
  await writeFile(script, `#!${process.execPath}\nif (process.argv.includes('fail')) { console.error('SECRET'); console.log('SECRET'); process.exit(1); }\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`, { mode: 0o700 });
  const run = runner({ ...config, binary: script });
  process.env.PI_REPO_TEST_SECRET = 'must-not-escape';
  try {
    const reply = JSON.parse(await run(['status', '--json']));
    assert.deepEqual(reply.args, ['--config', config.config, '--color', 'never', 'status', '--json']);
    assert.equal(reply.env.PI_REPO_TEST_SECRET, undefined);
    assert.deepEqual(Object.keys(reply.env).sort(), ['HOME', 'LANG', 'PATH']);
    await assert.rejects(run(['fail']), e => !String(e).includes('SECRET') && String(e).includes('UNKNOWN'));
  } finally { delete process.env.PI_REPO_TEST_SECRET; }
  await assert.rejects(new Backend(config, async () => 'pueue 4.0.3').check(), /4.0.4/);
  assert.throws(() => project('{ SECRET'), e => !String(e).includes('SECRET'));
  assert.deepEqual(project('{"tasks":{"0":{"id":0,"created_at":"bad","envs":{"SECRET":"value"}}}}'), []);
});

test('admission persists nonce before add, stashed identity before enqueue; no task cancellation on Pi abort/shutdown', async () => {
  const h = await harness();
  const signal = new AbortController();
  h.fake.hook = args => {
    if (args[0] === 'add') assert.ok(h.job()?.nonce);
    if (args[0] === 'enqueue') {
      assert.equal(h.job().id, 0); assert.ok(h.job().created); assert.equal(h.job().admitted, undefined);
      signal.abort(); // Already admitted/stashed: abort must not cancel or orphan execution.
    }
  };
  await h.call('pueue_submit', { argv: ['/bin/echo', 'hello'], cwd: '/repo' }, signal.signal);
  const [state] = await h.status();
  assert.equal(state.phase, 'RUNNING');
  assert.equal('publication' in state, false); assert.equal('cancellationRequested' in state, false);
  const text = JSON.stringify(await h.call('pueue_status'));
  assert.doesNotMatch(text, /must-not-escape|secret-command|OTHER_SECRET/);
  h.stop(); h.stop();
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 0);
  assert.equal(h.fake.tasks[0].status.Running.start, 'now');
  await h.start();
  assert.equal((await h.status())[0].phase, 'RUNNING');
  assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 1);
});

test('opt-in submission confirmation fails closed without UI or approval, and pre-admission abort still blocks', async () => {
  const h = await harness({ config: { ...(await fixture()).config, confirmSubmit: true } });
  h.confirm = false; await assert.rejects(h.submit(), /confirmation/);
  h.confirm = true; h.hasUI = false; await assert.rejects(h.submit(), /confirmation/);
  h.hasUI = true;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.call('pueue_submit', { argv: ['/bin/true'], cwd: '/repo' }, controller.signal), /not admitted/);
  assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 0);
  await h.submit(); // Opt-in still admits explicitly approved UI submissions.
  assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 1);
  assert.ok(h.confirmations > 0);
});

test('submission has no extra popup by default, including non-UI sessions; cancellation still requires confirmation', async () => {
  const h = await harness();
  h.confirm = false; h.hasUI = false;
  await h.submit();
  assert.equal(h.confirmations, 0);
  assert.equal((await h.status())[0].phase, 'RUNNING');
  await h.cancel();
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 0);
  h.hasUI = true;
  await h.cancel();
  assert.equal(h.confirmations, 1);
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 0);
});

test('submission confirmation configuration defaults off and accepts explicit 0/1 only', async () => {
  const { config: c } = await fixture();
  const env = { HOME: c.home, PI_PUEUE_BINARY: c.binary, PI_PUEUE_CONFIG: c.config,
    PI_PUEUE_DATA: c.data, PI_PUEUE_NAMESPACE: c.namespace, PI_PUEUE_PATH: c.path };
  assert.equal(configuration(env).confirmSubmit, false);
  assert.equal(configuration({ ...env, PI_PUEUE_CONFIRM_SUBMIT: '0' }).confirmSubmit, false);
  assert.equal(configuration({ ...env, PI_PUEUE_CONFIRM_SUBMIT: '1' }).confirmSubmit, true);
  assert.throws(() => configuration({ ...env, PI_PUEUE_CONFIRM_SUBMIT: 'typo' }), /must be 0 or 1/);
  assert.equal(minimalEnvironment(configuration({ ...env, PI_PUEUE_CONFIRM_SUBMIT: '1' })).PI_PUEUE_CONFIRM_SUBMIT, undefined);
});

test('success/nonzero are backend exits only; killed/restored/missing/reused state stays UNKNOWN; no automatic resubmission', async () => {
  const h = await harness(); await h.submit();
  for (const [backendResult, expected, code] of [['Success', 'EXITED', 0], [{ Failed: 13 }, 'EXITED', 13],
    ['Killed', 'UNKNOWN'], ['Errored', 'UNKNOWN'], [{ FailedToSpawn: 'SECRET' }, 'UNKNOWN']]) {
    h.fake.finish(0, backendResult);
    const [state] = await h.status(); assert.equal(state.phase, expected); assert.equal(state.exitCode, code);
    assert.equal('stoppedDescendants' in state, false);
  }
  const original = structuredClone(h.fake.tasks[0]);
  h.fake.tasks = {}; assert.equal((await h.status())[0].phase, 'UNKNOWN');
  h.fake.tasks = { 0: { ...original, label: 'another-job' } };
  assert.equal((await h.status())[0].phase, 'UNKNOWN');
  h.fake.tasks = { 0: { ...original, created_at: '2026-10-23T00:00:00Z' } };
  assert.equal((await h.status())[0].phase, 'UNKNOWN');
  await assert.rejects(h.call('pueue_result', { nonce: h.job().nonce }), /missing\/reused/);
  await h.start();
  assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 1);
  assert.equal(h.fake.calls.filter(a => ['clean', 'remove', 'reset', 'restart', 'shutdown'].includes(a[0])).length, 0);
});

test('explicit cancellation uses SIGTERM only, persists intent even when handler exits zero; generic abort never signals', async () => {
  const h = await harness(); await h.submit();
  h.fake.hook = args => { if (args[0] === 'kill') assert.equal(h.job().cancellationRequested, true); };
  await h.cancel();
  assert.deepEqual(h.fake.calls.find(a => a[0] === 'kill'), ['kill', '--signal', 'SIGTERM', '0']);
  const [state] = await h.status(); assert.equal(state.phase, 'EXITED'); assert.equal(state.exitCode, 0);
  assert.equal(state.cancellationRequested, true); assert.equal('publication' in state, false);
  await h.cancel(); // Already exited: intent remains, no second signal.
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 1);
  assert.equal(h.tools.has('pueue_cancel'), false);
});

test('lost admission/enqueue replies and restart never re-admit; stashed evidence remains; errors exclude backend diagnostics', async () => {
  for (const point of ['add', 'enqueue']) for (const afterMutation of [false, true]) {
    const h = await harness();
    if (afterMutation) h.fake.loseReply = point;
    else h.fake.hook = args => { if (args[0] === point) throw new Error('SECRET raw output'); };
    await assert.rejects(h.submit(), e => String(e).includes('UNKNOWN') && !String(e).includes('SECRET'));
    h.fake.hook = undefined; await h.start();
    assert.equal((await h.status())[0].phase, 'ADMISSION_UNKNOWN');
    await assert.rejects(h.cancel(), /UNKNOWN/);
    assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 1);
    if (point === 'enqueue') assert.ok(afterMutation ? h.fake.tasks[0].status.Running : h.fake.tasks[0].status.Stashed);
    if (point === 'add' && afterMutation) assert.ok(h.fake.tasks[0].status.Stashed);
  }
});

test('ordinary work uses a stable private session group with two slots, never default or caller-selected groups', async () => {
  const h = await harness();
  const group = sessionGroup(ns, { session: h.session, file: h.file, anchor: null });
  assert.match(group, /^pi-session-[a-f0-9-]+$/);
  assert.doesNotMatch(group, /origin|sessions/);
  await h.submit(); await h.submit(); await h.submit();
  assert.deepEqual((await h.status()).map(s => s.phase), ['RUNNING', 'RUNNING', 'QUEUED']);
  assert.equal(h.fake.groups.size, 1);
  assert.deepEqual(h.fake.groups.get(group), { status: 'Running', parallel_tasks: 2 });
  assert.ok(Object.values(h.fake.tasks).every(t => t.group === group));
  assert.equal(h.fake.calls.filter(a => a[0] === 'group' && a[1] === 'add').length, 1);
  await h.start();
  // Tree branches share the session budget even when they cannot see old jobs.
  h.history = []; await h.events.get('session_tree')({}, h.ctx); await h.submit();
  assert.equal(h.fake.tasks[3].group, group);
  assert.equal(h.fake.tasks[3].status.Queued !== undefined, true);
  h.session = 'another-session'; h.file = '/sessions/another.jsonl'; h.history = [];
  await h.start(); await h.submit();
  assert.notEqual(h.fake.tasks[4].group, group);
  assert.equal((await h.status())[0].phase, 'RUNNING', 'another session is not blocked by this one');
  assert.equal(h.fake.groups.size, 2);
  assert.notEqual(sessionGroup(ns, { session: 'origin', file: '/copy.jsonl', anchor: null }), group);
  assert.notEqual(sessionGroup('other-namespace', { session: 'origin', file: '/sessions/origin.jsonl', anchor: null }), group);
  assert.equal(sessionGroup(ns, { session: 'origin', file: '/sessions/origin.jsonl', anchor: 'other-branch' }), group);
  assert.match(h.tools.get('pueue_submit').description, /2 concurrent jobs, not a global limit/);
});

test('session groups fail closed on unexpected state or lost creation replies, never reset limits or enqueue work', async () => {
  for (const mode of ['malformed', 'bad-schema', 'wrong-limit', 'bad-status', 'lost-reply', 'refused']) {
    const h = await harness();
    const group = sessionGroup(ns, { session: h.session, file: h.file, anchor: null });
    if (mode === 'wrong-limit') h.fake.groups.set(group, { status: 'Running', parallel_tasks: 4 });
    if (mode === 'bad-status') h.fake.groups.set(group, { status: 'Unknown', parallel_tasks: 2 });
    const run = h.fake.run.bind(h.fake);
    h.fake.run = async args => {
      if (args[0] === 'group' && args[1] === '--json' && mode === 'malformed') return 'SECRET invalid';
      if (args[0] === 'group' && args[1] === '--json' && mode === 'bad-schema') return '[]';
      if (args[0] === 'group' && args[1] === 'add' && mode === 'refused') return 'SECRET refused';
      const reply = await run(args);
      if (args[0] === 'group' && args[1] === 'add' && mode === 'lost-reply') throw new Error('SECRET lost reply');
      return reply;
    };
    await assert.rejects(h.submit(), e => /UNKNOWN/.test(String(e)) && !/SECRET/.test(String(e)));
    await h.start();
    assert.equal(h.fake.calls.filter(a => a[0] === 'add' || a[0] === 'enqueue' || a[0] === 'parallel').length, 0);
    assert.equal((await h.status())[0].phase, 'ADMISSION_UNKNOWN');
    assert.ok(h.fake.calls.filter(a => a[0] === 'group' && a[1] === 'add').length <= 1);
  }
});

test('an existing paused session group stays paused, and legacy default-group jobs are never moved', async () => {
  const h = await harness();
  const group = sessionGroup(ns, { session: h.session, file: h.file, anchor: null });
  h.fake.groups.set(group, { status: 'Paused', parallel_tasks: 2 });
  h.fake.tasks[99] = { id: 99, group: 'default', created_at: '2026-10-22T00:00:00Z', label: 'legacy', status: { Queued: {} } };
  await h.submit();
  assert.equal((await h.status())[0].phase, 'QUEUED');
  assert.deepEqual(h.fake.groups.get(group), { status: 'Paused', parallel_tasks: 2 });
  assert.equal(h.fake.tasks[99].group, 'default');
  assert.equal(h.fake.calls.filter(a => ['switch', 'parallel', 'start', 'restart', 'remove'].includes(a[0])).length, 0);
});

test('backend-owned duplicate reservations reject a second paid pass, including another session; no reservation cleanup/takeover', async () => {
  const h = await harness(); await h.submit({ reservationKey: 'generic-project:change:pass' });
  await assert.rejects(h.submit({ reservationKey: 'generic-project:change:pass' }), /UNKNOWN/);
  h.session = 'another-session'; h.file = '/sessions/another.jsonl'; h.history = [];
  await h.start();
  await assert.rejects(h.submit({ reservationKey: 'generic-project:change:pass' }), /UNKNOWN/);
  assert.equal(h.fake.calls.filter(a => a[0] === 'add').length, 1);
  assert.equal(h.fake.groups.size, 1);
});

test('completion triggers a follow-up on resume once; uncertainty stays passive and never injects user authorization', async () => {
  const h = await harness(); await h.submit(); h.fake.finish(0, { Failed: 7 });
  await h.start(); await h.start();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].customType, NOTICE);
  assert.deepEqual(h.messages[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.match(h.messages[0].content, /"exitCode":7/);
  assert.deepEqual(JSON.parse(h.messages[0].content), { nonce: h.job().nonce, id: 0, phase: 'EXITED', exitCode: 7 });
  assert.match(h.tools.get('pueue_status').description, /not CI\/review\/publication success/);
  h.fake.tasks = {}; await h.start(); await h.start();
  assert.equal(h.messages.length, 2); assert.match(h.messages[1].content, /UNKNOWN/);
  assert.deepEqual(h.messages[1].options, { deliverAs: 'followUp', triggerTurn: false });
});

test('session switch/fork/tree excludes other owners and abandoned branches; delayed query never routes to current unrelated session', async () => {
  const h = await harness(); await h.submit();
  const original = structuredClone(h.history);
  h.fake.finish(0, 'Success');
  h.session = 'fork'; h.file = '/sessions/fork.jsonl'; await h.start();
  assert.deepEqual(await h.status(), []); assert.equal(h.messages.length, 0);
  h.session = 'origin'; h.file = '/sessions/origin.jsonl'; h.history = [];
  await h.events.get('session_tree')({}, h.ctx);
  assert.deepEqual(await h.status(), []); assert.equal(h.messages.length, 0);
  h.history = original;
  let release, entered;
  const entry = new Promise(r => entered = r);
  h.fake.hook = args => { if (args[0] === 'status') { entered(); return new Promise(r => release = r); } };
  const starting = h.start(); await entry;
  h.stop(); h.session = 'unrelated'; h.file = '/sessions/unrelated.jsonl'; h.history = [];
  release(); await starting;
  assert.equal(h.messages.length, 0);
  h.fake.hook = undefined; h.session = 'origin'; h.file = '/sessions/origin.jsonl'; h.history = original;
  await h.start(); assert.equal(h.messages.length, 1);
});

test('closing during admission retains nonce without routing metadata or cancelling job in a different session', async () => {
  const h = await harness();
  let release, entered;
  const entry = new Promise(r => entered = r);
  h.fake.hook = args => { if (args[0] === 'add') { entered(); return new Promise(r => release = r); } };
  const submitted = h.submit(); await entry;
  const original = h.history;
  h.stop(); h.session = 'new'; h.file = '/sessions/new.jsonl'; h.history = [];
  release(); await assert.rejects(submitted, /UNKNOWN/);
  assert.deepEqual(h.history, []); assert.equal(original.length, 1);
  assert.ok(h.fake.tasks[0].status.Stashed);
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 0);
});

test('bounded log tail preserves final errors, exact offsets and full artifact; never infers completion; no symlink following', async () => {
  const h = await harness(); await h.submit();
  const path = join(h.config.data, 'task_logs', '0.log');
  const body = 'x'.repeat(100000) + '\nFINAL ERROR: uncertain publication\n';
  await writeFile(path, body);
  const response = await h.call('pueue_result', { nonce: h.job().nonce });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.status.phase, 'RUNNING'); assert.match(data.log.text, /FINAL ERROR/);
  assert.equal(Buffer.byteLength(data.log.text), 4096); assert.equal(data.log.omittedBefore, true);
  assert.equal('omittedAfter' in data.log, false); assert.equal(data.log.path, path);
  const larger = JSON.parse((await h.call('pueue_result', { nonce: h.job().nonce, limit: 16384 })).content[0].text);
  assert.equal(Buffer.byteLength(larger.log.text), 16384); assert.match(larger.log.text, /FINAL ERROR/);
  const head = await sliceLog(path, 0, 50); assert.equal(head.text.length, 50); assert.equal(head.omittedAfter, true);
  assert.equal((await readFile(path, 'utf8')).length, body.length);
  await assert.rejects(sliceLog(path, -1)); await assert.rejects(sliceLog(path, undefined, 16385));
  await symlink(path, join(h.config.data, 'link')); await assert.rejects(sliceLog(join(h.config.data, 'link')));
});

test('status filters retain unresolved identities and reject non-owned nonces without deleting history', async () => {
  const h = await harness();
  await h.submit(); const first = h.job().nonce;
  await h.submit(); const second = h.job().nonce;
  await h.submit(); const third = h.job().nonce;
  h.fake.finish(0, 'Success'); delete h.fake.tasks[2];
  assert.equal((await h.status()).length, 3);
  assert.deepEqual((await h.status({ state: 'active' })).map(r => r.nonce), [second, third]);
  assert.deepEqual((await h.status({ state: 'finished' })).map(r => r.nonce), [first]);
  assert.deepEqual(await h.status({ nonce: third }), [{ nonce: third, id: 2, phase: 'UNKNOWN' }]);
  assert.deepEqual(await h.status({ nonce: first, state: 'active' }), []);
  await assert.rejects(h.status({ nonce: 'another-session-nonce' }), /not owned/);
  assert.equal((await h.status()).length, 3);
});

test('compact payload upgrades preserve legacy notice dedup keys and meaningful cancellation changes', async () => {
  const h = await harness(); await h.submit(); h.fake.finish(0, 'Success');
  const j = h.job();
  h.history.push({ type: 'custom_message', customType: NOTICE,
    content: JSON.stringify({ nonce: j.nonce, id: 0, phase: 'EXITED', exitCode: 0, cancellationRequested: false,
      publication: 'UNVERIFIED', stoppedDescendants: 'UNVERIFIED' }) + '\nOld caveat',
    details: { key: `${j.nonce}:EXITED:0:false` } });
  await h.start(); assert.equal(h.messages.length, 0);
  await h.cancel(); // Intent only: already exited, no signal. A changed intent deserves a new notice.
  await h.start(); assert.equal(h.messages.length, 1);
  assert.equal(JSON.parse(h.messages[0].content).cancellationRequested, true);
  assert.equal(h.messages[0].options.triggerTurn, false); // Known completion, new intent is passive.
  assert.equal(h.fake.calls.filter(a => a[0] === 'kill').length, 0);
  await h.start(); assert.equal(h.messages.length, 1);
});

test('log results report fresh backend status after reading and keep tiny artifacts compact', async () => {
  const h = await harness(); await h.submit();
  const path = join(h.config.data, 'task_logs', '0.log'); await writeFile(path, 'small final error\n');
  let queries = 0;
  h.fake.hook = args => { if (args[0] === 'status' && ++queries === 2) h.fake.finish(0, { Failed: 7 }); };
  const data = JSON.parse((await h.call('pueue_result', { nonce: h.job().nonce })).content[0].text);
  assert.deepEqual(data.status, { nonce: h.job().nonce, id: 0, phase: 'EXITED', exitCode: 7 });
  assert.deepEqual(data.log, { path, start: 0, end: 18, size: 18, text: 'small final error\n' });
});

test('private callback hints validate numeric IDs, never interpolate logs/commands; duplicate wakeups are coalesced', async () => {
  const { dir, config } = await fixture();
  const hints = join(dir, 'hints'); await mkdir(hints, { mode: 0o700 });
  await privateDirectory(hints); await hint(hints, '123');
  assert.equal(await readFile(join(hints, 'wake'), 'utf8'), '123\n');
  await assert.rejects(hint(hints, '1; bad')); await assert.rejects(hint(hints, '../path'));
  await chmod(hints, 0o755); await assert.rejects(privateDirectory(hints)); await assert.rejects(hint(hints, '1'));
  await chmod(hints, 0o700);
  const h = await harness({ config: { ...config, hints } }); await h.submit();
  h.fake.finish(0, 'Success');
  await Promise.all(Array.from({ length: 5 }, () => hint(hints, '0')));
  for (let i = 0; i < 30 && !h.messages.length; i++) await delay(20);
  assert.equal(h.messages.length, 1);
  await hint(hints, '0'); await delay(200);
  assert.equal(h.messages.length, 1);
  h.stop(); await hint(hints, '0');
});

test('receipt precedes triggerTurn: delayed message persistence, reload and trigger feedback cannot replay a completion', async () => {
  const h = await harness({ delayedDelivery: true });
  await h.submit(); h.fake.finish(0, 'Success');
  let feedback;
  h.onSend = () => {
    assert.equal(h.history.at(-1).customType, RECEIPT);
    // A trigger can initiate work before the message itself is in getBranch().
    feedback = h.status();
  };
  await h.start();
  await feedback;
  assert.equal(h.messages.length, 1);
  assert.equal(h.history.some(e => e.type === 'custom_message'), false);
  for (let i = 0; i < 5; i++) await h.start();
  assert.equal(h.messages.length, 1);
  // Recreate the extension runtime from JSON-roundtripped supported entries.
  const restored = await harness({ history: JSON.parse(JSON.stringify(h.history)), fake: h.fake,
    config: h.config, delayedDelivery: true });
  assert.equal(restored.messages.length, 0);
  assert.equal(restored.fake.calls.filter(a => a[0] === 'add').length, 1);
  assert.equal((await restored.status())[0].exitCode, 0);
});

test('lost callback reconciles on explicit status, repeated callbacks before message persistence do not pay for more turns', async () => {
  const { dir, config } = await fixture();
  const hints = join(dir, 'hints'); await mkdir(hints, { mode: 0o700 });
  const h = await harness({ config: { ...config, hints }, delayedDelivery: true });
  await h.submit(); await delay(150); // Drain admission reconciliation while RUNNING.
  h.fake.finish(0, { Failed: 7 });
  await h.status(); await delay(150);
  assert.equal(h.messages.length, 1);
  await hint(hints, '0'); await delay(150);
  await hint(hints, '0'); await delay(150);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options.triggerTurn, true);
  h.stop(); await hint(hints, '0'); await delay(150);
  assert.equal(h.messages.length, 1);
});

test('receipt and delayed backend response cannot grant fork or abandoned branch ownership', async () => {
  const h = await harness({ delayedDelivery: true });
  await h.submit(); h.fake.finish(0, 'Success'); await h.start();
  const received = structuredClone(h.history);
  h.session = 'fork'; h.file = '/sessions/fork.jsonl'; await h.start();
  assert.deepEqual(await h.status(), []);
  assert.equal(h.messages.length, 1);
  h.session = 'origin'; h.file = '/sessions/origin.jsonl'; h.history = [];
  await h.events.get('session_tree')({}, h.ctx);
  assert.deepEqual(await h.status(), []);
  h.history = received; await h.events.get('session_tree')({}, h.ctx);
  assert.equal(h.messages.length, 1);
});
