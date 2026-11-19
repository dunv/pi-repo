// No daemon, model calls, real project toolchains or live extension/settings changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, chmod, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initiatorLabel, prepare, prepareRevision, attemptDirectory, validateInput, verificationProfile, snapshot, sourceSnapshot, writable, json, save, envFor } from '../core.mjs';
import { run } from '../run.mjs';
import { check } from '../check.mjs';
import { toolSummary } from '../progress.mjs';
import { INVALID_TOOL_ARTIFACT } from '../invalid-tools.mjs';

// Always exercise the real host loader; allow an explicit SDK override.
const sdk = process.env.PI_TEST_SDK ?? new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url).pathname;

const executable = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const gitBin = executable('git'), flock = executable('flock');
const namespace = randomUUID();
const input = repo => ({ repo, namespace, brief: 'Mechanical: change source.txt only. Accept when its content is updated. Self-review the diff.',
  model: 'fixture/model', thinking: 'low', profile: 'fixture', checks: [{ kind: 'test', targets: ['//:ok'] }] });
const who = { session: 'fixture-session', file: '/fixture/session.jsonl' };
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-delegate-')), repo = join(dir, 'repo with spaces');
  const git = (...args) => execFileSync(gitBin, ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    execFileSync(gitBin, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'original\n');
    await writeFile(join(repo, '.gitignore'), 'ignored\n');
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
    const pi = join(dir, 'fake-pi'), verifier = join(dir, 'fake-verifier');
    await writeFile(pi, `#!${process.execPath}\nconst fs=require('node:fs');
const priorSource=fs.readFileSync('source.txt','utf8');
fs.writeFileSync('source.txt','worker changed\\n'); fs.writeFileSync('new.txt','new\\n');
fs.writeFileSync(${JSON.stringify(join(dir, 'pi-argv.json'))}, JSON.stringify({args:process.argv.slice(2),priorSource,secret:process.env.UNAPPROVED_TOKEN,cwd:process.cwd()}));
console.log('Worker self-review: changes made, main-agent review required.');\n`, { mode: 0o700 });
    await writeFile(verifier, `#!${process.execPath}\nconst fs=require('node:fs');
console.log(JSON.stringify({args:process.argv.slice(2),secret:process.env.UNAPPROVED_TOKEN}));
if(process.argv.includes('//:mutate')) fs.writeFileSync('source.txt','check mutated source\\n');
if(process.argv.includes('//:fail')) process.exit(7);\n`, { mode: 0o700 });
    const runtime = { git: gitBin, profiles: { fixture: { command: verifier, args: ['--workspace={worktree}', '--output={outputBase}', '{kind}', '{targets}'] } }, pi, node: process.execPath, flock, ssh: '/fixture/batch-ssh', launcher: '/fixture/launcher', revisionProtocol: 1,
      home: dir, state: join(dir, 'state'), path: process.env.PATH };
    const runtimePath = join(dir, 'runtime.json'); await save(runtimePath, runtime);
    await fn({ dir, repo, git, runtime, runtimePath });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function guardedFakePi(f, marker) {
  return writeFile(f.runtime.pi, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
const directory=path.dirname(process.argv[process.argv.indexOf('--session-dir')+1]);
fs.writeFileSync('source.txt','partial work retained\\n');
fs.writeFileSync(path.join(directory,${JSON.stringify(INVALID_TOOL_ARTIFACT)}),${JSON.stringify(marker)});
console.log('Partial report retained.');\n`, { mode: 0o700 });
}
const guardRecord = JSON.stringify({ schemaVersion: 1, reason: 'invalid-tool-limit', limit: 3, count: 3, tools: ['run', 'run', 'glob'] });

test('runner preserves evidence/work and rejects exit-zero Pi after a guard marker, including malformed evidence', () => fixture(async f => {
  for (const marker of [guardRecord, 'malformed']) {
    const task = await prepare(input(f.repo), f.runtime, who);
    await guardedFakePi(f, marker);
    assert.equal(await run(f.runtimePath, task.id), 1);
    const result = await json(join(task.directory, 'result.json'));
    assert.equal(result.code, 1); assert.equal(result.workerCode, 0);
    assert.equal(result.failureReason, marker === guardRecord ? 'invalid-tool-limit' : 'invalid-tool-evidence');
    assert.equal(result.accepted, false);
    assert.ok(result.fingerprint);
    assert.equal(await readFile(join(task.directory, 'report.md'), 'utf8'), 'Partial report retained.\n');
    assert.equal(await readFile(join(task.directory, INVALID_TOOL_ARTIFACT), 'utf8'), marker);
    assert.equal(await readFile(join(task.worktree, 'source.txt'), 'utf8'), 'partial work retained\n');
    assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'original\n');
  }
}));

test('guard failures are revision-local and never overwrite prior successful attempt evidence', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  assert.equal(await run(f.runtimePath, task.id), 0);
  const originalResult = await readFile(join(task.directory, 'result.json'), 'utf8');
  const revision = await prepareRevision({ ...task, nonce: 'prior' }, { expectedNonce: 'prior',
    expectedFingerprint: await snapshot(task, f.runtime), brief: 'Small explicit revision.', model: 'fixture/model', thinking: 'low' }, f.runtime);
  await guardedFakePi(f, guardRecord);
  assert.equal(await run(f.runtimePath, task.id, revision.attempt), 1);
  const directory = attemptDirectory(task, revision.attempt), result = await json(join(directory, 'result.json'));
  assert.equal(result.failureReason, 'invalid-tool-limit');
  assert.equal(result.workerCode, 0); assert.equal(result.code, 1);
  assert.equal(await readFile(join(task.directory, 'result.json'), 'utf8'), originalResult);
  await assert.rejects(readFile(join(task.directory, INVALID_TOOL_ARTIFACT)), /ENOENT/);
  assert.equal(await readFile(join(directory, INVALID_TOOL_ARTIFACT), 'utf8'), guardRecord);
}));

test('worker startup rejects a now-disallowed Pi route before model launch or one-shot claim', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await writeFile(f.runtimePath, JSON.stringify({ ...f.runtime, piModelPolicy: { fixture: { other: ['medium'] } } }));
  await assert.rejects(run(f.runtimePath, task.id), /excluded by delegate model policy/);
  await assert.rejects(readFile(join(task.directory, 'started.json')), /ENOENT/);
  await assert.rejects(readFile(join(f.dir, 'pi-argv.json')), /ENOENT/);
  assert.equal(await readFile(join(task.worktree, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(f.git('status', '--porcelain'), '');
}));

test('tool previews show bounded call details without file bodies or terminal controls', () => {
  assert.equal(toolSummary('read', { path: 'docs/file.md', offset: 10, limit: 20, secret: 'HIDDEN' }),
    '{"path":"docs/file.md","offset":10,"limit":20}');
  assert.equal(toolSummary('grep', { pattern: 'TODO', path: 'src', literal: true }),
    '{"pattern":"TODO","path":"src","literal":true}');
  assert.equal(toolSummary('delegate_check', { index: 0 }), '{"index":0}');
  assert.equal(toolSummary('write', { path: 'file', content: 'PRIVATE' }), '{"path":"file","bytes":7}');
  assert.equal(toolSummary('edit', { path: 'file', edits: [{ oldText: 'PRIVATE', newText: 'HIDDEN' }] }),
    '{"path":"file","replacements":1}');
  assert.equal(toolSummary('unknown', { secret: 'HIDDEN' }), '{}');
  const escaped = toolSummary('read', { path: '\n\x1b[31m\u202e' });
  assert.doesNotMatch(escaped, /[\n\x1b\u202e]/);
  assert.ok(toolSummary('grep', { pattern: 'x'.repeat(10000), path: 'y'.repeat(10000), glob: 'z'.repeat(10000) }).length <= 401);
});

test('bounded explicit input: no fuzzy models, shell, flags or missing thinking', () => {
  validateInput(input('/fixture/repo'));
  for (const override of [{ repo: 'relative' }, { model: 'model' }, { thinking: undefined },
    { checks: [{ kind: 'test', targets: ['--run_under=sh'] }] }, { checks: [{ kind: 'test', targets: ['//:ok; touch /tmp/no'] }] },
    { checks: [{ kind: 'shell', targets: ['//:ok'] }] }]) assert.throws(() => validateInput({ ...input('/fixture/repo'), ...override }));
});

test('initiator labels are bounded path-safe names plus stable distinct session identity', () => {
  assert.match(initiatorLabel(who), /^session-s[a-f0-9]{8}$/);
  assert.equal(initiatorLabel({ session: '1234abcd-1234-1234-1234-123456789abc', name: 'Cart fixes' }), 'cart-fixes-s1234abcd');
  const owner = { ...who, name: '  Fix Checkout / Carts!  ' };
  assert.match(initiatorLabel(owner), /^fix-checkout-carts-s[a-f0-9]{8}$/);
  assert.equal(initiatorLabel(owner), initiatorLabel(owner));
  assert.notEqual(initiatorLabel(owner), initiatorLabel({ ...owner, session: 'other-session' }));
  for (const name of ['../outside/$(cmd)\u001b\n', '🚀', 'x'.repeat(500), '.git']) {
    const label = initiatorLabel({ ...who, name });
    assert.match(label, /^[a-z0-9-]+-s[a-f0-9]{8}$/);
    assert.ok(label.length <= 38); assert.doesNotMatch(label, /[/.\s]/);
  }
});

test('new worktree suffix exposes initiator and retains full UUID without renaming revisions', () => fixture(async f => {
  const owner = { ...who, name: 'Fix checkout / totals' }, task = await prepare(input(f.repo), f.runtime, owner);
  assert.equal(task.initiatorLabel, initiatorLabel(owner));
  assert.equal(task.worktree, join(f.repo + '.worktrees', `delegate-${task.initiatorLabel}-${task.id}`));
  assert.deepEqual((await json(join(task.directory, 'task.json'))).owner, owner);
  const revision = await prepareRevision({ ...task, nonce: 'prior' }, { expectedNonce: 'prior',
    expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise.', model: 'fixture/model', thinking: 'low' }, f.runtime);
  assert.equal(revision.worktree, task.worktree); assert.equal(revision.initiatorLabel, task.initiatorLabel);
}));

test('prepare retains isolated uncommitted worktree, exact base and durable identity; parent unchanged', () => fixture(async f => {
  const head = f.git('rev-parse', 'HEAD').trim(), task = await prepare(input(f.repo), f.runtime, who);
  assert.equal(task.base, head); assert.equal(task.worktree.startsWith(f.repo + '.worktrees/'), true);
  assert.deepEqual(await json(join(task.directory, 'task.json')), task);
  assert.equal(await readFile(join(task.directory, 'brief.md'), 'utf8'), input(f.repo).brief);
  assert.equal(f.git('status', '--porcelain'), '');
  await writeFile(join(task.worktree, 'source.txt'), 'worker only\n');
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'original\n');
  assert.notEqual(await snapshot(task, f.runtime), head);
}));

test('verification profiles are explicit, validated and frozen per task', () => fixture(async f => {
  const profile = f.runtime.profiles.fixture;
  for (const invalid of [undefined, { ...profile, command: 'relative' },
    { ...profile, args: ['{targets}', '{targets}'] }, { ...profile, args: ['prefix{targets}'] },
    { ...profile, args: ['{unknown}', '{targets}'] }, { ...profile, args: ['bad\narg', '{targets}'] }]) {
    assert.throws(() => verificationProfile(invalid), /Verification profile/);
  }
  await assert.rejects(prepare({ ...input(f.repo), profile: 'missing' }, f.runtime, who), /Verification profile/);
  assert.equal(f.git('branch', '--list', 'delegate/*'), '');
  const spec = { ...input(f.repo), checks: [{ kind: 'build', targets: ['src/unit.test.ts', 'package:test'] }] };
  const task = await prepare(spec, f.runtime, who);
  assert.deepEqual(task.verification, profile);
  // Later runtime configuration must not replan an admitted task's command.
  const altered = { ...f.runtime, profiles: { fixture: { command: '/missing-command', args: ['{targets}'] } } };
  await writeFile(f.runtimePath, JSON.stringify(altered));
  assert.equal(await check(f.runtimePath, task.id, 0), 0);
  const name = (await readdir(task.directory)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(task.directory, name));
  const log = JSON.parse(await readFile(record.log, 'utf8'));
  assert.deepEqual(log.args.slice(-3), ['build', 'src/unit.test.ts', 'package:test']);
}));

test('dirty source snapshot preserves working contents and source staging, with worker-only diffs', () => fixture(async f => {
  const head = f.git('rev-parse', 'HEAD').trim();
  await writeFile(join(f.repo, 'source.txt'), 'staged version\n'); f.git('add', 'source.txt');
  await writeFile(join(f.repo, 'source.txt'), 'working version\n');
  await writeFile(join(f.repo, 'staged.txt'), 'staged addition\n'); f.git('add', 'staged.txt');
  await writeFile(join(f.repo, 'binary\nname'), Buffer.from([0, 255, 42]));
  await writeFile(join(f.repo, 'executable'), '#!/bin/sh\n'); await chmod(join(f.repo, 'executable'), 0o755);
  await symlink('source.txt', join(f.repo, 'link'));
  await writeFile(join(f.repo, 'ignored'), 'cache');
  const before = await sourceSnapshot(f.repo, f.runtime), status = f.git('status', '--porcelain'), index = f.git('diff', '--cached', '--binary');
  const task = await prepare(input(f.repo), f.runtime, who);
  assert.equal(task.sourceHead, head); assert.notEqual(task.base, head);
  assert.equal(task.sourceFingerprint, before); assert.equal(await sourceSnapshot(f.repo, f.runtime), before);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head); assert.equal(f.git('status', '--porcelain'), status);
  assert.equal(f.git('diff', '--cached', '--binary'), index);
  assert.equal(await readFile(join(task.worktree, 'source.txt'), 'utf8'), 'working version\n');
  assert.equal(await readFile(join(task.worktree, 'staged.txt'), 'utf8'), 'staged addition\n');
  assert.deepEqual(await readFile(join(task.worktree, 'binary\nname')), Buffer.from([0, 255, 42]));
  assert.equal(await readlink(join(task.worktree, 'link')), 'source.txt');
  await assert.rejects(readFile(join(task.worktree, 'ignored')), /ENOENT/);
  const workerGit = (...args) => execFileSync(gitBin, ['-C', task.worktree, ...args], { encoding: 'utf8' });
  assert.equal(workerGit('status', '--porcelain'), '');
  assert.match(workerGit('ls-files', '--stage', 'executable'), /^100755 /);
  await writeFile(join(task.worktree, 'source.txt'), 'worker changed\n');
  await writeFile(join(task.worktree, 'staged.txt'), 'worker modified inherited addition\n');
  const patch = workerGit('diff', 'HEAD');
  assert.match(patch, /-working version/); assert.match(patch, /-staged addition/);
  assert.doesNotMatch(patch, /staged version|binary|executable|original/);
  assert.equal(await sourceSnapshot(f.repo, f.runtime), before);
  const revision = await prepareRevision({ ...task, nonce: 'prior' }, { expectedNonce: 'prior',
    expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise.', model: 'fixture/model', thinking: 'low' }, f.runtime);
  assert.equal(revision.base, task.base); assert.equal(revision.sourceFingerprint, before);
}));

test('staged/unstaged deletions, renames and forced ignored additions survive snapshots', () => fixture(async f => {
  await writeFile(join(f.repo, 'delete-staged'), 'old'); await writeFile(join(f.repo, 'delete-working'), 'old');
  f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'files');
  f.git('rm', '-q', 'delete-staged'); await rm(join(f.repo, 'delete-working'));
  f.git('mv', 'source.txt', 'renamed.txt');
  await writeFile(join(f.repo, 'ignored'), 'forced addition'); f.git('add', '-f', 'ignored');
  const before = await sourceSnapshot(f.repo, f.runtime), task = await prepare(input(f.repo), f.runtime, who);
  for (const name of ['delete-staged', 'delete-working', 'source.txt']) await assert.rejects(readFile(join(task.worktree, name)), /ENOENT/);
  assert.equal(await readFile(join(task.worktree, 'renamed.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(task.worktree, 'ignored'), 'utf8'), 'forced addition');
  assert.equal(await sourceSnapshot(f.repo, f.runtime), before);
}));

test('ignored caches do not change the baseline; workers see the frozen dirty handoff', () => fixture(async f => {
  await writeFile(join(f.repo, 'ignored'), 'cache');
  const clean = await prepare(input(f.repo), f.runtime, who);
  assert.equal(clean.base, clean.sourceHead);
  await writeFile(join(f.repo, 'source.txt'), 'handoff version\n');
  const task = await prepare(input(f.repo), f.runtime, who);
  await writeFile(join(f.repo, 'source.txt'), 'parent continued\n');
  assert.notEqual(await sourceSnapshot(f.repo, f.runtime), task.sourceFingerprint);
  assert.equal(await run(f.runtimePath, task.id), 0);
  assert.equal((await json(join(f.dir, 'pi-argv.json'))).priorSource, 'handoff version\n');
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'parent continued\n');
}));

test('conflicted indexes and assume-unchanged entries fail closed without changing source', () => fixture(async f => {
  f.git('update-index', '--assume-unchanged', 'source.txt');
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /assume-unchanged/);
  f.git('update-index', '--no-assume-unchanged', 'source.txt');
  const blob = f.git('rev-parse', 'HEAD:source.txt').trim();
  execFileSync(gitBin, ['-C', f.repo, 'update-index', '--index-info'], { input: `0 ${'0'.repeat(40)}\tsource.txt\n100644 ${blob} 1\tsource.txt\n100644 ${blob} 2\tsource.txt\n100644 ${blob} 3\tsource.txt\n` });
  const before = f.git('ls-files', '--unmerged');
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /conflicts/);
  assert.equal(f.git('ls-files', '--unmerged'), before);
  assert.equal(f.git('branch', '--list', 'delegate/*'), '');
}));

test('staging-only differences retain source index but do not become worker changes', () => fixture(async f => {
  await writeFile(join(f.repo, 'source.txt'), 'index version\n'); f.git('add', 'source.txt');
  await writeFile(join(f.repo, 'source.txt'), 'original\n');
  const before = await sourceSnapshot(f.repo, f.runtime), cached = f.git('diff', '--cached');
  const task = await prepare(input(f.repo), f.runtime, who);
  assert.equal(task.base, task.sourceHead);
  assert.equal(await sourceSnapshot(f.repo, f.runtime), before);
  assert.equal(f.git('diff', '--cached'), cached);
  f.git('add', 'source.txt');
  assert.notEqual(await sourceSnapshot(f.repo, f.runtime), before, 'Staging changes count as drift even with identical working files');
}));

test('oversized new source fails before worktree creation without staging parent files', () => fixture(async f => {
  await writeFile(join(f.repo, 'large'), Buffer.alloc(64 * 1024 * 1024 + 1));
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /oversized/i);
  assert.equal(f.git('branch', '--list', 'delegate/*'), '');
  assert.equal(f.git('diff', '--cached'), '');
}));

test('source movement during preparation retains evidence but never returns an admissible task', () => fixture(async f => {
  const wrapper = join(f.dir, 'git-wrapper');
  await writeFile(wrapper, `#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2); const result=cp.spawnSync(${JSON.stringify(gitBin)},args,{stdio:'inherit'});
if(args.includes('worktree') && args.includes('add')) fs.writeFileSync(${JSON.stringify(join(f.repo, 'source.txt'))},'concurrent parent edit\\n');
process.exit(result.status ?? 1);\n`, { mode: 0o700 });
  await assert.rejects(prepare(input(f.repo), { ...f.runtime, git: wrapper }, who), /Source changed during preparation/);
  const directories = await readdir(f.runtime.state); assert.equal(directories.length, 1);
  const retained = await json(join(f.runtime.state, directories[0], 'task.json'));
  assert.equal(await readFile(join(retained.worktree, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'concurrent parent edit\n');
  await assert.rejects(readFile(join(retained.directory, 'submission.json')), /ENOENT/);
}));

test('linked source worktrees with split indexes keep their own index and effective working state', () => fixture(async f => {
  const linked = join(f.dir, 'linked'); f.git('worktree', 'add', '-qb', 'parent', linked);
  const git = (...args) => execFileSync(gitBin, ['-C', linked, ...args], { encoding: 'utf8' });
  await writeFile(join(linked, 'source.txt'), 'staged in linked\n'); git('add', 'source.txt');
  git('update-index', '--split-index');
  await writeFile(join(linked, 'source.txt'), 'working in linked\n');
  const before = await sourceSnapshot(linked, f.runtime), task = await prepare(input(linked), f.runtime, who);
  assert.equal(await sourceSnapshot(linked, f.runtime), before);
  assert.equal(await readFile(join(task.worktree, 'source.txt'), 'utf8'), 'working in linked\n');
  assert.match(git('diff', '--cached'), /staged in linked/);
  assert.equal(f.git('status', '--porcelain'), '');
}));

test('embedded repositories and sparse entries are rejected instead of silently losing source', () => fixture(async f => {
  f.git('update-index', '--skip-worktree', 'source.txt');
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /sparse/);
  f.git('update-index', '--no-skip-worktree', 'source.txt');
  const nested = join(f.repo, 'nested'); execFileSync(gitBin, ['init', '-q', nested]);
  await writeFile(join(nested, 'file'), 'nested');
  execFileSync(gitBin, ['-C', nested, 'add', '.']);
  execFileSync(gitBin, ['-C', nested, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'nested']);
  await assert.rejects(prepare(input(f.repo), f.runtime, who), /Unsupported\/oversized|embedded repositories/);
  assert.equal(f.git('diff', '--cached'), '');
}));

test('write boundary rejects traversal, protected configuration and symlink escapes', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await writable(task, 'new/nested/source.go');
  for (const path of ['../other', '.git', '.pi/settings.json', '.agents/policy.md']) await assert.rejects(writable(task, path));
  await symlink(f.dir, join(task.worktree, 'outside'));
  await assert.rejects(writable(task, 'outside/secret'), /symlink/);
  await symlink(join(task.worktree, '.git'), join(task.worktree, 'git-link'));
  await assert.rejects(writable(task, 'git-link'), /symlink/);
}));

test('fake worker: fresh persistent session, explicit model/thinking, minimal environment, one-shot execution', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  process.env.UNAPPROVED_TOKEN = 'fixture-never-forward';
  try { assert.equal(await run(f.runtimePath, task.id), 0); } finally { delete process.env.UNAPPROVED_TOKEN; }
  const invocation = await json(join(f.dir, 'pi-argv.json'));
  assert.equal(invocation.secret, undefined); assert.equal(invocation.cwd, task.worktree);
  for (const flag of ['--no-extensions', '--no-skills', '--no-approve', '--no-mcp', '--session-dir', '--print']) assert.ok(invocation.args.includes(flag));
  assert.equal(invocation.args[invocation.args.indexOf('--thinking') + 1], 'low');
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'model');
  assert.equal(invocation.args.includes('--no-session'), false);
  assert.equal(invocation.args.join(' ').includes('bash,'), false);
  assert.equal((await json(join(task.directory, 'result.json'))).accepted, false);
  assert.equal(f.git('status', '--porcelain'), '');
  await assert.rejects(run(f.runtimePath, task.id), /clean worktree|EEXIST/);
}));

test('worker output is visible before exit and retained in separate artifacts', () => fixture(async f => {
  const release = join(f.dir, 'release');
  await writeFile(f.runtime.pi, `#!${process.execPath}
const fs = require('node:fs');
console.log('early stdout'); console.error('early stderr');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('final report'); } }, 10);
setTimeout(() => process.exit(9), 5000).unref();
`, { mode: 0o700 });
  const task = await prepare(input(f.repo), f.runtime, who);
  const child = spawn(process.execPath, [new URL('../run.mjs', import.meta.url).pathname, f.runtimePath, task.id],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', released = false;
  const releaseWhenLive = () => {
    if (!released && out.includes('early stdout') && err.includes('early stderr')) {
      assert.equal(child.exitCode, null);
      released = true; void writeFile(release, 'continue');
    }
  };
  child.stdout.on('data', data => { out += data; releaseWhenLive(); });
  child.stderr.on('data', data => { err += data; releaseWhenLive(); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, err); assert.equal(released, true);
  assert.match(out, /Worker starting:.*model=fixture\/model requested-thinking=low/);
  assert.ok(out.includes(`[delegate] Prompt file: ${JSON.stringify(join(task.directory, 'brief.md'))}`));
  assert.ok(!out.includes(input(f.repo).brief));
  assert.equal(await readFile(join(task.directory, 'report.md'), 'utf8'), 'early stdout\nfinal report\n');
  assert.match(await readFile(join(task.directory, 'worker.log'), 'utf8'), /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] early stderr\n$/);
}));

test('dirty task verification: configured literal command, isolated output, source fingerprint and duration', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await writeFile(join(task.worktree, 'source.txt'), 'uncommitted implementation\n');
  assert.equal(await check(f.runtimePath, task.id, 0), 0);
  const recordPath = (await readdir(task.directory)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(task.directory, recordPath));
  assert.equal(record.passed, true); assert.equal(record.before, record.after); assert.ok(record.elapsedMs >= 0);
  const log = JSON.parse(await readFile(record.log, 'utf8'));
  assert.deepEqual(log.args, ['--workspace=' + task.worktree,
    '--output=' + join(task.directory, 'build-output'), 'test', '//:ok']);
  const before = record.after;
  await writeFile(join(task.worktree, 'new.txt'), 'new file must invalidate check\n');
  assert.notEqual(await snapshot(task, f.runtime), before);
}));

test('mutating/failing checks do not pass, unplanned checks never execute', () => fixture(async f => {
  const spec = input(f.repo); spec.checks = [{ kind: 'test', targets: ['//:mutate'] }, { kind: 'test', targets: ['//:fail'] }];
  const task = await prepare(spec, f.runtime, who);
  assert.equal(await check(f.runtimePath, task.id, 0), 1);
  assert.equal(await check(f.runtimePath, task.id, 1), 1);
  await assert.rejects(check(f.runtimePath, task.id, 2), /Unplanned/);
}));

test('foreground continuation commits change the fingerprint and remain reviewable', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who), before = await snapshot(task, f.runtime);
  execFileSync(gitBin, ['-C', task.worktree, '-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '--allow-empty', '-qm', 'foreground continuation']);
  assert.notEqual(await snapshot(task, f.runtime), before);
}));

test('explicit revision reuses dirty source and build state, while retaining per-attempt evidence', t => fixture(async f => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const originalResult = await readFile(join(task.directory, 'result.json'), 'utf8');
  const originalReport = await readFile(join(task.directory, 'report.md'), 'utf8');
  await mkdir(join(task.directory, 'build-output'));
  await writeFile(join(task.directory, 'build-output', 'cache-sentinel'), 'retained cache');
  await writeFile(join(task.worktree, 'source.txt'), 'parent review feedback\n');
  const bound = { ...task, nonce: 'previous-job' };
  const spec = { expectedNonce: bound.nonce, expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise the existing changes.', model: 'fixture/model', thinking: 'minimal' };
  const revision = await prepareRevision(bound, spec, f.runtime), artifacts = attemptDirectory(task, revision.attempt);
  assert.equal(revision.worktree, task.worktree); assert.equal(revision.base, task.base); assert.equal(revision.branch, task.branch);
  assert.equal(revision.nonce, undefined); assert.equal(revision.previousNonce, bound.nonce);
  assert.deepEqual(await json(join(task.directory, 'task.json')), task, 'Original manifest stays immutable');
  assert.equal((await readdir(task.directory)).some(name => name.startsWith('revision-after-')), false, 'No permanent lifecycle/continuation claims');
  assert.equal(await run(f.runtimePath, task.id, revision.attempt), 0);
  const promptLines = logs.map(line => line.replace(/^\[[\dT:.Z-]+\] /, '')).filter(line => line.startsWith('[delegate] Prompt file: '));
  assert.deepEqual(promptLines, [task.directory, artifacts].map(directory =>
    `[delegate] Prompt file: ${JSON.stringify(join(directory, 'brief.md'))}`));
  assert.ok(!logs.join('\n').includes(spec.brief));
  assert.ok(!logs.join('\n').includes(input(f.repo).brief));
  const invocation = await json(join(f.dir, 'pi-argv.json'));
  assert.equal(invocation.priorSource, 'parent review feedback\n');
  assert.equal(invocation.args[invocation.args.indexOf('--thinking') + 1], 'minimal');
  assert.equal(invocation.args[invocation.args.indexOf('--session-dir') + 1], join(artifacts, 'sessions'));
  assert.equal(await readFile(join(task.directory, 'result.json'), 'utf8'), originalResult);
  assert.equal(await readFile(join(task.directory, 'report.md'), 'utf8'), originalReport);
  assert.equal(await readFile(join(task.directory, 'build-output', 'cache-sentinel'), 'utf8'), 'retained cache');
  assert.equal(await check(f.runtimePath, task.id, 0, revision.attempt), 0);
  const name = (await readdir(artifacts)).find(n => /^check-.*\.json$/.test(n) && !n.includes('.intent.'));
  const record = await json(join(artifacts, name));
  const args = JSON.parse(await readFile(record.log, 'utf8')).args;
  assert.ok(args.includes('--output=' + join(task.directory, 'build-output')));
  assert.equal(record.passed, true);
  await writeFile(join(task.worktree, 'source.txt'), 'parent review feedback\n');
  await assert.rejects(run(f.runtimePath, task.id, revision.attempt), /EEXIST/, 'Attempt cannot be launched twice, even at its original fingerprint');
  assert.equal(f.git('status', '--porcelain'), '');
}));

test('revision rejects stale handoffs, staged changes and source movement before worker startup', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const bound = { ...task, nonce: 'previous-job' };
  const spec = { expectedNonce: bound.nonce, expectedFingerprint: await snapshot(task, f.runtime), brief: 'Revise.', model: 'fixture/model', thinking: 'low' };
  await assert.rejects(prepareRevision(bound, spec, { ...f.runtime, revisionProtocol: undefined }), /activate the updated runtime/);
  await assert.rejects(prepareRevision(bound, { ...spec, expectedNonce: 'other-job' }, f.runtime), /nonce changed/);
  await assert.rejects(prepareRevision(bound, { ...spec, expectedFingerprint: '0'.repeat(64) }, f.runtime), /fingerprint changed/);
  execFileSync(gitBin, ['-C', task.worktree, 'add', 'source.txt']);
  await assert.rejects(prepareRevision(bound, spec, f.runtime), /unstaged/);
  execFileSync(gitBin, ['-C', task.worktree, 'reset', '-q', 'HEAD', '--', 'source.txt']);
  const revision = await prepareRevision(bound, spec, f.runtime);
  await writeFile(join(task.worktree, 'source.txt'), 'changed after approval\n');
  await assert.rejects(run(f.runtimePath, task.id, revision.attempt), /source changed after handoff/);
  await assert.rejects(json(join(attemptDirectory(task, revision.attempt), 'started.json')), /ENOENT/);
  assert.throws(() => attemptDirectory(task, '../escape'), /UUID/);
}));

test('runtime does not inherit secrets', () => {
  assert.deepEqual(Object.keys(envFor({ home: '/home/fixture', path: '/bin' })).sort(), ['GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PATH']);
});

test('real worker extension forwards revision identity to check artifacts while reusing the task output base', () => fixture(async f => {
  const task = await prepare(input(f.repo), f.runtime, who);
  await run(f.runtimePath, task.id);
  const revision = await prepareRevision({ ...task, nonce: 'previous-job' }, {
    expectedNonce: 'previous-job', expectedFingerprint: await snapshot(task, f.runtime),
    brief: 'Explicit revision.', model: 'fixture/model', thinking: 'low',
  }, f.runtime);
  const variables = { PI_DELEGATE_RUNTIME: f.runtimePath, PI_DELEGATE_TASK: task.id, PI_DELEGATE_ATTEMPT: revision.attempt };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const { loadExtensions } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')));
    const instance = await loadExtensions([new URL('../worker.ts', import.meta.url).pathname], task.worktree);
    assert.deepEqual(instance.errors, []);
    const handlers = instance.extensions[0].handlers;
    const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event); };
    let progress = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, callback) => { progress += chunk; callback?.(); return true; };
    try {
      await emit('agent_start'); await emit('turn_start'); await emit('before_provider_request');
      await emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Live answer' } });
      await emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE THINKING' } });
      await emit('message_update', { assistantMessageEvent: { type: 'text_end' } });
      await emit('message_end', { message: { role: 'assistant', stopReason: 'toolUse', usage: { output: 12 } } });
      await emit('tool_execution_start', { toolCallId: 'a', toolName: 'read', args: { path: 'first.md', secret: 'PRIVATE ARGUMENT' } });
      await emit('tool_execution_start', { toolCallId: 'b', toolName: 'read', args: { path: 'second.md', offset: 12 } });
      await emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Partial answer' } });
      await emit('tool_execution_end', { toolCallId: 'b', toolName: 'read', durationMs: 4.2, isError: false });
      await emit('tool_execution_end', { toolCallId: 'a', toolName: 'read', isError: true, result: 'PRIVATE RESULT' });
      await emit('agent_settled', { aborted: false });
    } finally { process.stderr.write = originalWrite; }
    assert.match(progress, /Live answer\n/);
    assert.match(progress, /Tool #1 starting: read.*first.md/);
    assert.match(progress, /Tool #2 starting: read.*second.md.*"offset":12/);
    assert.match(progress, /first\.md[^\n]*\n\[delegate\] Tool #2 starting:/);
    assert.match(progress, /Partial answer\n\[delegate\] Tool #2 finished: read \(4ms\)/);
    assert.doesNotMatch(progress, /\n\n\[delegate\]/);
    assert.match(progress, /Tool #1 finished: read \(error\)/);
    assert.doesNotMatch(progress, /PRIVATE/);
    assert.match(progress, /Model #1 finished:/); assert.match(progress, /Worker summary:/);
    const metricsText = await readFile(join(attemptDirectory(task, revision.attempt), 'metrics.jsonl'), 'utf8');
    const metrics = metricsText.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(metrics.length, 2); assert.equal(metrics[0].schemaVersion, 1);
    assert.equal(metrics[0].usage.output, 12); assert.equal(metrics[1].toolErrors, 1);
    assert.doesNotMatch(metricsText, /PRIVATE|Live answer/);
    await assert.rejects(readFile(join(task.directory, 'metrics.jsonl')), /ENOENT/);
    const tool = instance.extensions[0].tools.get('delegate_check').definition;
    const reply = await tool.execute('check', { index: 0 });
    const record = JSON.parse(reply.content[0].text);
    assert.equal(record.passed, true);
    assert.equal(record.log.startsWith(attemptDirectory(task, revision.attempt) + '/'), true);
    assert.ok(JSON.parse(await readFile(record.log, 'utf8')).args.includes('--output=' + join(task.directory, 'build-output')));
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}));
