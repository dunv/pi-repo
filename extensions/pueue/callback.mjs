// Configure a STATIC absolute node/script/directory command in pueued; interpolate ONLY {{id}}.
// This helper does not supervise, query, authorize, or retry jobs. Lost wakeups reconcile on resume.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function hint(directory, id) {
  if (!isAbsolute(directory) || !/^(0|[1-9][0-9]{0,14})$/.test(id)) throw new Error('Invalid hint arguments');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('Unsafe hint directory');
  }
  const file = await open(join(directory, 'wake'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.nlink !== 1) throw new Error('Unsafe hint file');
    await file.truncate(0);
    await file.write(`${id}\n`, 0, 'utf8');
  } finally { await file.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await hint(process.argv[2] ?? '', process.argv[3] ?? ''); }
  catch { process.stderr.write('Pueue completion hint failed (resume reconciles).\n'); process.exitCode = 1; }
}
