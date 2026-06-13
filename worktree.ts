#!/usr/bin/env bun
/**
 * worktree.ts — git worktree creation, diff capture, and cleanup.
 *
 * SECURITY (panel F1/F2/F6 — host RCE / command injection via git):
 *   The worktree contents are fully attacker-controlled (a jailbroken Kimi writes
 *   them). Every git invocation below runs in the UNSANDBOXED server process, so:
 *     1. No shell. All git calls use execFileSync with an argv array — attacker
 *        path/branch strings can never break out into a shell command.
 *     2. Separated git-dir. Throwaway repos keep their git-dir under GITDIRS_DIR
 *        (NEVER bind-mounted into the sandbox); linked worktrees use the source
 *        repo's git-dir (also not mounted). Every op passes --git-dir/--work-tree
 *        EXPLICITLY, so a `.git` pointer or `.git/config` Kimi writes in the
 *        worktree is ignored — it cannot define a diff/filter/textconv command.
 *     3. Hardened flags/env on every call: hooks off, fsmonitor off, system/global
 *        config neutralized, and diffs run --no-ext-diff --no-textconv. With the
 *        git-dir unreachable, an attacker `.gitattributes` is inert (the named
 *        drivers are undefined), so no command is ever executed during capture.
 *     4. Cleanup uses fs.rmSync (no `rm -rf` shell string) and validates the path
 *        is under WORKTREES_DIR.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKTREES_DIR, GITDIRS_DIR } from "./config.js";

export interface Worktree {
  path: string;
  gitDir: string;          // server-only git directory (NEVER mounted into the sandbox)
  repoRoot: string | null; // null for throwaway git init repos
  branch: string | null;   // null for throwaway repos
  baseCommit: string;
  isThrowaway: boolean;
}

// --- Hardened git invocation -------------------------------------------------

/** Config knobs that would let attacker-written repo state run a command. */
const SAFE_GIT_FLAGS = [
  "-c", "core.hooksPath=/dev/null",   // no repo hooks (e.g. post-checkout) run
  "-c", "core.fsmonitor=",            // no fsmonitor hook command
];

/**
 * Build a git env that stops git reading attacker-influenced config.
 * Strips ALL `GIT_*` vars first: `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT|KEY|VALUE`
 * inject config at the same tier as `-c`, and `GIT_EXEC_PATH` / `GIT_ATTR_SOURCE` /
 * `GIT_INDEX_FILE` redirect git's helper binaries / attributes / index — none are
 * neutralised by our `-c` flags. We then set only the safe knobs. Defence-in-depth:
 * the sandbox attacker cannot set the server's env, but a hostile launch env must
 * not be able to re-open the F1 RCE. Rebuilt per call so a var set at any time is caught.
 */
function buildSafeGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_")) continue;
    if (v !== undefined) env[k] = v;
  }
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Test-only export (used by worktree.security.test.ts). */
export { buildSafeGitEnv as buildSafeGitEnv_test };

interface GitOpts {
  cwd?: string;       // run in this directory (source-repo ops: worktree add / rev-parse)
  gitDir?: string;    // explicit --git-dir (worktree ops — ignores any in-tree .git)
  workTree?: string;  // explicit --work-tree
}

/** Run git with an argv array (no shell) + hardened flags/env. Throws on non-zero. */
function git(args: string[], opts: GitOpts = {}): string {
  const pre: string[] = [];
  if (opts.gitDir) pre.push("--git-dir", opts.gitDir);
  if (opts.workTree) pre.push("--work-tree", opts.workTree);
  return execFileSync("git", [...pre, ...SAFE_GIT_FLAGS, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildSafeGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Detect if a path is inside a git repo; return root or null. */
function findGitRoot(dir: string): string | null {
  try {
    return git(["rev-parse", "--show-toplevel"], { cwd: dir });
  } catch {
    return null;
  }
}

/**
 * Names of filter drivers defined in the (possibly untrusted) repo config.
 *
 * LINKED worktrees read the SOURCE repo's config. A repo that defines
 * `filter.X.smudge`/`clean` and commits a `.gitattributes` (`* filter=X`) makes
 * `git worktree add` (checkout) and `git add` (clean) execute a command AS THE HOST
 * USER. Filters are not hooks and git has no flag/`--no-checkout` that reliably
 * stops the worktree-add checkout from invoking them — so the load-bearing defence
 * is to REFUSE a linked worktree whose source repo defines filters (see
 * createWorktree). This enumeration drives both that refusal and the diff-time
 * blanking below. (Throwaway repos have a clean server-created config → [].)
 */
function enumerateFilterNames(opts: GitOpts): string[] {
  let raw = "";
  try {
    raw = git(["config", "--get-regexp", "^filter\\."], opts);
  } catch {
    return []; // exit != 0 → no filter.* keys defined
  }
  const names = new Set<string>();
  for (const line of raw.split("\n")) {
    const m = line.match(/^filter\.(.+)\.(?:smudge|clean|process|required)(?:\s|$)/);
    if (m && m[1]) names.add(m[1]);
  }
  return [...names];
}

/** `-c` flags that blank each defined filter's smudge/clean/process commands. */
function filterNeutralizeFlags(opts: GitOpts): string[] {
  const flags: string[] = [];
  for (const n of enumerateFilterNames(opts)) {
    flags.push(
      "-c", `filter.${n}.smudge=`,
      "-c", `filter.${n}.clean=`,
      "-c", `filter.${n}.process=`,
      "-c", `filter.${n}.required=false`,
    );
  }
  return flags;
}

/**
 * Create a worktree for a session.
 *
 * - If workdir is provided and is inside a git repo:
 *     creates a linked worktree at ~/.agentkimi/worktrees/<id> on branch agentkimi/<id>
 *     (git-dir = <repo>/.git/worktrees/<id>, not mounted into the sandbox).
 * - Otherwise:
 *     creates a throwaway repo whose working tree is ~/.agentkimi/worktrees/<id>
 *     and whose git-dir is the SEPARATED, unmounted ~/.agentkimi/gitdirs/<id>.
 */
export async function createWorktree(sessionId: string, workdir?: string): Promise<Worktree> {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const worktreePath = join(WORKTREES_DIR, sessionId);

  if (workdir) {
    const absWork = realpathSync(workdir);
    const repoRoot = findGitRoot(absWork);
    if (repoRoot) {
      // SECURITY (F1 linked): a source repo that defines git filter drivers executes
      // a command during `git worktree add` checkout (and `git add`) AS THE HOST USER
      // if a committed `.gitattributes` references them. There is no reliable flag to
      // suppress the checkout's clean/smudge invocation, so we FAIL CLOSED: refuse a
      // linked worktree on a filter-defining repo unless the operator explicitly trusts
      // it via AGENTKIMI_ALLOW_FILTERS=1.
      const filters = enumerateFilterNames({ cwd: repoRoot });
      if (filters.length > 0 && process.env.AGENTKIMI_ALLOW_FILTERS !== "1") {
        throw new Error(
          `Source repo '${repoRoot}' defines git filter driver(s): ${filters.join(", ")}. ` +
          `Filters run commands during checkout/diff and can execute code on the host. ` +
          `Refusing to create a linked worktree. If you trust this repo, set AGENTKIMI_ALLOW_FILTERS=1.`
        );
      }
      const branch = `agentkimi/${sessionId}`;
      // In the trusted-override case, still blank smudge so a stray attribute can't run it.
      const neutralize = filterNeutralizeFlags({ cwd: repoRoot });
      git([...neutralize, "worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot });
      // Capture the real git-dir now, from the freshly-created (trusted) .git pointer,
      // before Kimi can tamper with it. All later ops pass it explicitly.
      const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath });
      const baseCommit = git(["rev-parse", "HEAD"], { gitDir, workTree: worktreePath });
      return { path: worktreePath, gitDir, repoRoot, branch, baseCommit, isThrowaway: false };
    }
  }

  // Throwaway repo — working tree in WORKTREES_DIR, git-dir separated under GITDIRS_DIR.
  mkdirSync(GITDIRS_DIR, { recursive: true });
  const gitDir = join(GITDIRS_DIR, sessionId);
  mkdirSync(worktreePath, { recursive: true });
  git(["init", "-q", `--separate-git-dir=${gitDir}`, worktreePath]);
  const wtOpts: GitOpts = { gitDir, workTree: worktreePath };
  git(["config", "user.email", "agentkimi@local"], wtOpts);
  git(["config", "user.name", "agentkimi"], wtOpts);
  writeFileSync(join(worktreePath, ".agentkimi"), `session: ${sessionId}\n`);
  git(["add", "-A"], wtOpts);
  git(["commit", "-q", "-m", "initial"], wtOpts);
  const baseCommit = git(["rev-parse", "HEAD"], wtOpts);
  return { path: worktreePath, gitDir, repoRoot: null, branch: null, baseCommit, isThrowaway: true };
}

export interface DiffResult {
  diff: string;
  files: string[];
  truncated: boolean;
}

const MAX_DIFF_BYTES = 200 * 1024; // 200 KB

/** Capture git diff from base commit; truncate if >200 KB. */
export function captureDiff(wt: Worktree): DiffResult {
  const wtOpts: GitOpts = { gitDir: wt.gitDir, workTree: wt.path };
  // --no-ext-diff/--no-textconv block external-diff + textconv commands. For LINKED
  // worktrees the source repo config may also define filter.*.clean (which fires on
  // `git add` of a modified tracked file even with `-N`), so blank those too.
  // Throwaway repos have a clean server-created config (no filters) → [].
  const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];
  // Defense-in-depth for the AGENTKIMI_ALLOW_FILTERS override case (linked worktrees
  // that intentionally permit filters): blank the clean filters on add/diff. Linked
  // worktrees WITHOUT filters and throwaway repos yield [] here.
  const neutralize = wt.isThrowaway ? [] : filterNeutralizeFlags(wtOpts);

  try {
    git([...neutralize, "add", "-A", "-N"], wtOpts);
  } catch {
    // non-fatal — worktree may have no new files
  }

  let diff = "";
  try {
    diff = git([...neutralize, "diff", ...DIFF_FLAGS, wt.baseCommit], wtOpts);
  } catch {
    diff = "";
  }

  const truncated = Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES;
  if (truncated) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + "\n...[diff truncated at 200 KB]";
  }

  // M1 fix: use --name-only (not --porcelain slicing) for reliable file list
  let files: string[] = [];
  try {
    const nameOnly = git([...neutralize, "diff", ...DIFF_FLAGS, "--name-only", wt.baseCommit], wtOpts);
    files = nameOnly.split("\n").filter(Boolean);
  } catch {
    files = [];
  }

  return { diff, files, truncated };
}

/**
 * Remove the worktree (keep the branch for linked worktrees).
 * For throwaway repos: removes the working tree AND its separated git-dir.
 */
export function removeWorktree(wt: Worktree): void {
  if (!wt.isThrowaway && wt.repoRoot && existsSync(wt.path)) {
    try {
      git(["worktree", "remove", "--force", wt.path], { cwd: wt.repoRoot });
    } catch {
      // best-effort
    }
    return;
  }

  // Throwaway: defensively confirm the path is server-owned before deleting.
  // resolve() collapses any `..` so a (hypothetically poisoned) registry value
  // like ".../worktrees/x/../../etc" cannot pass the prefix check.
  if (wt.isThrowaway) {
    const wtPath = resolve(wt.path);
    const gdPath = resolve(wt.gitDir);
    if (wtPath.startsWith(WORKTREES_DIR + "/") && existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
    }
    if (gdPath.startsWith(GITDIRS_DIR + "/") && existsSync(gdPath)) {
      rmSync(gdPath, { recursive: true, force: true });
    }
  }
}
