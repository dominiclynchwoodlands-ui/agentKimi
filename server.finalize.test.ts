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
import { finalizeFailedTurn, decideTurnStatus, checkResumeAllowed } from "./server.js";
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
  const result = finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null, prevErrorCount: 0 });

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
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 3, prevSdkSessionId: "prev-sdk", prevErrorCount: 0 });

  const rec = loadSession(sessionId);
  expect(rec!.status).toBe("error");
  expect(rec!.turn).toBe(3);
  // workerResult.sessionId "sdk-abc" is non-empty → wins over prevSdkSessionId
  expect(rec!.sdk_session_id).toBe("sdk-abc");
  // error_count increments: 0 → 1
  expect(rec!.error_count).toBe(1);
});

// (c) empty workerResult.sessionId + prevSdkSessionId provided → stored prevSdkSessionId (NOT "")
test("finalizeFailedTurn: empty workerResult.sessionId falls back to prevSdkSessionId", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr(""); // empty sessionId in workerResult
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: "prev-sdk-xyz", prevErrorCount: 2 });

  const rec = loadSession(sessionId);
  expect(rec!.sdk_session_id).toBe("prev-sdk-xyz");
  // error_count increments: 2 → 3
  expect(rec!.error_count).toBe(3);
});

// (c) empty workerResult.sessionId + prevSdkSessionId null → stored null
test("finalizeFailedTurn: empty workerResult.sessionId + null prevSdkSessionId → stored null", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = makeErr("");
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null, prevErrorCount: 0 });

  const rec = loadSession(sessionId);
  expect(rec!.sdk_session_id).toBeNull();
});

// (timeout recovery) workerResult.sessionId from a SIGTERM-killed/ETIMEDOUT
// turn is persisted as sdk_session_id, and checkResumeAllowed then permits resume.
test("finalizeFailedTurn: recovered timeout workerResult.sessionId persisted, resume then allowed", () => {
  const sessionId = makeSessionId();
  cleanupIds.push(sessionId);
  const wt = makeWorktreeStub(false);
  saveSession(sessionId, wt);

  const err = Object.assign(new Error("kimi turn timed out after 660000ms"), {
    workerResult: {
      sessionId: "abc123",
      summary: "",
      testOutput: null,
      toolsFired: [],
      error: "turn timed out",
    },
  });
  finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null, prevErrorCount: 0 });

  const rec = loadSession(sessionId);
  expect(rec!.sdk_session_id).toBe("abc123");
  expect(checkResumeAllowed({ status: rec!.status, sdk_session_id: rec!.sdk_session_id, error_count: rec!.error_count })).toBeNull();
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
    result = finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null, prevErrorCount: 0 });
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
    finalizeFailedTurn({ sessionId, wt, err, nextTurn: 1, prevSdkSessionId: null, prevErrorCount: 0 });
  }).not.toThrow();
});

// --- decideTurnStatus ---

test("decideTurnStatus: isError:false → active, terminal:false", () => {
  expect(decideTurnStatus({ isError: false })).toEqual({ status: "active", terminal: false });
});

test("decideTurnStatus: isError:true + error_max_turns → active (resumable), terminal:false", () => {
  expect(decideTurnStatus({ isError: true, subtype: "error_max_turns" })).toEqual({ status: "active", terminal: false });
});

test("decideTurnStatus: isError:true + error_during_execution → error, terminal:true", () => {
  expect(decideTurnStatus({ isError: true, subtype: "error_during_execution" })).toEqual({ status: "error", terminal: true });
});

// --- checkResumeAllowed ---

test("checkResumeAllowed: closed → returns error string", () => {
  const result = checkResumeAllowed({ status: "closed", sdk_session_id: null });
  expect(result).not.toBeNull();
  expect(result).toContain("closed");
});

test("checkResumeAllowed: error + no sdk_session_id → returns error string", () => {
  const result = checkResumeAllowed({ status: "error", sdk_session_id: null });
  expect(result).not.toBeNull();
  expect(result).toContain("no resumable id");
});

test("checkResumeAllowed: error + sdk_session_id + error_count 3 → returns circuit-breaker string", () => {
  const result = checkResumeAllowed({ status: "error", sdk_session_id: "sdk-abc", error_count: 3 });
  expect(result).not.toBeNull();
  expect(result).toContain("3 consecutive");
});

test("checkResumeAllowed: error + sdk_session_id + error_count 1 → null (resume allowed)", () => {
  const result = checkResumeAllowed({ status: "error", sdk_session_id: "sdk-abc", error_count: 1 });
  expect(result).toBeNull();
});

test("checkResumeAllowed: active → null (no block)", () => {
  const result = checkResumeAllowed({ status: "active", sdk_session_id: "sdk-xyz" });
  expect(result).toBeNull();
});
