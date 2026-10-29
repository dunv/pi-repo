// Dependency-free newline-delimited MCP stdio bridge. No shell or arbitrary
// executable tool; serialize calls so source mutation cannot overlap a check.
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeFrom, json, assertWorktree, writable, git, envFor } from './core.mjs';
import { toolSummary } from './progress.mjs';
const exec = promisify(execFile);
const string = { type: 'string', maxLength: 1048576 };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'read', description: 'Read a worktree text file, bounded to 1 MiB; optional one-based line offset and limit.', inputSchema: schema({ path: string, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']) },
  { name: 'ls', description: 'List one worktree directory (up to 1000 entries).', inputSchema: schema({ path: string }, []) },
  { name: 'find', description: 'List Git tracked/nonignored file paths containing a literal pattern (up to 1000 results).', inputSchema: schema({ pattern: string }, ['pattern']) },
  { name: 'grep', description: 'Search literal text in up to 1000 Git tracked/nonignored text files, optionally in a path prefix. At most 100 matching lines.', inputSchema: schema({ pattern: string, path: string }, ['pattern']) },
  { name: 'write', description: 'Create or replace a source file within the worktree. Git/agent configuration and symlink escapes are forbidden.', inputSchema: schema({ path: string, content: string }, ['path', 'content']) },
  { name: 'edit', description: 'Replace exactly one unique, nonempty oldText occurrence in a source file.', inputSchema: schema({ path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']) },
  { name: 'delegate_check', description: 'Run a planned verification check by zero-based index under the shared heavy-check lock. Never automatically retry failures.', inputSchema: schema({ index: { type: 'integer', minimum: 0, maximum: 7 } }, ['index']) },
];
function validate(name, args) {
  const spec = tools.find(t => t.name === name)?.inputSchema;
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool or invalid arguments');
  for (const key of spec.required) if (!(key in args)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = spec.properties[key];
    if (!rule || (rule.type === 'string' ? typeof value !== 'string' || value.length > rule.maxLength :
      !Number.isInteger(value) || value < rule.minimum || value > (rule.maximum ?? Number.MAX_SAFE_INTEGER))) throw new Error(`Invalid ${key}`);
  }
}
export async function createTools(runtimePath, id, attempt) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Full task UUID required');
  const runtime = await runtimeFrom(runtimePath), root = join(runtime.state, id), task = await json(join(root, 'task.json'));
  if (task.id !== id || task.directory !== root) throw new Error('Task identity mismatch');
  async function source(path = '.') {
    if (path.includes('\0')) throw new Error('Invalid path');
    const target = await realpath(resolve(task.worktree, path)), rel = relative(task.worktree, target);
    if (rel.startsWith('../') || isAbsolute(rel)) throw new Error('Read outside worktree');
    return target;
  }
  async function text(path) {
    const target = await source(path), info = await stat(target);
    if (!info.isFile() || info.size > 1048576) throw new Error('Expected text file at most 1 MiB');
    const value = await readFile(target, 'utf8');
    if (value.includes('\0')) throw new Error('Binary file not supported');
    return value;
  }
  const files = async () => [...new Set((await git(runtime, task.worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))].sort();
  return async (name, args) => {
    validate(name, args);
    await assertWorktree(task, runtime);
    console.error(`[delegate] Tool starting: ${name} ${toolSummary(name, args)}`);
    let output;
    try {
      if (name === 'read') output = (await text(args.path)).split('\n').slice((args.offset ?? 1) - 1, (args.offset ?? 1) - 1 + (args.limit ?? 2000)).join('\n');
      if (name === 'ls') output = (await readdir(await source(args.path))).sort().slice(0, 1000).join('\n');
      if (name === 'find') output = (await files()).filter(p => p.includes(args.pattern)).slice(0, 1000).join('\n');
      if (name === 'grep') {
        const hits = [];
        for (const path of (await files()).filter(p => !args.path || p === args.path || p.startsWith(args.path.replace(/\/$/, '') + '/')).slice(0, 1000)) {
          let value;
          try { value = await text(path); } catch { continue; }
          for (const [i, line] of value.split('\n').entries()) if (line.includes(args.pattern)) {
            hits.push(`${path}:${i + 1}:${line.slice(0, 500)}`);
            if (hits.length >= 100) break;
          }
          if (hits.length >= 100) break;
        }
        output = hits.join('\n');
      }
      if (name === 'write' || name === 'edit') {
        await writable(task, args.path);
        const target = resolve(task.worktree, args.path);
        let value = args.content;
        if (name === 'edit') {
          const prior = await text(args.path);
          if (!args.oldText || prior.split(args.oldText).length !== 2) throw new Error('oldText must match exactly once');
          value = prior.replace(args.oldText, () => args.newText);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, value);
        output = 'Source updated; remains uncommitted and unstaged.';
      }
      if (name === 'delegate_check') {
        if (!task.checks[args.index]) throw new Error('Check not planned');
        output = (await exec(runtime.flock, [join(runtime.state, 'verification.lock'), runtime.node,
          join(dirname(fileURLToPath(import.meta.url)), 'check.mjs'), runtimePath, id, String(args.index),
          ...(attempt === undefined ? [] : [attempt])], { cwd: task.worktree, env: envFor(runtime), maxBuffer: 32768 })).stdout;
      }
      return { content: [{ type: 'text', text: output.slice(0, 50000) + (output.length > 50000 ? '\n[truncated; use narrower reads/searches]' : '') }] };
    } finally { console.error(`[delegate] Tool finished: ${name}`); }
  };
}
export async function serve(runtimePath, id, attempt) {
  const call = await createTools(runtimePath, id, attempt);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      if (Buffer.byteLength(line) > 2200000) throw new Error('Request too large');
      request = JSON.parse(line);
      if (request.id === undefined) continue;
      let result;
      switch (request.method) {
        case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'delegate', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call':
          try { result = await call(request.params?.name, request.params?.arguments ?? {}); }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: `Tool failed; inspect artifacts, do not automatically retry: ${error.message}` }] }; }
          break;
        default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } }) + '\n');
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve(...process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
