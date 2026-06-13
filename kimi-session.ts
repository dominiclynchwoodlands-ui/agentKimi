#!/usr/bin/env bun
/**
 * kimi-session.ts — runTurn(): spawns kimi-worker.ts inside a bwrap namespace.
 *
 * // TODO(bwrap) DONE — bwrap is now PRIMARY confinement.
 * Home-dir secrets (~/.ssh, ~/.aws, etc.) are not mounted in the namespace
 * and are unreachable by any means, including interpreters.
 * The in-process hook + canUseTool gate (sandbox.ts) is SECONDARY: it enforces
 * worktree confinement for the tools the SDK dispatches from inside the namespace.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildKimiEnv, CFG_DIR } from "./config.js";
import { ensureConfigDir } from "./sandbox.js";
import { buildBwrapArgv } from "./bwrap.js";
import type { Worktree } from "./worktree.js";
import type { WorkerJob, WorkerResult } from "./kimi-worker.js";

const HOME = homedir();
const PROJECT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const BUN_BIN = join(HOME, ".bun", "bin", "bun");
const WORKER_SCRIPT = join(PROJECT_DIR, "kimi-worker.ts");

const DEFAULT_TURN_TIMEOUT_MS = 660_000;
const MAX_TURN_TIMEOUT_MS = 3_600_000;

/** Resolve the turn timeout from AGENTKIMI_TURN_TIMEOUT_MS env var.
 *  Only strict decimal integers (no floats, no scientific notation, no hex,
 *  no leading/trailing junk) are accepted — anything else returns the default.
 */
export function resolveTurnTimeoutMs(): number {
  const raw = process.env.AGENTKIMI_TURN_TIMEOUT_MS;
  if (!raw) return DEFAULT_TURN_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(parsed, MAX_TURN_TIMEOUT_MS);
}

export interface TurnResult {
  sessionId: string;
  summary: string;
  toolsFired: string[];
  testOutput: string | null;
  subtype?: string;
  isError?: boolean;
}

/** Parse the outcome of a spawned worker process into a TurnResult or throw. */
export function parseWorkerOutcome(proc: {
  status: number | null;
  signal?: string | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error | null;
}): TurnResult {
  // 1. spawn-level error (bwrap itself failed to start)
  if (proc.error) {
    throw new Error(`bwrap spawn failed: ${proc.error.message}`);
  }

  // 2. Parse last non-empty stdout line as JSON
  const lines = (proc.stdout ?? "").split("\n").filter(Boolean);
  const lastLine = lines.at(-1);
  let parsed: WorkerResult | null = null;
  if (lastLine) {
    try {
      parsed = JSON.parse(lastLine) as WorkerResult;
    } catch {
      parsed = null;
    }
  }

  // 3. Non-zero exit — attach workerResult whenever parsed is present so callers
  //    can recover partial state (sessionId, etc.) even when error:"" is empty.
  if (proc.status !== 0) {
    const signalInfo = proc.signal ? ` (killed by signal ${proc.signal})` : "";
    const message = parsed?.error
      ? `kimi-worker error: ${parsed.error}`
      : `kimi-worker exited ${proc.status}${signalInfo}. stderr: ${(proc.stderr ?? "").slice(0, 400)}`;
    const err = new Error(message);
    if (parsed !== null) {
      (err as Error & { workerResult: WorkerResult }).workerResult = parsed;
    }
    throw err;
  }

  // 4. Status 0 but no parseable output
  if (!parsed) {
    throw new Error("kimi-worker produced no output");
  }

  // 5. Status 0 but worker reported an error
  if (parsed.error) {
    throw Object.assign(new Error(`kimi-worker error: ${parsed.error}`), { workerResult: parsed });
  }

  // 6. Happy path
  return {
    sessionId: parsed.sessionId,
    summary: parsed.summary,
    toolsFired: parsed.toolsFired,
    testOutput: parsed.testOutput,
    subtype: parsed.subtype,
    isError: parsed.isError,
  };
}

export interface RunTurnParams {
  prompt: string;
  worktree: Worktree;
  resume?: string;
}

export async function runTurn(params: RunTurnParams): Promise<TurnResult> {
  const { prompt, worktree, resume } = params;

  ensureConfigDir();

  // Per-turn empty sandbox home: a real dir on disk so bwrap can bind it.
  // It is EMPTY — no .ssh, .aws, .git-credentials, .npmrc, nothing.
  const sandboxHome = mkdtempSync(join(tmpdir(), "agentkimi-home-"));
  // Pre-create .claude dir so skills ro-bind has a parent inside the namespace.
  mkdirSync(join(sandboxHome, ".claude"), { recursive: true });

  const noNet = process.env.AGENTKIMI_NO_NET === "1";

  const bwrapCfg = {
    worktree: worktree.path,
    sandboxHome,
    cfgDir: CFG_DIR,
    projectDir: PROJECT_DIR,
    noNet,
  };

  // CLAUDE_CONFIG_DIR points to the sandboxHome's .claude dir.
  // ensureConfigDir() has already written deny-only settings.json to CFG_DIR;
  // we pass that same CFG_DIR as the config dir — it's bind-mounted into the namespace.
  const workerEnv = buildKimiEnv(CFG_DIR);

  const job: WorkerJob = {
    prompt,
    worktreePath: worktree.path,
    cfgDir: CFG_DIR,
    env: workerEnv,
    resume,
  };

  const workerArgv = [BUN_BIN, WORKER_SCRIPT];
  const bwrapArgv = buildBwrapArgv(bwrapCfg, workerArgv);

  const proc = spawnSync(bwrapArgv[0], bwrapArgv.slice(1), {
    input: JSON.stringify(job),
    encoding: "utf8",
    timeout: resolveTurnTimeoutMs(),
    maxBuffer: 50 * 1024 * 1024,
  });

  // Always clean up sandbox home
  try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* best-effort */ }

  // Forward gate logs from worker stderr
  if (proc.stderr) {
    for (const line of proc.stderr.split("\n").filter(Boolean)) {
      process.stderr.write(line + "\n");
    }
  }

  return parseWorkerOutcome(proc);
}
