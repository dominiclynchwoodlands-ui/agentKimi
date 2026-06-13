#!/usr/bin/env bun
/**
 * registry.ts — durable session registry (~/.agentkimi/sessions.json).
 *
 * Invariants (Phase 5 security checklist):
 *   - Atomic writes: tmp file + rename (POSIX rename is atomic on same fs).
 *   - Cross-process lock: O_EXCL lockfile + stale-PID detection.
 *   - Merge-on-write: foreign entries (written by another process) are preserved.
 *   - Per-session in-process mutex: rejects concurrent send on the same session.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { REGISTRY_PATH, AGENTKIMI_HOME } from "./config.js";
import type { Worktree } from "./worktree.js";

// --- Types ---

export type SessionStatus = "active" | "closed" | "error";

export interface SessionRecord {
  session_id: string;
  worktree_path: string;
  git_dir: string;          // server-only git directory (never mounted into the sandbox)
  repo_root: string | null;
  branch: string | null;
  base_commit: string;
  is_throwaway: boolean;
  sdk_session_id: string | null;  // Anthropic/Moonshot SDK session UUID for resume
  turn: number;
  status: SessionStatus;
  error_count?: number;           // consecutive error turns; absent → treat as 0
  created_at: string;
  updated_at: string;
}

type Registry = Record<string, SessionRecord>;

// --- In-process session mutex ---

const inFlight = new Map<string, boolean>();

export function acquireSessionLock(sessionId: string): boolean {
  if (inFlight.get(sessionId)) return false;
  inFlight.set(sessionId, true);
  return true;
}

export function releaseSessionLock(sessionId: string): void {
  inFlight.delete(sessionId);
}

// --- Cross-process lock ---

const LOCK_PATH = join(AGENTKIMI_HOME, "sessions.lock");
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_SPIN_MS = 20;
const LOCK_MAX_RETRIES = Math.ceil(LOCK_TIMEOUT_MS / LOCK_SPIN_MS);

/**
 * Acquire the cross-process file lock.
 *
 * H3 fix: FAILS CLOSED on timeout — throws, never proceeds without the lock.
 * Stale-lock reclaim is only performed when the recorded PID is provably dead
 * (no /proc/<pid> entry). NEVER unlinks a lock held by a live process.
 */
function acquireFileLock(): void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  let retries = 0;

  while (retries < LOCK_MAX_RETRIES) {
    // Attempt O_EXCL create
    try {
      const fd = openSync(LOCK_PATH, "wx"); // O_EXCL — atomic, fails if exists
      // Write PID *after* we hold the fd (fd is the ownership token)
      try {
        writeFileSync(LOCK_PATH, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return; // lock acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected filesystem error — fail closed immediately
        throw new Error(`registry lock: unexpected error: ${(err as Error).message}`);
      }
    }

    // Lock file exists — check if holder is alive
    try {
      const content = readFileSync(LOCK_PATH, "utf8").trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid) && pid !== process.pid) {
        // Check liveness via /proc (Linux) — do NOT use process.kill(pid, 0) which
        // can throw EPERM for other-user processes and be misread as "dead".
        const procAlive = existsSync(`/proc/${pid}`);
        if (!procAlive) {
          // Holder is provably dead — reclaim stale lock
          try {
            unlinkSync(LOCK_PATH);
          } catch {
            // Another process may have beaten us to the unlink — retry loop handles it
          }
          retries++;
          continue;
        }
      }
    } catch {
      // Lock file vanished between EEXIST and readFileSync — retry immediately
      retries++;
      continue;
    }

    // Spin briefly
    const start = Date.now();
    while (Date.now() - start < LOCK_SPIN_MS) { /* spin */ }
    retries++;
  }

  // FAIL CLOSED: do NOT unlink-and-proceed — that risks concurrent write corruption.
  throw new Error(
    `registry lock: failed to acquire after ${LOCK_TIMEOUT_MS}ms. ` +
    `Lock held by PID in ${LOCK_PATH}. Investigate and remove manually if stale.`
  );
}

function releaseFileLock(): void {
  try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
}

// --- Read / write ---

function readRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
  } catch {
    return {};
  }
}

/** Atomic merge-write: reads current state, merges, then tmp+rename.
 *  Throws if the lock cannot be acquired (H3: fail closed). */
function writeRegistry(patch: (current: Registry) => Registry): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  acquireFileLock(); // throws on timeout — NEVER proceeds without lock
  try {
    const current = readRegistry();
    const next = patch(current);
    const tmp = REGISTRY_PATH + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, REGISTRY_PATH);
  } finally {
    releaseFileLock();
  }
}

// --- Public API ---

export function saveSession(sessionId: string, wt: Worktree): void {
  const rec: SessionRecord = {
    session_id: sessionId,
    worktree_path: wt.path,
    git_dir: wt.gitDir,
    repo_root: wt.repoRoot,
    branch: wt.branch,
    base_commit: wt.baseCommit,
    is_throwaway: wt.isThrowaway,
    sdk_session_id: null,
    turn: 0,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeRegistry((r) => ({ ...r, [sessionId]: rec }));
}

export function loadSession(sessionId: string): SessionRecord | null {
  const reg = readRegistry();
  return reg[sessionId] ?? null;
}

export function updateSession(
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "turn" | "status" | "sdk_session_id" | "error_count">>
): void {
  writeRegistry((r) => {
    const existing = r[sessionId];
    if (!existing) return r; // session was deleted externally — don't recreate
    return { ...r, [sessionId]: { ...existing, ...patch, updated_at: new Date().toISOString() } };
  });
}

export function closeSession(sessionId: string): void {
  updateSession(sessionId, { status: "closed" });
}

export function listSessions(): SessionRecord[] {
  return Object.values(readRegistry());
}

/** Reconstruct a Worktree handle from a registry record (no filesystem side-effects). */
export function recordToWorktree(rec: SessionRecord): Worktree {
  return {
    path: rec.worktree_path,
    gitDir: rec.git_dir,
    repoRoot: rec.repo_root,
    branch: rec.branch,
    baseCommit: rec.base_commit,
    isThrowaway: rec.is_throwaway,
  };
}
