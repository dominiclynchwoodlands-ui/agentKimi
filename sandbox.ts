#!/usr/bin/env bun
/**
 * sandbox.ts — isolated config dir + PreToolUse hook + canUseTool gate.
 *
 * Security invariants:
 *   1. settings.json has DENY rules only — no allow block (an allow rule bypasses canUseTool).
 *   2. The PreToolUse hook is the PRIMARY enforcer. It fires regardless of settings
 *      precedence and independently enforces worktree confinement + denylist.
 *   3. canUseTool is a SECONDARY path-confinement layer.
 *   4. Path confinement uses symlink-safe resolution (C1 fix): deepest-existing-ancestor
 *      is realpathSync'd; non-existent tail appended; segment-boundary check. NO lexical fallback.
 *
 * LIMITATION: in-process Bash gating (C2) raises the bar against naive access but CANNOT
 * confine a jailbroken Kimi — interpreters (python, node) defeat command-string filtering.
 * The real protections are the workdir guardrail (server.ts) and minimal secret footprint (config.ts).
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, sep } from "node:path";
import type {
  CanUseTool,
  HookCallback,
  SyncHookJSONOutput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { CFG_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Deny-list constants
// ---------------------------------------------------------------------------

/**
 * Bash commands that are unconditionally denied.
 * NOTE: this is a best-effort heuristic. It cannot confine interpreters.
 * The workdir guardrail and clean child env are the load-bearing protections.
 */

// Egress tools
const EGRESS_RE = /\b(curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|rsync)\b/;

// Env / process introspection
const INTROSPECT_RE = /\b(printenv|env\b)\b|(?:^|\s)set(?:\s|$)|\/(proc\/(?:[0-9]+|self|thread-self)\/(environ|cmdline|maps))\b/;

// Destructive ops — cover all flag spellings: -rf, -fr, --recursive --force, etc.
const DESTRUCTIVE_RE =
  /\brm\b[^|&;]*(-[^-\s]*[rR]|--(recursive|force))|(?<![a-zA-Z0-9_])(dd|mkfs[\w.]*|shred|wipefs|parted|sudo|doas\b|su\b|systemctl|service\b|crontab|at\b|mount|umount|kill|pkill)\b|\bgit\s+(push|remote\s+set-url)\b|\bgh\s+|\b(chmod|chown)\s/;

// Symlink creation commands
const SYMLINK_RE = /\bln\s/;

/** Path tokens that are always denied (applied to both tool paths and Bash commands). */
const DENIED_PATH_PATTERNS = [
  /\.env($|[^a-zA-Z0-9_])/,
  /\/\.ssh\b/,
  /\/\.aws\b/,
  /\/\.git-credentials\b/,
  /\/\.claude/,
];

function hasDeniedPathToken(s: string): boolean {
  return DENIED_PATH_PATTERNS.some((re) => re.test(s));
}

// ---------------------------------------------------------------------------
// Symlink-safe path confinement (C1 fix)
// ---------------------------------------------------------------------------

/**
 * Canonicalize a path relative to a worktree using the deepest-existing-ancestor strategy.
 *
 * - Resolves the deepest directory ancestor that actually exists on disk via realpathSync.
 * - Appends the non-existent tail (preserving the target name without resolution).
 * - Performs a segment-boundary check (not substring) against the canonical worktree root.
 * - REJECTS if any existing path component is a symlink that resolves outside the worktree.
 * - NO lexical fallback: if we cannot determine safety, we DENY.
 *
 * Returns the canonical absolute path, or throws with a human-readable reason.
 */
function canonicalizeInsideWorktree(rawPath: string, canonicalWorktree: string): string {
  // Make absolute
  const abs = rawPath.startsWith("/") ? rawPath : join(canonicalWorktree, rawPath);

  // Walk from longest prefix to shortest until we find an existing ancestor
  const parts = abs.split(sep).filter(Boolean);
  let resolvedAncestor = "";
  let tail: string[] = [];

  for (let i = parts.length; i >= 1; i--) {
    const candidate = sep + parts.slice(0, i).join(sep);
    if (existsSync(candidate)) {
      try {
        resolvedAncestor = realpathSync(candidate);
        tail = parts.slice(i);
        break;
      } catch {
        // realpathSync failed on existing path — deny conservatively
        throw new Error(`realpath failed on existing path: ${candidate}`);
      }
    }
  }

  // If nothing resolved (e.g. abs starts with non-existent root), deny
  if (!resolvedAncestor) {
    throw new Error(`no existing ancestor found for: ${abs}`);
  }

  // Check the resolved ancestor itself is inside the worktree
  if (!isWithinRoot(resolvedAncestor, canonicalWorktree)) {
    throw new Error(`ancestor ${resolvedAncestor} escapes worktree ${canonicalWorktree}`);
  }

  // Check that none of the already-resolved path components is a symlink leaving the worktree.
  // We do this by checking each prefix of the resolved ancestor.
  const ancParts = resolvedAncestor.split(sep).filter(Boolean);
  const wtParts = canonicalWorktree.split(sep).filter(Boolean);
  // Only check components INSIDE the worktree (below its depth)
  for (let i = wtParts.length + 1; i <= ancParts.length; i++) {
    const prefix = sep + ancParts.slice(0, i).join(sep);
    try {
      const stat = lstatSync(prefix);
      if (stat.isSymbolicLink()) {
        const linkTarget = realpathSync(prefix);
        if (!isWithinRoot(linkTarget, canonicalWorktree)) {
          throw new Error(`symlink ${prefix} → ${linkTarget} escapes worktree`);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished — deny
      throw e;
    }
  }

  // Construct final path: resolved ancestor + non-existent tail
  const final = tail.length > 0 ? join(resolvedAncestor, ...tail) : resolvedAncestor;

  // Segment-boundary check on the final path
  if (!isWithinRoot(final, canonicalWorktree)) {
    throw new Error(`final path ${final} escapes worktree ${canonicalWorktree}`);
  }

  return final;
}

/** Segment-boundary containment check: path must equal root or start with root + "/". */
function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

// ---------------------------------------------------------------------------
// Config dir setup
// ---------------------------------------------------------------------------

/**
 * Create ~/.agentkimi/cfg/ with:
 *   skills/ → symlink to ~/.claude/skills
 *   settings.json with DENY rules only (no allow block)
 *
 * Idempotent — safe to call on every server start.
 */
export function ensureConfigDir(): void {
  mkdirSync(CFG_DIR, { recursive: true });

  // skills symlink
  const skillsLink = join(CFG_DIR, "skills");
  const skillsSrc = join(homedir(), ".claude", "skills");
  if (!existsSync(skillsLink) && existsSync(skillsSrc)) {
    symlinkSync(skillsSrc, skillsLink);
  }

  // settings.json — DENY only, NO allow block
  const settingsPath = join(CFG_DIR, "settings.json");
  const settings = {
    permissions: {
      deny: [
        "Read(**/.env)",
        "Read(**/.env.*)",
        "Read(**/secrets.env)",
        "Read(**/secrets.env.old)",
      ],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const k of ["file_path", "path", "notebook_path", "pattern"]) {
    const v = input[k];
    if (typeof v === "string") paths.push(v);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Shared gate logic — used by both hook and canUseTool
// ---------------------------------------------------------------------------

interface GateDecision {
  allow: boolean;
  reason: string;
}

function checkFilePath(rawPath: string, canonicalWorktree: string): GateDecision {
  if (hasDeniedPathToken(rawPath)) {
    return { allow: false, reason: `denied path pattern: ${rawPath}` };
  }
  try {
    canonicalizeInsideWorktree(rawPath, canonicalWorktree);
    return { allow: true, reason: "in-sandbox" };
  } catch (e) {
    return { allow: false, reason: (e as Error).message };
  }
}

function checkBashCommand(cmd: string, canonicalWorktree: string): GateDecision {
  if (DESTRUCTIVE_RE.test(cmd)) {
    return { allow: false, reason: "destructive command pattern" };
  }
  if (EGRESS_RE.test(cmd)) {
    return { allow: false, reason: "egress tool denied" };
  }
  if (INTROSPECT_RE.test(cmd)) {
    return { allow: false, reason: "env/process introspection denied" };
  }
  if (hasDeniedPathToken(cmd)) {
    return { allow: false, reason: "denied path token in command" };
  }
  // Deny ln/ln -s whose target would escape the worktree
  if (SYMLINK_RE.test(cmd)) {
    // Extract the target argument from `ln [-s] <target> <link>` — simple heuristic
    // e.g. `ln -s /etc <wt>/esc` — `/etc` is the (out-of-worktree) target we must reject
    const lnMatch = cmd.match(/\bln\s+(?:-[sS\s-]*\s+)?(\S+)\s+(\S+)/);
    if (lnMatch) {
      const target = lnMatch[1];
      if (target === undefined) {
        // Fail closed: regex matched but target group missing — cannot verify.
        return { allow: false, reason: "ln command: cannot verify target safety" };
      }
      if (target.startsWith("/") || target.startsWith("..")) {
        // Absolute or relative-escaping target: check if target is outside worktree
        const d = checkFilePath(target, canonicalWorktree);
        if (!d.allow) {
          return { allow: false, reason: `ln target escapes worktree: ${target}` };
        }
      }
    } else {
      // Can't parse ln args — deny conservatively
      return { allow: false, reason: "ln command: cannot verify target safety" };
    }
  }
  // M1 fix: expand ~ / $HOME / ${HOME} tokens to real HOME before abs-path check.
  // Shell would expand these at exec time; we must intercept them here.
  // Covers: ~/x  $HOME/x  ${HOME}/x  bare ~  $HOME  ${HOME}
  const HOME = homedir();
  const expandHome = (s: string): string =>
    s
      .replace(/\$\{HOME\}/g, HOME)
      .replace(/\$HOME(?=[/\s"'`;&|>]|$)/g, HOME)
      .replace(/(?<=^|[\s"'`=;|&>])(~)(?=[/\s"'`;&|>]|$)/g, HOME)
      .replace(/^~(?=\/|$)/, HOME);

  const cmdExpanded = expandHome(cmd);

  // Check absolute path tokens that canonicalize outside the worktree.
  // Run on BOTH the original cmd (catches /abs/paths) and the home-expanded form (catches ~/... $HOME/...).
  for (const source of [cmd, cmdExpanded]) {
    const absRe = /(?:^|[\s"'`=])(\/[^\s"'`;&|>]+)/g;
    for (const match of source.matchAll(absRe)) {
      const p = match[1];
      if (p === undefined) {
        // Fail closed: regex matched but path group missing — cannot verify.
        return { allow: false, reason: "absolute path token: cannot verify safety" };
      }
      if (!p.startsWith(canonicalWorktree + "/") && p !== canonicalWorktree) {
        return { allow: false, reason: `absolute path outside worktree: ${p}` };
      }
    }
  }
  return { allow: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Test exports (used by smoke.ts only — not part of the MCP surface)
// ---------------------------------------------------------------------------

export { checkFilePath as checkFilePath_test, checkBashCommand as checkBashCommand_test };

// ---------------------------------------------------------------------------
// Primary enforcer: PreToolUse hook
// ---------------------------------------------------------------------------

export function buildHook(canonicalWorktree: string, log: string[]): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };

    const toolName: string = (input as { tool_name: string }).tool_name;
    const toolInput = (input as { tool_input: Record<string, unknown> }).tool_input ?? {};

    if (toolName !== "Bash") {
      for (const p of extractFilePaths(toolInput)) {
        const d = checkFilePath(p, canonicalWorktree);
        if (!d.allow) {
          log.push(`HOOK DENY ${toolName} :: ${d.reason}`);
          return {
            decision: "block",
            reason: d.reason,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: d.reason,
            },
          };
        }
      }
    }

    if (toolName === "Bash") {
      const cmd = String(toolInput.command ?? "");
      const d = checkBashCommand(cmd, canonicalWorktree);
      if (!d.allow) {
        log.push(`HOOK DENY Bash :: ${d.reason} :: ${cmd.slice(0, 80)}`);
        return {
          decision: "block",
          reason: d.reason,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: d.reason,
          },
        };
      }
    }

    log.push(`HOOK ALLOW ${toolName}`);
    return { continue: true };
  };
}

// ---------------------------------------------------------------------------
// Secondary layer: canUseTool
// ---------------------------------------------------------------------------

export function buildCanUseTool(canonicalWorktree: string, log: string[]): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName !== "Bash") {
      for (const p of extractFilePaths(input)) {
        const d = checkFilePath(p, canonicalWorktree);
        if (!d.allow) {
          log.push(`canUseTool DENY ${toolName} :: ${d.reason}`);
          return { behavior: "deny", message: `sandbox: ${d.reason}` };
        }
      }
    }

    if (toolName === "Bash") {
      const cmd = String((input as { command?: string }).command ?? "");
      const d = checkBashCommand(cmd, canonicalWorktree);
      if (!d.allow) {
        log.push(`canUseTool DENY Bash :: ${d.reason} :: ${cmd.slice(0, 80)}`);
        return { behavior: "deny", message: `sandbox: ${d.reason}` };
      }
    }

    log.push(`canUseTool ALLOW ${toolName}`);
    return { behavior: "allow", updatedInput: input as Record<string, unknown> };
  };
}
