/**
 * server.finalize.test.ts — direct-drive tests for finalizeFailedTurn (exported).
 * Hermetic: no network, no API calls. Uses real registry with unique session IDs
 * that are cleaned up after each test. Exercises the helper directly so regressions
 * in nextTurn, workerResult recovery, sdk_session_id precedence, and existsSync
 * guard are all caught.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeFailedTurn } from "./server.js";
import { saveSession, loadSession, closeSession } from "./registry.js";
import type { Worktree } from "./worktree.js";

const cleanupIds: string[] = [];
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const id of cleanupIds) {
    try { closeSession(id); } catch { /* best-effort */ }
  }
  cleanupIds.length = 0;
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  cleanupDirs.length = 0;
});

function makeSessionId() {
  return `test-finalize-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeWorktreeStub(exists: boolean): Worktree {
  let path: string;
  if (exists) {
    path = mkdtempSync(join(tmpdir(), "agentkimi-fin-wt-"));
    cleanupDirs.push(path);
  } else {
    path = join(tmpdir(), `agentkimi-fin-noexist-${Date.now()}`);
  }
  const gitDir = mkdtempSync(join(tmpdir(), "agentkimi-fin-gd-"));
  cleanupDirs.push(gitDir);
  return {
    path,
    gitDir,
    repoRoot: null,
    branch: null,
    baseCommit: "0000000000000000000000000000000000000000",
    isThrowaway: true,
  };
}

function makeErr(workerSessionId: string) {
  return Object.assign(new Error("kimi-worker error: BOOM"), {
    workerResult: {
      sessionId: workerSessionId,
      summary: "",
      testOutput: null,
      toolsFired: [],
      error: "BOOM",
    },
  });
}

// (a) returned result has isError:true and content text includes real error + session id
test("finalizeFailedTurn: result isError:true, content contains error and session id", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr("sdk-abc");
  const result = finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null });

  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  expect(text).toContain("BOOM");
  expect(text).toContain(sessionId);
});

// (b) registry updated: status:"error", turn===nextTurn, sdk_session_id recovered from workerResult
test("finalizeFailedTurn: registry updated to error, turn bumped, sdk_session_id from workerResult", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr("sdk-abc");
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 3, prevSdkSessionId: "prev-sdk" });

  const rec = loadSession(sessionId);
  expect(rec!.status).toBe("error");
  expect(rec!.turn).toBe(3);
  // workerResult.sessionId "sdk-abc" is non-empty → wins over prevSdkSessionId
  expect(rec!.sdk_session_id).toBe("sdk-abc");
});

// (c) empty workerResult.sessionId + prevSdkSessionId provided → stored prevSdkSessionId (NOT "")
test("finalizeFailedTurn: empty workerResult.sessionId falls back to prevSdkSessionId", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr(""); // empty sessionId in workerResult
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: "prev-sdk-xyz" });

  const rec = loadSession(sessionId);
  expect(rec!.sdk_session_id).toBe("prev-sdk-xyz");
});

// (c) empty workerResult.sessionId + prevSdkSessionId null → stored null
test("finalizeFailedTurn: empty workerResult.sessionId + null prevSdkSessionId → stored null", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr("");
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null });

  const rec = loadSession(sessionId);
  expect(rec!.sdk_session_id).toBeNull();
});

// (d) non-existent wt.path does NOT throw and yields empty diff section
test("finalizeFailedTurn: non-existent wt.path does not throw, returns empty diff", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  expect(existsSync(wt.path)).toBe(false);
  saveSession(sessionId, wt);

  const err = makeErr("sdk-abc");
  let result: ReturnType<typeof finalizeFailedTurn> | undefined;
  expect(() => {
    result = finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null });
  }).not.toThrow();
  expect(result).toBeDefined();
  // Empty diff section renders as "_No changes detected._"
  expect(result!.content[0]!.text).toContain("No changes detected");
});

// (d) existing wt.path (no git repo inside) does NOT throw — captureDiff error is swallowed
test("finalizeFailedTurn: existing wt.path (no git) does not throw", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(true); // path EXISTS but is empty (no git)
  saveSession(sessionId, wt);

  const err = makeErr("sdk-abc");
  expect(() => {
    finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null });
  }).not.toThrow();
});
