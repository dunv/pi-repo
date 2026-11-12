// Synthetic local state only: no workers, builds, live backends or real task data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inventory } from '../../../skills/delegate-cleanup/scripts/inventory.mjs';

const script = fileURLToPath(new URL('../../../skills/delegate-cleanup/scripts/inventory.mjs', import.meta.url));
const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-inventory-'));
  try {
    const repo = join(dir, 'repo'), state = join(dir, 'state'), id = randomUUID();
    const directory = join(state, id), worktree = join(repo + '.worktrees', `delegate-${id}`), branch = `delegate/${id}`;
    const g = (...args) => execFileSync(git, ['-C', repo, ...args], { encoding: 'utf8' });
    execFileSync(git, ['init', '-q', repo]);
    await writeFile(join(repo, 'source.txt'), 'fixture source\n');
    g('add', '.'); g('-c', 'user.name=Fixture', '-c', 'user.email=f@invalid', 'commit', '-qm', 'initial');
    g('worktree', 'add', '-qb', branch, worktree);
    await mkdir(state, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
    const runtime = { state, git, node: process.execPath, pi: '/fixture/pi', flock: '/fixture/flock', ssh: '/fixture/ssh',
      home: dir, launcher: '/fixture/launcher', path: process.env.PATH };
    await writeFile(join(directory, 'task.json'), JSON.stringify({ id, directory, repo, worktree, branch,
      owner: { session: 'inventory-fixture', file: '/fixture/session.jsonl' } }), { mode: 0o600 });
    await writeFile(join(directory, 'result.json'), '{}', { mode: 0o600 });
    await mkdir(join(directory, 'build-output')); await writeFile(join(directory, 'build-output', 'cache'), 'rebuildable\n');
    const runtimePath = join(dir, 'runtime.json');
    await writeFile(runtimePath, JSON.stringify(runtime), { mode: 0o600 });
    const cli = (entry, args = [], configured = true) => spawnSync(process.execPath, [entry, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 20000,
      env: { PATH: process.env.PATH, HOME: dir, ...(configured ? { PI_DELEGATE_RUNTIME: runtimePath } : {}) },
    });
    await fn({ dir, repo, directory, worktree, runtime, runtimePath, cli, g });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('default inventory measures task state without worktree allocation; opt-in adds it without changing state', () => fixture(async f => {
  const before = await readdir(f.directory), manifest = await readFile(join(f.directory, 'task.json'), 'utf8');
  const status = f.g('status', '--porcelain');
  const quick = await inventory(f.runtime), full = await inventory(f.runtime, { worktrees: true });
  assert.equal(quick.worktreeAllocationRequested, false);
  assert.equal(full.worktreeAllocationRequested, true);
  const row = quick.tasks[0];
  assert.equal(row.classification, 'unassessed');
  assert.equal(row.worktreeExists, true);
  assert.equal(row.branchExists, true); assert.equal(row.worktreeRegistered, true);
  assert.equal(Object.hasOwn(row, 'worktreeAllocatedBytes'), false);
  assert.ok(row.allocatedBytes.build > 0); assert.equal(row.receipts.result, true);
  assert.deepEqual(full.tasks[0].allocatedBytes, row.allocatedBytes);
  assert.ok(full.tasks[0].worktreeAllocatedBytes > 0);
  assert.deepEqual(await readdir(f.directory), before);
  assert.equal(await readFile(join(f.directory, 'task.json'), 'utf8'), manifest);
  assert.equal(f.g('status', '--porcelain'), status);
  await assert.rejects(inventory(f.runtime, { worktrees: 'yes' }), /boolean/);
}));

test('invalid or symlinked worktree roots retain state accounting but stay blocked in both modes', () => fixture(async f => {
  const retained = f.worktree + '-retained';
  await rename(f.worktree, retained);
  for (const kind of ['file', 'symlink']) {
    if (kind === 'file') await writeFile(f.worktree, 'not a worktree directory\n');
    else await symlink(retained, f.worktree);
    for (const worktrees of [false, true]) {
      const row = (await inventory(f.runtime, { worktrees })).tasks[0];
      assert.ok(row.allocatedBytes.build > 0);
      assert.equal(row.receipts.result, true); assert.equal(row.branchExists, true);
      assert.equal(Object.hasOwn(row, 'worktreeAllocatedBytes'), false);
      assert.match(row.blockers.join(' '), /Worktree path unavailable\/changed/);
      assert.match(row.blockers.join(' '), /No live terminal/);
    }
    await rm(f.worktree);
  }
}));

test('default mode avoids unreadable worktree contents; an optional scan failure retains state results',
  { skip: process.getuid() === 0 ? 'root bypasses fixture directory permissions' : false }, () => fixture(async f => {
    const unreadable = join(f.worktree, 'unreadable');
    await mkdir(unreadable); await chmod(unreadable, 0o000);
    try {
      const quick = await inventory(f.runtime), full = await inventory(f.runtime, { worktrees: true });
      assert.equal(quick.tasks[0].blockers.some(b => b.includes('Worktree allocation')), false);
      const row = full.tasks[0];
      assert.deepEqual(row.allocatedBytes, quick.tasks[0].allocatedBytes);
      assert.ok(row.allocatedBytes.build > 0);
      assert.equal(row.receipts.result, true); assert.equal(row.branchExists, true);
      assert.equal(Object.hasOwn(row, 'worktreeAllocatedBytes'), false);
      assert.match(row.blockers.join(' '), /Worktree allocation unavailable/);
    } finally { await chmod(unreadable, 0o700); }
  }));

test('missing repositories do not hide state accounting in default or expanded inventories', () => fixture(async f => {
  await rename(f.repo, f.repo + '-retained');
  for (const worktrees of [false, true]) {
    const row = (await inventory(f.runtime, { worktrees })).tasks[0];
    assert.ok(row.allocatedBytes.build > 0); assert.equal(row.receipts.result, true);
    assert.equal(row.branchExists, null);
    assert.match(row.blockers.join(' '), /Repository identity\/registration unavailable/);
  }
}));

test('CLI emits JSON through direct, file-symlink and installed-skill-directory paths', () => fixture(async f => {
  const fileLink = join(f.dir, 'inventory alias.mjs'), skillLink = join(f.dir, 'installed skill');
  await symlink(script, fileLink);
  await symlink(dirname(dirname(script)), skillLink);
  const before = await readdir(f.directory);
  for (const entry of [script, fileLink, join(skillLink, 'scripts', 'inventory.mjs')]) {
    for (const worktrees of [false, true]) {
      const run = f.cli(entry, worktrees ? ['--worktrees'] : []);
      assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, '');
      const report = JSON.parse(run.stdout);
      assert.equal(report.state, f.runtime.state); assert.equal(report.tasks.length, 1);
      assert.equal(report.worktreeAllocationRequested, worktrees);
      assert.equal(Object.hasOwn(report.tasks[0], 'worktreeAllocatedBytes'), worktrees);
    }
  }
  assert.deepEqual(await readdir(f.directory), before);
}));

test('CLI help requires no runtime and rejects unknown, duplicate and positional arguments before inventory', () => fixture(async f => {
  const before = await readdir(f.directory);
  const help = f.cli(script, ['--help'], false);
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage: inventory\.mjs \[--worktrees\]/);
  for (const args of [['unexpected'], ['--worktree'], ['--worktrees', '--worktrees'], ['--help', '--worktrees']]) {
    const run = f.cli(script, args, false);
    assert.equal(run.error, undefined); assert.notEqual(run.status, 0);
    assert.equal(run.stdout, ''); assert.match(run.stderr, /Usage: inventory\.mjs/);
    assert.doesNotMatch(run.stderr, /PI_DELEGATE_RUNTIME must name/);
  }
  assert.deepEqual(await readdir(f.directory), before);
}));
