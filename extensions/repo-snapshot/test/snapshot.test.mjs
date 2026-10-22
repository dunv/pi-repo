import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import extension from "../index.ts";
import { Check } from "typebox/value";
import { test } from "node:test";
import { collectSnapshot, formatSnapshot, parseStatus, parseWorktrees } from "../snapshot.ts";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Snapshot Test", "-c", "user.email=snapshot@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}
async function fixture(t, commit = true) {
  const parent = await mkdtemp(join(tmpdir(), "repo-snapshot-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  await mkdir(root);
  git(root, "init", "-b", "main");
  if (commit) {
    await writeFile(join(root, "tracked.txt"), "original\n");
    git(root, "add", "."); git(root, "commit", "-m", "initial");
  }
  return { root, parent };
}

test("clean repository from a subdirectory, without touching the index", async t => {
  const { root } = await fixture(t);
  const nested = join(root, "nested"); await mkdir(nested);
  const index = join(root, ".git", "index"); const before = await stat(index);
  const s = await collectSnapshot(nested);
  assert.equal(s.root, root); assert.equal(s.branch, "main"); assert.equal(s.clean, true);
  assert.equal(s.head, git(root, "rev-parse", "HEAD")); assert.equal(s.upstream, null);
  assert.deepEqual(s.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
  assert.equal(s.worktrees, undefined); assert.equal(s.whitespace, undefined);
  assert.equal((await stat(index)).mtimeMs, before.mtimeMs);
});

test("staged, unstaged, and collapsed untracked entries", async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, "tracked.txt"), "staged\n"); git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "unstaged\n");
  await mkdir(join(root, "untracked")); await writeFile(join(root, "untracked", "one"), "1");
  await writeFile(join(root, "untracked", "two"), "2");
  const s = await collectSnapshot(root);
  assert.deepEqual(s.counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
  assert.equal(s.changes.find(c => c.path === "tracked.txt").index, "M");
  assert.equal(s.changes.find(c => c.path === "tracked.txt").worktree, "M");
  assert.equal(s.changes.find(c => c.kind === "untracked").path, "untracked/");
});

test("rename preserves NUL-delimited original paths and unusual UTF-8 filenames", async t => {
  const { root } = await fixture(t);
  const filename = "-new name\n\t☃.txt";
  git(root, "mv", "--", "tracked.txt", filename);
  const s = await collectSnapshot(root);
  assert.equal(s.changes[0].kind, "rename"); assert.equal(s.changes[0].path, filename);
  assert.equal(s.changes[0].originalPath, "tracked.txt");
  assert.ok(formatSnapshot(s).includes(JSON.stringify(filename)));
});

test("unborn and detached HEAD", async t => {
  const { root } = await fixture(t, false);
  const unborn = await collectSnapshot(root);
  assert.equal(unborn.unborn, true); assert.equal(unborn.head, null); assert.equal(unborn.branch, "main");
  git(root, "commit", "--allow-empty", "-m", "initial"); git(root, "checkout", "--detach");
  const detached = await collectSnapshot(root);
  assert.equal(detached.detached, true); assert.equal(detached.branch, null); assert.equal(detached.unborn, false);
});

test("ahead/behind uses local refs, fast mode skips counts", async t => {
  const { root, parent } = await fixture(t);
  const remote = join(parent, "remote.git"); git(root, "clone", "--bare", root, remote);
  git(root, "remote", "add", "origin", remote); git(root, "fetch", "origin");
  git(root, "branch", "--set-upstream-to=origin/main");
  git(root, "commit", "--allow-empty", "-m", "ahead");
  const s = await collectSnapshot(root);
  assert.equal(s.upstream, "origin/main"); assert.equal(s.ahead, 1); assert.equal(s.behind, 0);
  // Remote reachability is irrelevant: collection must not fetch or contact it.
  git(root, "remote", "set-url", "origin", "/does-not-exist");
  const fast = await collectSnapshot(root, { fast: true });
  assert.equal(fast.aheadBehindRequested, false); assert.equal(fast.ahead, null); assert.equal(fast.behind, null);
});

test("merge conflicts are distinct from ordinary staged changes", async t => {
  const { root } = await fixture(t);
  git(root, "checkout", "-b", "other"); await writeFile(join(root, "tracked.txt"), "other\n");
  git(root, "commit", "-am", "other"); git(root, "checkout", "main");
  await writeFile(join(root, "tracked.txt"), "main\n"); git(root, "commit", "-am", "main");
  assert.throws(() => git(root, "merge", "other"));
  const s = await collectSnapshot(root);
  assert.equal(s.counts.conflicts, 1); assert.equal(s.changes[0].kind, "unmerged");
});

test("linked worktrees and locks", async t => {
  const { root, parent } = await fixture(t);
  const linked = join(parent, "linked\nworktree"); git(root, "worktree", "add", "-b", "linked", linked);
  git(root, "worktree", "lock", "--reason", "keep this\nworktree", linked);
  const s = await collectSnapshot(linked, { worktrees: true });
  assert.equal(s.root, linked); assert.equal(s.branch, "linked");
  assert.equal(s.worktrees.length, 2);
  assert.equal(s.worktrees.find(w => w.path === linked).locked, "keep this\nworktree");
});

test("whitespace checks cover staged and unstaged output, ignoring external diff", async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, "tracked.txt"), "bad staged  \n"); git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "bad unstaged  \n");
  git(root, "config", "diff.external", "/does-not-exist");
  const s = await collectSnapshot(root, { whitespaceCheck: true });
  assert.equal(s.whitespace.staged.ok, false); assert.equal(s.whitespace.unstaged.ok, false);
  assert.match(s.whitespace.staged.output, /trailing whitespace/);
});

test("presentation caps do not corrupt totals; full artifact is private", async t => {
  const { root } = await fixture(t);
  await Promise.all(Array.from({ length: 130 }, (_, i) => writeFile(join(root, `new-${i}`), "x")));
  const s = await collectSnapshot(root);
  t.after(() => rm(dirname(s.artifact), { recursive: true, force: true }));
  assert.equal(s.capped, true); assert.equal(s.counts.untracked, 130); assert.equal(s.totalChanges, 130);
  assert.equal(s.changes.length, 100);
  const full = JSON.parse(await readFile(s.artifact, "utf8")); assert.equal(full.changes.length, 130);
  assert.equal((await stat(s.artifact)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(s.artifact))).mode & 0o777, 0o700);
});

test("non-repository, missing path, and cancellation fail explicitly", async t => {
  const { root, parent } = await fixture(t);
  await assert.rejects(collectSnapshot(parent), /failed/);
  await assert.rejects(collectSnapshot(root, { path: "missing" }), /failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectSnapshot(root, {}, controller.signal), /cancelled/);
});

test("caller Git routing overrides cannot select a different repository", async t => {
  const { root } = await fixture(t);
  const previous = process.env.GIT_DIR; process.env.GIT_DIR = "/does-not-exist";
  try { assert.equal((await collectSnapshot(root)).branch, "main"); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
});

test("parsers handle fast headers, submodule flags, and reject malformed records", () => {
  assert.equal(parseStatus("# branch.ab +? -?\0").ahead, null);
  const sub = parseStatus("1 .M S.M. 160000 160000 160000 abc def module\0");
  assert.equal(sub.changes[0].submodule, "S.M."); assert.equal(sub.counts.unstaged, 1);
  assert.throws(() => parseStatus("1 incomplete\0"), /Malformed/);
  assert.throws(() => parseStatus("surprise\0"), /Unexpected/);
  const [tree] = parseWorktrees("worktree /tmp/r\0HEAD abc\0detached\0locked\0prunable gone\0\0");
  assert.equal(tree.locked, ""); assert.equal(tree.prunable, "gone"); assert.equal(tree.detached, true);
});

test("submodule modifications remain visible even when repository config ignores them", async t => {
  const { root, parent } = await fixture(t);
  const source = join(parent, "submodule-source"); await mkdir(source); git(source, "init", "-b", "main");
  await writeFile(join(source, "child"), "original\n"); git(source, "add", "."); git(source, "commit", "-m", "child");
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
  git(root, "commit", "-am", "submodule"); git(root, "config", "submodule.module.ignore", "all");
  await writeFile(join(root, "module", "child"), "changed\n");
  const s = await collectSnapshot(root);
  assert.equal(s.clean, false);
  assert.equal(s.changes.find(c => c.path === "module").submodule, "S.M.");
});

test("byte budget handles long paths without losing complete counts", async t => {
  const { root } = await fixture(t);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, `${i}-` + "x".repeat(240)), "x")));
  const s = await collectSnapshot(root);
  t.after(() => rm(dirname(s.artifact), { recursive: true, force: true }));
  assert.equal(s.totalChanges, 100); assert.ok(s.changes.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= 16 * 1024);
  assert.ok(Buffer.byteLength(formatSnapshot(s)) < 50 * 1024);
  assert.equal(JSON.parse(await readFile(s.artifact, "utf8")).changes.length, 100);
});

test("Pi registration and structured schema", async t => {
  let tool;
  extension({ registerTool: definition => { tool = definition; } });
  assert.equal(tool.name, "repo_snapshot"); assert.equal(tool.annotations.readOnlyHint, true);
  const { root } = await fixture(t);
  const result = await tool.execute("snapshot-test", { worktrees: true, whitespaceCheck: true }, undefined, undefined, { cwd: root });
  assert.ok(Check(tool.outputSchema, result.structuredContent));
  assert.deepEqual(result.details, result.structuredContent);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Clean/);
});
