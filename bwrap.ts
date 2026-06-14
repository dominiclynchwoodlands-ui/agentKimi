#!/usr/bin/env bun
/**
 * bwrap.ts — builds the bubblewrap argv for a Kimi worker turn.
 *
 * Namespace design:
 *   PRIMARY boundary: bwrap mounts. Home-dir secrets are simply not mounted
 *     — unreachable by any means including interpreters.
 *   SECONDARY: in-process hook + canUseTool gate (worktree confinement).
 *
 * What IS mounted (read-only unless noted):
 *   /usr, /lib→usr/lib, /lib64→usr/lib (system bins + glibc)
 *   /etc/resolv.conf, /etc/ssl (TLS to Moonshot)
 *   bun binary + ~/.bun (runtime + Bun's own cache/libs)
 *   agentkimi project dir + node_modules (SDK + bundled claude binary)
 *   /sbx-tmp tmpfs (private per-session; SDK extracts claude binary here via CLAUDE_CODE_TMPDIR)
 *   <worktree> rw (Kimi's ONLY writable workspace)
 *   <sandboxHome> rw (tmpfs scratch; empty — no .ssh/.aws/.git-credentials)
 *   skills ro-bind: ~/.claude/skills → <sandboxHome>/.claude/skills (non-secret)
 *   cfgDir rw (deny-only settings.json written by ensureConfigDir)
 *
 * What is NOT mounted: $HOME, ~/.ssh, ~/.aws, ~/.git-credentials,
 *   ~/.npmrc, ~/.config/gh, any project secret dirs — unreachable by construction.
 *
 * Network: ON by default (Moonshot + WebFetch). Set AGENTKIMI_NO_NET=1 to
 *   --unshare-net for sensitive-repo work (Kimi can still do in-worktree tasks).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const BUN_BIN = join(HOME, ".bun", "bin", "bun");
const BUN_HOME = join(HOME, ".bun");

// Private tmpfs mount point inside the namespace for the SDK's binary extraction.
// CLAUDE_CODE_TMPDIR is honoured by extractFromBunfs.js:27 — the SDK extracts the
// bundled claude binary under <CLAUDE_CODE_TMPDIR>/claude-<uid>/ instead of the
// host-shared /tmp/claude-<uid>. This tmpfs exists ONLY inside this sandbox turn,
// vanishes on exit, and is NEVER shared with the host or other sessions.
// C-bwrap1 fix: the shared host /tmp/claude-<uid> is NOT mounted at all.
const PRIVATE_TMP_MOUNTPOINT = "/sbx-tmp";

export interface BwrapConfig {
  worktree: string;      // rw bind-mounted worktree path
  sandboxHome: string;   // rw tmpfs scratch home (empty)
  cfgDir: string;        // rw — deny-only settings.json
  projectDir: string;    // agentkimi project root (ro)
  noNet: boolean;        // true → --unshare-net
  allowSubagents?: boolean; // true → let the worker spawn its own sub-agents (Task tool)
}

export function buildBwrapArgv(cfg: BwrapConfig, workerArgs: string[]): [string, ...string[]] {
  const argv: [string, ...string[]] = ["/usr/bin/bwrap"];

  // --- F3: start the namespace from an EMPTY environment ---
  // bwrap inherits the parent env by default. The server process may carry the
  // Kimi key (exported by launch.sh) or host secrets inherited at launch — none
  // of which must be visible inside the sandbox (readable via /proc/1/environ by
  // an interpreter). --clearenv drops all of it; we --setenv only the minimum the
  // worker needs below. The SDK subprocess still gets its own clean env (job.env)
  // applied by the worker via query()'s `env` option.
  argv.push("--clearenv");

  // --- System read-only mounts ---
  argv.push("--ro-bind", "/usr", "/usr");
  argv.push("--symlink", "usr/lib", "/lib");
  argv.push("--symlink", "usr/lib", "/lib64");

  // --- Essential /etc ---
  argv.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
  if (existsSync("/etc/ssl")) argv.push("--ro-bind", "/etc/ssl", "/etc/ssl");
  if (existsSync("/etc/ca-certificates")) argv.push("--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates");
  // nsswitch + hosts for libc resolver
  if (existsSync("/etc/nsswitch.conf")) argv.push("--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf");
  if (existsSync("/etc/hosts")) argv.push("--ro-bind", "/etc/hosts", "/etc/hosts");

  // --- Proc / dev ---
  argv.push("--proc", "/proc");
  argv.push("--dev", "/dev");

  // --- Tmpfs mounts ---
  argv.push("--tmpfs", "/tmp");
  argv.push("--tmpfs", "/run");

  // --- Private tmpfs for SDK binary extraction (C-bwrap1 fix) ---
  // The SDK extracts its bundled claude binary to CLAUDE_CODE_TMPDIR/claude-<uid>/.
  // We use a private mountpoint (/sbx-tmp) that exists ONLY inside this namespace —
  // the host's shared /tmp/claude-<uid> is NOT mounted, so Kimi cannot overwrite
  // the host binary or read tasks/ output from other sessions.
  argv.push("--tmpfs", PRIVATE_TMP_MOUNTPOINT);
  argv.push("--setenv", "CLAUDE_CODE_TMPDIR", PRIVATE_TMP_MOUNTPOINT);

  // --- Bun runtime ---
  argv.push("--ro-bind", BUN_BIN, BUN_BIN);
  argv.push("--ro-bind", BUN_HOME, BUN_HOME);

  // --- agentkimi project (SDK + worker script) ---
  argv.push("--ro-bind", cfg.projectDir, cfg.projectDir);

  // --- Worktree (rw — Kimi writes here) ---
  argv.push("--bind", cfg.worktree, cfg.worktree);

  // --- Sandbox home (empty tmpfs scratch — no host secrets) ---
  argv.push("--bind", cfg.sandboxHome, cfg.sandboxHome);
  argv.push("--setenv", "HOME", cfg.sandboxHome);
  // Minimal PATH (incl. the ro-bound bun) so the worker + SDK can resolve binaries
  // under --clearenv. Not secret. The SDK subprocess additionally gets job.env's PATH.
  argv.push("--setenv", "PATH", `${join(HOME, ".bun", "bin")}:/usr/local/bin:/usr/bin:/bin`);

  // --- Skills: ro-bind ~/.claude/skills into sandbox home (non-secret) ---
  const skillsSrc = join(HOME, ".claude", "skills");
  const skillsDst = join(cfg.sandboxHome, ".claude", "skills");
  if (existsSync(skillsSrc)) {
    argv.push("--ro-bind", skillsSrc, skillsDst);
  }

  // --- Config dir (deny-only settings.json — rw so ensureConfigDir can write it) ---
  argv.push("--bind", cfg.cfgDir, cfg.cfgDir);

  // --- Namespace flags ---
  argv.push("--unshare-user");
  argv.push("--unshare-pid");
  argv.push("--unshare-ipc");
  argv.push("--unshare-uts");
  argv.push("--unshare-cgroup");
  argv.push("--die-with-parent");
  argv.push("--new-session");

  if (cfg.noNet) argv.push("--unshare-net");

  // --- Sub-agent fan-out opt-in (non-secret) ---
  // --clearenv drops AGENTKIMI_ALLOW_SUBAGENTS, so the worker only sees it if
  // we re-set it here. Default (unset) keeps the cap on: the worker disallows
  // the Task tool so a single turn can't fan out into N more agent processes.
  if (cfg.allowSubagents) argv.push("--setenv", "AGENTKIMI_ALLOW_SUBAGENTS", "1");

  // --- The worker command ---
  argv.push(...workerArgs);

  return argv;
}
