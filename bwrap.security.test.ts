/**
 * bwrap.security.test.ts — regression for env passthrough into the namespace
 * (panel finding F3, confirmed HIGH).
 *
 * Threat: kimi-session.ts spawns bwrap WITHOUT an explicit `env`, so the bwrap
 * process inherits the server env (which carries the Kimi key from launch.sh and
 * any secret present in the launch environment). Without --clearenv, bwrap passes
 * that env into the namespace, where an interpreter can read it via /proc/1/environ.
 *
 * Invariant under test: with the real buildBwrapArgv, a secret planted in the
 * spawning process's env must NOT be visible inside the namespace, while the
 * minimal vars the worker needs (HOME, PATH, CLAUDE_CODE_TMPDIR) ARE present.
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgv } from "./bwrap.js";

test("buildBwrapArgv (--clearenv) blocks server-env secrets from entering the namespace (F3)", () => {
  // Mirror kimi-session.ts: secrets live in the SERVER process env, and spawnSync
  // is called WITHOUT an `env` option (so the child inherits process.env).
  process.env.SECRET_PROBE = "leakme-" + Math.floor(performance.now()).toString(36);
  process.env.KIMI_API_KEY = "FAKE-test-token-not-real";
  const planted = process.env.SECRET_PROBE;

  const sandboxHome = mkdtempSync(join(tmpdir(), "f3-home-"));
  mkdirSync(join(sandboxHome, ".claude"), { recursive: true });
  const wt = mkdtempSync(join(tmpdir(), "f3-wt-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "f3-cfg-"));
  const projectDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

  try {
    const argv = buildBwrapArgv(
      { worktree: wt, sandboxHome, cfgDir, projectDir, noNet: false },
      ["/usr/bin/env"]
    );
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 20000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");

    // Secrets must NOT have crossed into the namespace.
    expect(out).not.toContain(planted);
    expect(out).not.toContain("FAKE-test-token-not-real");
    // The minimum the worker needs must still be set (so --clearenv didn't over-strip).
    expect(out).toContain("HOME=");
    expect(out).toContain("PATH=");
    expect(out).toContain("CLAUDE_CODE_TMPDIR=");
  } finally {
    delete process.env.SECRET_PROBE;
    delete process.env.KIMI_API_KEY;
    for (const d of [sandboxHome, wt, cfgDir]) rmSync(d, { recursive: true, force: true });
  }
});
