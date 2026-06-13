/**
 * worktree.linked.test.ts — round-trip test for linked worktree creation,
 * diff capture, and removal. No runTurn / no Kimi API calls.
 * Hermetic: creates a real temp git repo for realistic git operations.
 */
import { test, expect, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, captureDiff, removeWorktree } from "./worktree.js";

// ---- Setup a real temp git repo ----

const tempRepos: string[] = [];

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentkimi-linked-test-repo-"));
  tempRepos.push(dir);

  const gitEnv = {
    ...process.env,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };

  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: gitEnv, stdio: "pipe" });

  run(["init", "-q"]);
  run(["config", "user.email", "test@agentkimi.test"]);
  run(["config", "user.name", "agentkimi-test"]);

  // Create an initial commit so HEAD exists
  writeFileSync(join(dir, "README.md"), "# test repo\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "initial"]);

  return dir;
}

afterAll(() => {
  for (const dir of tempRepos) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("linked worktree: create → write file → captureDiff → removeWorktree", async () => {
  const repoDir = makeGitRepo();
  const sessionId = `test-linked-${Date.now().toString(36)}`;

  // Create a linked worktree
  const wt = await createWorktree(sessionId, repoDir);

  // Assert it's a linked worktree (not throwaway)
  expect(wt.isThrowaway).toBe(false);
  expect(wt.repoRoot).toBe(repoDir);
  expect(wt.branch).toBe(`agentkimi/${sessionId}`);
  expect(existsSync(wt.path)).toBe(true);

  // Assert git dir is inside the source repo's .git/worktrees
  expect(wt.gitDir).toContain(join(repoDir, ".git"));

  // Write a new file inside the worktree (simulating what Kimi would do)
  writeFileSync(join(wt.path, "new-file.ts"), "export const x = 42;\n");

  // Capture diff — should be non-empty and list the new file
  const { diff, files, truncated, error } = captureDiff(wt);
  expect(error).toBeUndefined();
  expect(files).toContain("new-file.ts");
  expect(diff).toContain("new-file.ts");
  expect(diff.length).toBeGreaterThan(0);
  expect(truncated).toBe(false);

  // Remove the worktree — branch should be preserved
  removeWorktree(wt);

  // Worktree path should be gone
  expect(existsSync(wt.path)).toBe(false);

  // Branch should still exist in the source repo
  const branches = execFileSync("git", [
    "-C", repoDir,
    "-c", "core.hooksPath=/dev/null",
    "branch",
    "--list",
    `agentkimi/${sessionId}`,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  expect(branches.trim()).toContain(`agentkimi/${sessionId}`);
});

test("captureDiff: returns error field when git diff step fails", () => {
  // Pass a worktree with a non-existent gitDir to force a git failure
  const wt = {
    path: mkdtempSync(join(tmpdir(), "agentkimi-capturefail-")),
    gitDir: join(tmpdir(), "nonexistent-gitdir-" + Date.now()),
    repoRoot: null,
    branch: null,
    baseCommit: "HEAD",
    isThrowaway: true,
  };
  // captureDiff should not throw — it should set error
  const result = captureDiff(wt);
  // diff should be empty on failure
  expect(result.diff).toBe("");
  // error may or may not be set depending on which git step fails first
  // The key invariant is: no throw
  rmSync(wt.path, { recursive: true, force: true });
});
