import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { timestampLines } from './logging.mjs';
import { parsePiModelPolicy, assertPiModelAllowed } from './model-policy.mjs';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, lstat, readlink, open, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

const exec = promisify(execFile);
export const ENTRY = 'pi.delegate.task.v1';
export const digest = data => createHash('sha256').update(data).digest('hex');
export const json = async path => JSON.parse(await readFile(path, 'utf8'));
export const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
export async function lifecycleJSON(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o077 || before.size > 128 * 1024 * 1024) throw new Error('Unsafe/oversized private lifecycle record');
    const buffer = Buffer.alloc(before.size + 1), { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const after = await fd.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Lifecycle record changed during read');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await fd.close(); }
}
// Permanent lifecycle claims/receipts must survive a lost reply or crash.
export async function durableSave(path, value) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export const envFor = runtime => ({ HOME: runtime.home, PATH: runtime.path, LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_SSH_COMMAND: runtime.ssh, GIT_SSH_VARIANT: 'ssh' });
export async function git(runtime, cwd, args, extraEnv = {}) {
  return (await exec(runtime.git, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: { ...envFor(runtime), ...extraEnv }, maxBuffer: 64 * 1024 * 1024,
  })).stdout;
}
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('Delegate directory must be private, user-owned and not a symlink');
  }
}
export async function runtimeFrom(path) {
  if (!path || !isAbsolute(path)) throw new Error('PI_DELEGATE_RUNTIME must name an absolute runtime JSON file');
  const runtime = await json(path);
  for (const key of ['git', 'node', 'pi', 'flock', 'ssh', 'home', 'state', 'launcher']) {
    if (typeof runtime[key] !== 'string' || !isAbsolute(runtime[key])) throw new Error(`Invalid delegate runtime: ${key}`);
  }
  if (runtime.claude !== undefined && (typeof runtime.claude !== 'string' || !isAbsolute(runtime.claude))) throw new Error('Invalid delegate runtime: claude');
  if (runtime.containmentProtocol !== undefined && (runtime.containmentProtocol !== 1
    || typeof runtime.systemdRun !== 'string' || !isAbsolute(runtime.systemdRun))) throw new Error('Invalid delegate containment runtime');
  if (runtime.disposalProtocol !== undefined && runtime.disposalProtocol !== 1) throw new Error('Invalid delegate disposal runtime');
  if (runtime.reconciliationProtocol !== undefined && runtime.reconciliationProtocol !== 1) throw new Error('Invalid delegate reconciliation runtime');
  if (typeof runtime.path !== 'string' || runtime.path.split(':').some(p => !isAbsolute(p))) throw new Error('Invalid delegate PATH');
  return runtime;
}
export async function assertWorktree(task, runtime, clean = false) {
  const root = (await git(runtime, task.worktree, ['rev-parse', '--show-toplevel'])).trim();
  const head = (await git(runtime, task.worktree, ['rev-parse', 'HEAD'])).trim();
  if (await realpath(root) !== task.worktree || head !== task.base) throw new Error('Worker checkout moved or HEAD changed');
  const branch = (await git(runtime, task.worktree, ['symbolic-ref', '--short', 'HEAD'])).trim();
  if (branch !== task.branch) throw new Error('Worker branch changed');
  if ((await git(runtime, task.worktree, ['diff', '--cached', '--name-only'])).trim()) throw new Error('Worker index must remain unstaged');
  if (clean && (await git(runtime, task.worktree, ['status', '--porcelain', '--untracked-files=all'])).trim()) {
    throw new Error('Worker must start from a clean worktree');
  }
}
export function modelFamily(provider, id) {
  provider = provider.toLowerCase();
  // Local and OpenAI providers are Pi-only, independent of their model tags.
  if (/^(?:openai(?:-|$)|azure-openai(?:-|$))/.test(provider)
    || ['evo-x2', 'ollama', 'llama.cpp'].includes(provider)) return { backend: 'pi' };
  const native = id.replace(/^anthropic\//, '');
  if (/^claude-[a-z0-9][a-z0-9.-]*$/.test(native)) return { backend: 'claude', native };
  if (provider === 'anthropic' || provider.endsWith('-anthropic') || /^claude[-.]/i.test(id) || id.startsWith('anthropic/')
    || /(^|[./])anthropic\.claude-/.test(id)) return { backend: 'claude', native: null };
  return { backend: 'pi' };
}
export function workerBackend(input, runtime) {
  const policy = parsePiModelPolicy(runtime);
  const backend = input.backend ?? 'pi';
  if (!['pi', 'claude'].includes(backend)) throw new Error('Unknown worker backend');
  if (backend === 'claude') {
    if (!/^claude-[a-z0-9][a-z0-9.-]*$/.test(input.model)) throw new Error('Claude backend requires an explicit claude-* model ID, not a Pi provider/model or alias');
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)) throw new Error('Claude thinking must be an explicit supported effort: low, medium, high, xhigh, max');
    if (runtime && (typeof runtime.claude !== 'string' || !isAbsolute(runtime.claude))) throw new Error('Claude backend unavailable: configure runtime.claude and restart Pi');
  } else {
    if (!/^[a-z0-9-]+\/.+$/i.test(input.model) || /[\x00-\x20]/.test(input.model)) throw new Error('Use an explicit provider/model ID');
    const [provider, ...parts] = input.model.split('/');
    if (modelFamily(provider, parts.join('/')).backend === 'claude') throw new Error('Anthropic models require Claude Code; Pi is forbidden');
    assertPiModelAllowed(policy, provider, parts.join('/'), input.thinking);
  }
  return backend;
}
export function validateInput(input) {
  if (!isAbsolute(input.repo) || !input.brief?.trim() || input.brief.length > 32000) throw new Error('Absolute repo and bounded nonempty brief required');
  workerBackend(input);
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)) throw new Error('Explicit thinking level required');
  if (typeof input.profile !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.profile)) throw new Error('Choose an explicitly configured verification profile');
  if (!Array.isArray(input.checks) || input.checks.length > 8) throw new Error('At most eight planned checks');
  for (const check of input.checks) {
    if (!['test', 'build'].includes(check.kind) || !Array.isArray(check.targets) || !check.targets.length || check.targets.length > 32
      || check.targets.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_/.:+@=][a-zA-Z0-9_/.:+@=-]{0,1023}$/.test(t))) {
      throw new Error('Checks require test/build and literal target names; no flags or shell');
    }
  }
}
export function verificationProfile(profile) {
  if (!profile || typeof profile.command !== 'string' || !isAbsolute(profile.command)
    || !Array.isArray(profile.args) || profile.args.length > 128
    || profile.args.some(a => typeof a !== 'string' || a.length > 4096 || /[\x00-\x1f]/.test(a)
      || /\{(?!worktree\}|outputBase\}|kind\}|targets\})/.test(a)
      || (a.includes('{targets}') && a !== '{targets}'))
    || profile.args.filter(a => a === '{targets}').length !== 1) {
    throw new Error('Verification profile requires an absolute command and literal args with one {targets} token');
  }
  return { command: profile.command, args: [...profile.args] };
}
export function initiatorLabel(owner) {
  const name = typeof owner.name === 'string' ? owner.name : 'session';
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/g, '') || 'session';
  const session = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(owner.session)
    ? owner.session.slice(0, 8).toLowerCase() : digest(owner.session).slice(0, 8);
  return `${slug}-s${session}`;
}
// Read-only handoff identity includes semantic index entries and working content.
// Staging changes alone conservatively count as source drift.
export async function sourceSnapshot(repo, runtime) {
  const root = (await git(runtime, repo, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(root) !== repo) throw new Error('Source repository moved');
  const head = (await git(runtime, repo, ['rev-parse', 'HEAD'])).trim();
  const index = await git(runtime, repo, ['ls-files', '--stage', '-v', '-z']);
  return digest(head + digest(index) + await contentSnapshot(repo, head, runtime));
}
async function captureTree(repo, runtime, directory) {
  if ((await git(runtime, repo, ['ls-files', '--unmerged'])).trim()) throw new Error('Resolve source index conflicts before delegation');
  if (/^160000 /m.test(await git(runtime, repo, ['ls-files', '--stage']))) throw new Error('Source snapshots do not support submodules');
  // Bound changed/new source before Git reads it into the object database.
  const names = new Set((await git(runtime, repo, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '-z'])
    + await git(runtime, repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  if (names.size > 10000) throw new Error('Too many changed files for source snapshot');
  let size = 0;
  for (const name of names) {
    let stat;
    try { stat = await lstat(join(repo, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    size += stat.size;
    if (size > 64 * 1024 * 1024 || !(stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsupported/oversized source snapshot');
  }
  const indexPath = resolve(repo, (await git(runtime, repo, ['rev-parse', '--git-path', 'index'])).trim());
  const temporaryIndex = join(directory, 'snapshot.index');
  // Copy, never mutate, the source index: staged ignored additions remain tracked.
  if ((await lstat(indexPath)).size > 64 * 1024 * 1024) throw new Error('Oversized source index');
  await writeFile(temporaryIndex, await readFile(indexPath), { mode: 0o600, flag: 'wx' });
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    await git(runtime, repo, ['update-index', '--no-split-index'], env);
    // Sparse/assume-unchanged entries could silently omit working content.
    if (/^[a-zS] /m.test(await git(runtime, repo, ['ls-files', '-v'], env))) throw new Error('Source snapshots do not support sparse/assume-unchanged entries');
    await git(runtime, repo, ['add', '--all', '--', '.'], env);
    const tree = (await git(runtime, repo, ['write-tree'], env)).trim();
    if (/^160000 /m.test(await git(runtime, repo, ['ls-tree', '-r', tree]))) throw new Error('Source snapshots do not support embedded repositories');
    return tree;
  } finally { await rm(temporaryIndex, { force: true }); }
}
export async function prepare(input, runtime, owner) {
  validateInput(input);
  const backend = workerBackend(input, runtime);
  const verification = verificationProfile(runtime.profiles?.[input.profile]);
  const repo = await realpath(input.repo);
  if ((await git(runtime, repo, ['rev-parse', '--show-toplevel'])).trim() !== repo) throw new Error('Select the repository root');
  const sourceHead = (await git(runtime, repo, ['rev-parse', 'HEAD'])).trim();
  await privateDir(runtime.state);
  const id = randomUUID(), directory = join(runtime.state, id);
  await privateDir(directory);
  const worktrees = repo + '.worktrees';
  await mkdir(worktrees, { recursive: true });
  const label = initiatorLabel(owner);
  const sourceFingerprint = await sourceSnapshot(repo, runtime);
  if ((await git(runtime, repo, ['rev-parse', 'HEAD'])).trim() !== sourceHead) throw new Error('Source HEAD changed during snapshot');
  const tree = await captureTree(repo, runtime, directory);
  if (await sourceSnapshot(repo, runtime) !== sourceFingerprint) throw new Error(`Source changed during snapshot; retained task ${id}, do not submit automatically`);
  const headTree = (await git(runtime, repo, ['rev-parse', `${sourceHead}^{tree}`])).trim();
  // An internal baseline object, not a user commit: no source branch/index changes or hooks.
  const base = tree === headTree ? sourceHead : (await git(runtime, repo,
    ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', sourceHead, '-m', 'Pi delegate source snapshot'],
    { GIT_AUTHOR_NAME: 'Pi delegate', GIT_AUTHOR_EMAIL: 'delegate@localhost', GIT_COMMITTER_NAME: 'Pi delegate', GIT_COMMITTER_EMAIL: 'delegate@localhost' })).trim();
  const task = { version: 1, id, owner, initiatorLabel: label, repo, base, sourceHead, sourceFingerprint, sourceTree: tree, branch: `delegate/${id}`, worktree: join(worktrees, `delegate-${label}-${id}`),
    directory, backend, route: input.route ?? null, model: input.model, thinking: input.thinking, profile: input.profile, verification, checks: input.checks };
  // Persist intent before worktree creation. Failures retain evidence; never auto-remove/retry.
  await save(join(directory, 'task.json'), task);
  await writeFile(join(directory, 'brief.md'), input.brief, { mode: 0o600, flag: 'wx' });
  await git(runtime, repo, ['worktree', 'add', '-b', task.branch, task.worktree, base]);
  if (await sourceSnapshot(repo, runtime) !== sourceFingerprint) {
    throw new Error(`Source changed during preparation; retained task ${id}, do not submit automatically`);
  }
  await assertWorktree(task, runtime, true);
  return task;
}
export function attemptDirectory(task, attempt) {
  if (attempt === undefined) return task.directory;
  if (typeof attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(attempt)) throw new Error('Full revision UUID required');
  return join(task.directory, 'revisions', attempt);
}
export async function prepareRevision(task, input, runtime, recovery) {
  if (runtime.revisionProtocol !== 1) throw new Error('Revision launcher unavailable: activate the updated runtime and restart Pi first');
  const backend = workerBackend({ ...input, backend: input.backend ?? task.backend }, runtime);
  validateInput({ ...task, ...input, backend, repo: task.repo, profile: task.profile, checks: task.checks });
  verificationProfile(task.verification);
  if (!task.nonce || task.nonce !== input.expectedNonce) throw new Error('Previous job nonce changed; review the latest task first');
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint) || await snapshot(task, runtime) !== input.expectedFingerprint) {
    throw new Error('Source fingerprint changed; review the current diff before revising');
  }
  const attempt = randomUUID(), directory = attemptDirectory(task, attempt);
  // A permanent per-parent claim also prevents duplicates after tree navigation,
  // lost admission replies or concurrent calls. No uncertain claim is auto-released.
  await save(join(task.directory, `revision-after-${digest(task.nonce)}.json`), { attempt, previousNonce: task.nonce });
  await privateDir(join(task.directory, 'revisions'));
  await privateDir(directory);
  await save(join(directory, 'attempt.json'), { task: task.id, attempt, previousNonce: task.nonce,
    expectedFingerprint: input.expectedFingerprint, backend, route: input.route ?? null, model: input.model, thinking: input.thinking,
    ...(recovery ? { recovery } : {}) });
  await writeFile(join(directory, 'brief.md'), input.brief, { mode: 0o600, flag: 'wx' });
  if (await snapshot(task, runtime) !== input.expectedFingerprint) throw new Error(`Source changed preparing revision ${attempt}; retain evidence and reconcile`);
  return { ...task, attempt, previousNonce: task.nonce, nonce: undefined, backend, route: input.route ?? null, model: input.model, thinking: input.thinking,
    recovery };
}
export function tasksFrom(entries) {
  const tasks = new Map();
  for (const e of entries) if (e.type === 'custom' && e.customType === ENTRY && e.data?.id) tasks.set(e.data.id, e.data);
  return tasks;
}
export async function snapshot(task, runtime) {
  await assertWorktree(task, runtime);
  return contentSnapshot(task.worktree, task.base, runtime);
}
async function contentSnapshot(worktree, base, runtime) {
  const hash = createHash('sha256').update(base);
  hash.update(await git(runtime, worktree, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD']));
  const files = (await git(runtime, worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  if (files.length > 10000) throw new Error('Too many untracked files for verification snapshot');
  let size = 0;
  for (const name of files) {
    const path = join(worktree, name), stat = await lstat(path);
    size += stat.size;
    if (size > 64 * 1024 * 1024 || !(stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsupported/oversized verification snapshot');
    hash.update(JSON.stringify([name, stat.mode, stat.size])); hash.update(stat.isSymbolicLink() ? await readlink(path) : await readFile(path));
  }
  return hash.digest('hex');
}
export async function writable(task, path) {
  const target = resolve(task.worktree, path), rel = relative(task.worktree, target);
  if (!rel || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').some(p => ['.git', '.pi', '.agents', '.claude'].includes(p))) {
    throw new Error('Worker writes must stay inside task source files, outside agent/Git configuration');
  }
  // Resolve existing ancestors too: a symlinked parent must not escape the worktree.
  let ancestor = target;
  for (;;) {
    try {
      const canonical = await realpath(ancestor), r = relative(task.worktree, canonical);
      if (r.startsWith('../') || isAbsolute(r) || r.split('/').some(p => ['.git', '.pi', '.agents', '.claude'].includes(p))) throw new Error('Worker write follows an external/protected symlink');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
}
export async function runToFiles(executable, args, options, stdoutPath, stderrPath = stdoutPath, live = false, inputPath, timestampLogs = false) {
  const stdin = inputPath ? await open(inputPath, 'r') : undefined;
  const out = await open(stdoutPath, 'wx', 0o600);
  const err = stderrPath === stdoutPath ? out : await open(stderrPath, 'wx', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { ...options, stdio: [stdin?.fd ?? 'ignore', live ? 'pipe' : out.fd, live ? 'pipe' : err.fd] });
      // Bound buffering via stream backpressure; never end the runner's own streams.
      const mirror = (source, file, destination) => {
        const stamp = timestampLines();
        return pipeline(source, new Writable({
          write(chunk, _encoding, done) {
            const visible = timestampLogs ? stamp(chunk) : chunk;
            // stdoutPath is the raw final report; only worker logs are decorated.
            const saved = file === err && stderrPath !== stdoutPath ? visible : chunk;
            file.writeFile(saved).then(() => destination.write(visible, done), done);
          },
        }));
      };
      const streams = live ? Promise.all([mirror(child.stdout, out, process.stdout), mirror(child.stderr, err, process.stderr)]) : Promise.resolve();
      const exited = new Promise((accept, fail) => {
        child.once('error', fail);
        child.once('close', (code, signal) => accept({ code, signal }));
      });
      Promise.all([exited, streams]).then(([result]) => resolve(result), reject);
    });
  } finally { await out.close(); if (err !== out) await err.close(); await stdin?.close(); }
}
export async function tail(path, limit = 8192) {
  const file = await open(path, 'r');
  try { const size = (await file.stat()).size, data = Buffer.alloc(Math.min(size, limit));
    await file.read(data, 0, data.length, Math.max(0, size - data.length));
    return { path, bytes: size, truncated: size > limit, text: data.toString('utf8') };
  } finally { await file.close(); }
}
