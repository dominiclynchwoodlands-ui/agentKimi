#!/usr/bin/env bun
/**
 * config.ts — Kimi key resolution + locked child-env builder.
 *
 * SECURITY: never echoes the key, never spreads process.env.
 * The caller receives an explicit object containing ONLY the vars Kimi needs.
 * launch.sh exports ONLY the Kimi key into the server process — no mainnet keys.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// --- Constants ---

export const KIMI_BASE_URL = "https://api.moonshot.ai/anthropic";
export const KIMI_MODEL = "kimi-k2.7-code";

/** Runtime state root: ~/.agentkimi/ */
export const AGENTKIMI_HOME = join(homedir(), ".agentkimi");

/** Isolated config dir (shared, created once by ensureConfigDir). */
export const CFG_DIR = join(AGENTKIMI_HOME, "cfg");

/** Durable session registry. */
export const REGISTRY_PATH = join(AGENTKIMI_HOME, "sessions.json");

/** Worktree parent dir for throwaway repos. */
export const WORKTREES_DIR = join(AGENTKIMI_HOME, "worktrees");

/**
 * Server-only git-dir parent (NEVER bind-mounted into the sandbox).
 * Throwaway repos keep their git-dir here, separated from the worktree, so a
 * sandboxed Kimi cannot write `.git/config` to plant a diff/filter/textconv
 * command that the unsandboxed server would execute during diff capture (F1).
 */
export const GITDIRS_DIR = join(AGENTKIMI_HOME, "gitdirs");

// --- Key resolution ---

/** Env var names to probe for the Moonshot / Kimi key (first non-empty wins). */
const KEY_ENVS = ["KIMI_API_KEY", "MOONSHOT_API_KEY"] as const;

/**
 * Resolve the Kimi API key from process.env only.
 *
 * launch.sh exports ONLY this key into the server process (never the full env file).
 * For local dev / smoke tests, set KIMI_API_KEY directly in the shell.
 *
 * NEVER echoes or logs the returned value.
 */
export function resolveKimiKey(): string {
  for (const k of KEY_ENVS) {
    const v = process.env[k];
    if (v && !v.startsWith("YOUR_")) return v;
  }
  throw new Error(
    "No Kimi API key found. Set KIMI_API_KEY (or MOONSHOT_API_KEY). " +
    "If using launch.sh, ensure AGENTKIMI_ENV_FILE points to a file containing KIMI_API_KEY=..."
  );
}

/**
 * Build the locked child env for Kimi's claude process.
 *
 * INVARIANT: only PATH, HOME, CLAUDE_CONFIG_DIR, and Moonshot vars are included.
 * Mainnet trading keys from process.env are NEVER propagated.
 */
export function buildKimiEnv(cfgDir: string): Record<string, string> {
  const key = resolveKimiKey();
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    CLAUDE_CONFIG_DIR: cfgDir,
    ANTHROPIC_BASE_URL: KIMI_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: KIMI_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: KIMI_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: KIMI_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: KIMI_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: KIMI_MODEL,
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
    API_TIMEOUT_MS: "600000",
    CLAUDE_CODE_MAX_RETRIES: "3",
  };
}
