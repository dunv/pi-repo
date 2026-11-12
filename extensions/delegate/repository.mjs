// Local filesystem/Git identity, not ancestry/origin matching. No mutations.
import { lstat, realpath, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git } from './core.mjs';

async function canonical(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || await realpath(path) !== path) {
    throw new Error('Canonical user-owned repository directories required');
  }
  return { device: st.dev, inode: st.ino };
}
export function assertNoPayloadMounts(directory, targets, text) {
  if (text.length > 4 * 1024 * 1024 || !text.trim()) throw new Error('Mount inventory unavailable/oversized');
  for (const line of text.trimEnd().split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 10 || !line.includes(' - ') || !fields[4]?.startsWith('/')) throw new Error('Invalid mount inventory');
    const mount = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if ((mount === directory || mount.startsWith(directory + '/')) && targets.some(target =>
      target === mount || target.startsWith(mount + '/') || mount.startsWith(target + '/'))) throw new Error('Mounted payload (including same-device bind mount); disposal blocked');
  }
}
export async function assertFinalizationMounts(task, mountinfo) {
  const mounts = mountinfo ?? await readFile('/proc/self/mountinfo', 'utf8');
  assertNoPayloadMounts(task.worktree, [task.worktree], mounts);
  assertNoPayloadMounts(task.directory, [join(task.directory, 'finalization')], mounts);
}
export async function repositoryIdentity(repo, runtime) {
  await canonical(repo);
  if ((await git(runtime, repo, ['rev-parse', '--show-toplevel'])).trim() !== repo) throw new Error('Repository root required');
  const common = resolve(repo, (await git(runtime, repo, ['rev-parse', '--git-common-dir'])).trim());
  const commonIdentity = await canonical(common);
  const first = (await git(runtime, repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0')[0];
  if (!first.startsWith('worktree ')) throw new Error('Main repository registration unavailable');
  const main = first.slice(9), mainIdentity = await canonical(main);
  // Nonstandard/bare layouts stay unsupported, rather than guessing a mapping.
  if (join(main, '.git') !== common) throw new Error('Canonical main-checkout Git directory required');
  return { version: 1, main, mainIdentity, common, commonIdentity };
}
