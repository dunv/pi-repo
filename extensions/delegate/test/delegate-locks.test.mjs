import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const find = name => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
const shell = find('bash'), flock = find('flock');
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const launch = (bin, args) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
  child.once('error', reject); child.once('close', code => resolve({ code, out, err }));
});

test('launcher admits at most two workers globally; nonzero worker is executed only once, never retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-locks-'));
  try {
    const events = join(dir, 'events'), runner = join(dir, 'runner.cjs'), launcher = join(dir, 'launch.sh');
    await writeFile(runner, `const fs=require('node:fs'); const id=process.argv[3];
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({id,delta:1})+'\\n');
setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({id,delta:-1})+'\\n'); process.exit(7);}, 120);`);
    let source = await readFile(new URL('../launch.sh', import.meta.url), 'utf8');
    source = source.replaceAll('@bash@', shell);
    for (const [key, value] of Object.entries({ state: dir, flock, node: process.execPath, runner })) source = source.replaceAll(`@${key}@`, quote(value));
    await writeFile(launcher, source, { mode: 0o700 });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const results = await Promise.all(ids.map(id => launch(shell, [launcher, '/runtime.json', id])));
    assert.ok(results.every(r => r.code === 7), JSON.stringify(results));
    for (const result of results) assert.match(result.out, /\[delegate\] Launcher ready:.*acquiring worker slot/);
    const rows = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
    let active = 0, peak = 0;
    for (const row of rows) { active += row.delta; peak = Math.max(peak, active); assert.ok(active >= 0 && active <= 2); }
    assert.equal(active, 0); assert.equal(peak, 2);
    for (const id of ids) assert.equal(rows.filter(r => r.id === id && r.delta === 1).length, 1);
    assert.equal((await launch(shell, [launcher, '/runtime.json', '../bad'])).code, 64);
    assert.equal((await launch(shell, [launcher, '/runtime.json', randomUUID(), '../bad-revision'])).code, 64);
    const revised = await launch(launcher, ['/runtime.json', randomUUID(), randomUUID()]);
    assert.equal(revised.code, 7, revised.err);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('global check lock serializes independent processes and releases on completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'delegate-check-lock-'));
  try {
    const worker = join(dir, 'worker.cjs'), events = join(dir, 'events');
    await writeFile(worker, `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(events)},'start\\n');
setTimeout(()=>{fs.appendFileSync(${JSON.stringify(events)},'end\\n');},100);`);
    const results = await Promise.all(Array.from({ length: 3 }, () => launch(flock, [join(dir, 'verification.lock'), process.execPath, worker])));
    assert.ok(results.every(r => r.code === 0));
    assert.equal(await readFile(events, 'utf8'), 'start\nend\nstart\nend\nstart\nend\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
