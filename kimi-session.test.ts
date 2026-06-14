/**
 * kimi-session.test.ts — unit tests for parseWorkerOutcome and resolveTurnTimeoutMs.
 * Hermetic: no network, no API keys required.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { parseWorkerOutcome, resolveTurnTimeoutMs } from "./kimi-session.js";

// --- parseWorkerOutcome ---

test("parseWorkerOutcome: status 1 + WorkerResult JSON with error → thrown message contains real error, not stderr noise", () => {
  const result: WorkerResult = {
    sessionId: "sess-abc",
    summary: "",
    testOutput: null,
    toolsFired: [],
    error: "REAL_BOOM",
  };
  const proc = {
    status: 1,
    stdout: JSON.stringify(result) + "\n",
    stderr: "[gate] noise from bwrap\n",
    error: null,
  };
  expect(() => parseWorkerOutcome(proc)).toThrow("REAL_BOOM");
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    expect((e as Error).message).toContain("REAL_BOOM");
    expect((e as Error).message).not.toContain("[gate]");
  }
});

test("parseWorkerOutcome: status 1 + unparseable stdout → falls back to stderr message", () => {
  const proc = {
    status: 1,
    stdout: "not json at all\n",
    stderr: "some bwrap stderr failure",
    error: null,
  };
  expect(() => parseWorkerOutcome(proc)).toThrow("some bwrap stderr failure");
});

test("parseWorkerOutcome: status 0 + valid result → returns TurnResult", () => {
  const workerResult: WorkerResult = {
    sessionId: "sess-xyz",
    summary: "all done",
    testOutput: null,
    toolsFired: ["Write", "Bash"],
  };
  const proc = {
    status: 0,
    stdout: JSON.stringify(workerResult) + "\n",
    stderr: "",
    error: null,
  };
  const result = parseWorkerOutcome(proc);
  expect(result.sessionId).toBe("sess-xyz");
  expect(result.summary).toBe("all done");
  expect(result.toolsFired).toEqual(["Write", "Bash"]);
});

test("parseWorkerOutcome: proc.error set (non-timeout) → 'bwrap spawn failed'", () => {
  const proc = {
    status: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error("ENOENT: bwrap not found"), { code: "ENOENT" }),
  };
  expect(() => parseWorkerOutcome(proc)).toThrow("bwrap spawn failed");
  expect(() => parseWorkerOutcome(proc)).toThrow("ENOENT: bwrap not found");
});

test("parseWorkerOutcome: proc.error ETIMEDOUT + sentinel in stderr → throws 'timed out' with workerResult.sessionId recovered", () => {
  const proc = {
    status: null,
    stdout: null,
    stderr: "some gate noise\n__AGENTKIMI_SESSION__ abc123\nmore noise",
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
  let thrown: unknown;
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect((thrown as Error).message).toContain("timed out");
  expect((thrown as { workerResult?: { sessionId: string } }).workerResult?.sessionId).toBe("abc123");
});

test("parseWorkerOutcome: proc.error ETIMEDOUT + no sentinel in stderr → throws 'timed out' with no workerResult", () => {
  const proc = {
    status: null,
    stdout: null,
    stderr: "some gate noise without a session id",
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
  let thrown: unknown;
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect((thrown as Error).message).toContain("timed out");
  expect((thrown as { workerResult?: unknown }).workerResult).toBeUndefined();
});

test("parseWorkerOutcome: status 0 + no output → 'kimi-worker produced no output'", () => {
  const proc = {
    status: 0,
    stdout: "",
    stderr: "",
    error: null,
  };
  expect(() => parseWorkerOutcome(proc)).toThrow("kimi-worker produced no output");
});

test("parseWorkerOutcome: status 0 + worker error field → throws with workerResult attached", () => {
  const workerResult: WorkerResult = {
    sessionId: "sess-err",
    summary: "",
    testOutput: null,
    toolsFired: [],
    error: "some internal error",
  };
  const proc = {
    status: 0,
    stdout: JSON.stringify(workerResult) + "\n",
    stderr: "",
    error: null,
  };
  let thrown: unknown;
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect((thrown as Error).message).toContain("some internal error");
  expect((thrown as { workerResult?: WorkerResult }).workerResult).toBeDefined();
});

test("parseWorkerOutcome: status 1 + error:'' + sessionId present → throws with workerResult attached (sessionId recoverable)", () => {
  // Regression for empty-error-string edge case: even when parsed.error is ""
  // (falsy), the workerResult must still be attached so finalizeFailedTurn can
  // recover the partial sessionId.
  const workerResult: WorkerResult = {
    sessionId: "recovered-session-id",
    summary: "",
    testOutput: null,
    toolsFired: [],
    error: "", // empty string — falsy
  };
  const proc = {
    status: 1,
    stdout: JSON.stringify(workerResult) + "\n",
    stderr: "some stderr noise",
    error: null,
  };
  let thrown: unknown;
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  // Falls to generic stderr message (error:"" is empty) but workerResult is still attached
  const wr = (thrown as { workerResult?: WorkerResult }).workerResult;
  expect(wr).toBeDefined();
  expect(wr!.sessionId).toBe("recovered-session-id");
});

test("parseWorkerOutcome: status null + signal SIGTERM → thrown message contains 'SIGTERM'", () => {
  const proc = {
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "x",
    error: null,
  };
  let thrown: unknown;
  try {
    parseWorkerOutcome(proc);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect((thrown as Error).message).toContain("SIGTERM");
});

// --- resolveTurnTimeoutMs ---

const DEFAULT = 660_000;
const MAX = 3_600_000;

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.AGENTKIMI_TURN_TIMEOUT_MS;
  delete process.env.AGENTKIMI_TURN_TIMEOUT_MS;
});
afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.AGENTKIMI_TURN_TIMEOUT_MS = savedEnv;
  } else {
    delete process.env.AGENTKIMI_TURN_TIMEOUT_MS;
  }
});

test("resolveTurnTimeoutMs: unset → default", () => {
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: NaN string → default", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "not-a-number";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: scientific notation '3.6e6' → default (rejected by strict regex)", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "3.6e6";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: scientific notation '1e6' → default", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "1e6";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: trailing junk '120000abc' → default", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "120000abc";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: surrounded by spaces ' 120000 ' → 120000 (trim then valid)", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = " 120000 ";
  expect(resolveTurnTimeoutMs()).toBe(120_000);
});

test("resolveTurnTimeoutMs: 0 → default", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "0";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: negative → default", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "-1000";
  expect(resolveTurnTimeoutMs()).toBe(DEFAULT);
});

test("resolveTurnTimeoutMs: valid value within bounds → returned as-is", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "120000";
  expect(resolveTurnTimeoutMs()).toBe(120_000);
});

test("resolveTurnTimeoutMs: over max → capped at MAX", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = "9999999";
  expect(resolveTurnTimeoutMs()).toBe(MAX);
});

test("resolveTurnTimeoutMs: exactly max → allowed", () => {
  process.env.AGENTKIMI_TURN_TIMEOUT_MS = String(MAX);
  expect(resolveTurnTimeoutMs()).toBe(MAX);
});

// Type helper (not imported from worker to avoid circular concerns)
interface WorkerResult {
  sessionId: string;
  summary: string;
  testOutput: string | null;
  toolsFired: string[];
  error?: string;
  subtype?: string;
  isError?: boolean;
}
