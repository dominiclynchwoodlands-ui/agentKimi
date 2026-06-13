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

export interface TurnResult {
  sessionId: string;
  summary: string;
  toolsFired: string[];
  testOutput: string | null;
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
    timeout: 660_000, // 11 min — allows maxTurns:30 × ~20s each
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

  if (proc.error) throw new Error(`bwrap spawn failed: ${proc.error.message}`);
  if (proc.status !== 0) {
    throw new Error(
      `kimi-worker exited ${proc.status}. stderr: ${(proc.stderr ?? "").slice(0, 400)}`
    );
  }

  // Parse the last JSON line from stdout (worker writes exactly one JSON line)
  const lines = (proc.stdout ?? "").split("\n").filter(Boolean);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) throw new Error("kimi-worker produced no output");
  const result: WorkerResult = JSON.parse(lastLine);

  if (result.error) throw new Error(`kimi-worker error: ${result.error}`);

  return {
    sessionId: result.sessionId,
    summary: result.summary,
    toolsFired: result.toolsFired,
    testOutput: result.testOutput,
  };
}
