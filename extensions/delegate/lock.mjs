// A kernel lock serializes task mutations and excludes cleanup while a worker
// or check is running. Locks live outside disposable task directories.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { privateDir } from './core.mjs';

export async function withTaskLock(runtime, id, shared, operation) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error('Full task UUID required');
  await privateDir(runtime.state);
  const directory = join(runtime.state, '.locks'); await privateDir(directory);
  if (await realpath(directory) !== directory) throw new Error('Canonical task lock directory required');
  const path = join(directory, id), fd = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = await fd.stat(), current = await lstat(path);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.nlink !== 1
      || current.dev !== st.dev || current.ino !== st.ino) throw new Error('Unsafe task lock');
    const code = await new Promise((resolve, reject) => {
      // flock operates on the SAME open file description retained by Node.
      // The lock survives flock's exit and is released by closing fd below.
      const child = spawn(runtime.flock, [...(shared ? ['--shared'] : ['--nonblock', '--exclusive']), '3'],
        { stdio: ['ignore', 'ignore', 'ignore', fd.fd] });
      child.once('error', reject); child.once('close', resolve);
    });
    if (code !== 0) throw new Error('Task is busy; no cleanup or concurrent mutation');
    return await operation();
  } finally { await fd.close(); }
}
