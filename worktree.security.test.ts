/**
 * worktree.security.test.ts — regression for the git command-execution RCE
 * (panel finding F1, confirmed CRITICAL).
 *
 * Threat: a jailbroken Kimi controls the contents of its worktree. It can plant
 * git diff drivers / textconv / clean filters via `.git/config` + `.gitattributes`.
 * The UNSANDBOXED server then runs `captureDiff` (git add -A -N; git diff) — which,
 * unhardened, executes those commands as the host user.
 *
 * Invariant under test: captureDiff must NEVER execute attacker-planted commands,
 * yet must still report the changed files.
 */
import { test, expect } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, captureDiff, removeWorktree, buildSafeGitEnv_test } from "./worktree.js";

const SENTINEL = "/tmp/agentkimi_test_rce_sentinel";

test("buildSafeGitEnv strips ALL GIT_* vars and pins the safe config knobs (F1 hardening)", () => {
  const saved = {
    p: process.env.GIT_CONFIG_PARAMETERS,
    x: process.env.GIT_EXEC_PATH,
    a: process.env.GIT_ATTR_SOURCE,
  };
  process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=/tmp/evil'";
  process.env.GIT_EXEC_PATH = "/tmp/evil-git-exec";
  process.env.GIT_ATTR_SOURCE = "/tmp/evil-attrs";
  try {
    const env = buildSafeGitEnv_test();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBeUndefined();
    expect(env.GIT_ATTR_SOURCE).toBeUndefined();
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.PATH).toBe(process.env.PATH); // non-GIT env preserved
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const key = { p: "GIT_CONFIG_PARAMETERS", x: "GIT_EXEC_PATH", a: "GIT_ATTR_SOURCE" }[k]!;
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
});

test("captureDiff does not execute attacker-planted git diff drivers/filters/textconv (F1)", async () => {
  rmSync(SENTINEL, { force: true });
  const id = "kimi-sectest-" + Math.floor(performance.now()).toString(36) + "-x";
  const wt = await createWorktree(id);
  try {
    const evil = `sh -c "echo fired > ${SENTINEL}; cat"`;
    // Kimi assigns every command-exec driver to all files via .gitattributes.
    writeFileSync(join(wt.path, ".gitattributes"), "* diff=pwn filter=fl diff=tc\n");
    // Kimi tries to DEFINE those drivers in the repo config (works only if it can
    // reach the real git-dir; the hardened design keeps the git-dir unmounted).
    const evilCfg =
      `[diff "pwn"]\n\tcommand = ${evil}\n` +
      `[diff "tc"]\n\ttextconv = ${evil}\n` +
      `[filter "fl"]\n\tclean = ${evil}\n`;
    try { mkdirSync(join(wt.path, ".git"), { recursive: true }); } catch { /* .git may be a file (separated git-dir) */ }
    try { writeFileSync(join(wt.path, ".git", "config"), evilCfg, { flag: "a" }); } catch { /* expected when .git is a pointer file */ }
    // Also drop the config somewhere the working tree always allows, in case a
    // future bug makes the server read it.
    writeFileSync(join(wt.path, ".git-evil-config"), evilCfg);
    // A changed/added file so `git diff` has something to run the driver against.
    writeFileSync(join(wt.path, "payload.bin"), "attacker controlled\n");

    const { files } = captureDiff(wt);

    expect(existsSync(SENTINEL)).toBe(false);   // RCE must not fire
    expect(files).toContain("payload.bin");     // diff must still work
  } finally {
    removeWorktree(wt);
    rmSync(SENTINEL, { force: true });
  }
});

test("captureDiff ignores an attacker-rewritten in-tree .git pointer (F1 — explicit --git-dir wins)", async () => {
  rmSync(SENTINEL, { force: true });
  const id = "kimi-sectest-ptr-" + Math.floor(performance.now()).toString(36) + "-x";
  const wt = await createWorktree(id);
  try {
    const evil = `sh -c "echo fired > ${SENTINEL}"`;
    // Kimi builds a fully-functional attacker git-dir INSIDE its worktree and
    // repoints `.git` at it. captureDiff must ignore it (it passes --git-dir explicitly).
    const fakeGit = join(wt.path, "fakegit");
    mkdirSync(fakeGit, { recursive: true });
    writeFileSync(
      join(fakeGit, "config"),
      `[core]\n\trepositoryformatversion = 0\n[diff "pwn"]\n\tcommand = ${evil}\n[filter "fl"]\n\tclean = ${evil}\n`
    );
    writeFileSync(join(wt.path, ".gitattributes"), "* diff=pwn filter=fl\n");
    rmSync(join(wt.path, ".git"), { recursive: true, force: true });
    writeFileSync(join(wt.path, ".git"), `gitdir: ${fakeGit}\n`);
    writeFileSync(join(wt.path, "payload.bin"), "x\n");

    const { files } = captureDiff(wt);
    expect(existsSync(SENTINEL)).toBe(false);
    expect(files).toContain("payload.bin");
  } finally {
    removeWorktree(wt);
    rmSync(SENTINEL, { force: true });
  }
});

test("linked worktree REFUSES a filter-defining source repo, fail closed, with no host RCE (F1 linked)", async () => {
  const SMUDGE = "/tmp/agentkimi_test_smudge_sentinel";
  const CLEAN = "/tmp/agentkimi_test_clean_sentinel";
  for (const f of [SMUDGE, CLEAN]) rmSync(f, { force: true });
  // A malicious source repo a user might point agentKimi at (committed .gitattributes
  // + filter commands in config). Built with raw git (the attacker's repo, not our code).
  const src = mkdtempSync(join(tmpdir(), "ak-malrepo-"));
  const g = (args: string[]) => execFileSync("git", ["-C", src, ...args], { stdio: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "a@b.c"]);
  g(["config", "user.name", "a"]);
  g(["config", "filter.pwn.smudge", `sh -c "echo x > ${SMUDGE}; cat"`]);
  g(["config", "filter.pwn.clean", `sh -c "echo x > ${CLEAN}; cat"`]);
  writeFileSync(join(src, ".gitattributes"), "* filter=pwn\n");
  writeFileSync(join(src, "f.txt"), "data\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  // The attacker's own `git add` above runs clean on their machine — irrelevant.
  // Clear sentinels so the assertion measures ONLY agentKimi's behaviour.
  for (const f of [SMUDGE, CLEAN]) rmSync(f, { force: true });

  const id = "kimi-sectest-linked-" + Math.floor(performance.now()).toString(36) + "-x";
  try {
    // createWorktree must REFUSE (fail closed) before any checkout runs.
    await expect(createWorktree(id, src)).rejects.toThrow(/filter driver/i);
    // and no filter command ran on the host during the refused attempt:
    expect(existsSync(SMUDGE)).toBe(false);
    expect(existsSync(CLEAN)).toBe(false);
  } finally {
    for (const f of [SMUDGE, CLEAN]) rmSync(f, { force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("linked worktree on a benign source repo (no filters) still works", async () => {
  const src = mkdtempSync(join(tmpdir(), "ak-benignrepo-"));
  const g = (args: string[]) => execFileSync("git", ["-C", src, ...args], { stdio: "ignore" });
  g(["init", "-q"]);
  g(["config", "user.email", "a@b.c"]);
  g(["config", "user.name", "a"]);
  writeFileSync(join(src, "f.txt"), "data\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  const id = "kimi-sectest-benign-" + Math.floor(performance.now()).toString(36) + "-x";
  const wt = await createWorktree(id, src);
  try {
    expect(wt.isThrowaway).toBe(false);                  // linked, not fallback throwaway
    writeFileSync(join(wt.path, "new.txt"), "hi from kimi\n");
    const { files } = captureDiff(wt);
    expect(files).toContain("new.txt");
  } finally {
    removeWorktree(wt);
    rmSync(src, { recursive: true, force: true });
  }
});

test("captureDiff is immune to GIT_CONFIG_PARAMETERS / GIT_* env config injection (F1 hardening)", async () => {
  rmSync(SENTINEL, { force: true });
  const evil = `sh -c "echo fired > ${SENTINEL}"`;
  const saved = process.env.GIT_CONFIG_PARAMETERS;
  // A hostile launch env tries to inject git config that runs a command on diff/add.
  // git()'s env builder must strip all GIT_* before invoking git.
  process.env.GIT_CONFIG_PARAMETERS = `'diff.pwn.command=${evil}' 'core.fsmonitor=${evil}'`;
  const id = "kimi-sectest-env-" + Math.floor(performance.now()).toString(36) + "-x";
  let wt;
  try {
    wt = await createWorktree(id);
    writeFileSync(join(wt.path, ".gitattributes"), "* diff=pwn\n");
    writeFileSync(join(wt.path, "payload.bin"), "x\n");
    captureDiff(wt);
    expect(existsSync(SENTINEL)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = saved;
    if (wt) removeWorktree(wt);
    rmSync(SENTINEL, { force: true });
  }
});
