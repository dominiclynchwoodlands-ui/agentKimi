/**
 * config.test.ts — unit tests for sub-agent fan-out capping.
 * Hermetic: no network, no API keys required.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { resolveAllowSubagents, SUBAGENT_FANOUT_TOOLS } from "./config.js";

// --- resolveAllowSubagents ---
//
// spawnSync serializes turns, so the only uncapped way a single turn can
// multiply processes/memory is the agent spawning its own sub-agents via the
// SDK Task tool. Capped (no sub-agents) is the default; AGENTKIMI_ALLOW_SUBAGENTS=1
// is the only opt-in.

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.AGENTKIMI_ALLOW_SUBAGENTS;
  delete process.env.AGENTKIMI_ALLOW_SUBAGENTS;
});
afterEach(() => {
  if (savedEnv !== undefined) {
    process.env.AGENTKIMI_ALLOW_SUBAGENTS = savedEnv;
  } else {
    delete process.env.AGENTKIMI_ALLOW_SUBAGENTS;
  }
});

test("resolveAllowSubagents: unset → false (fan-out capped by default)", () => {
  expect(resolveAllowSubagents()).toBe(false);
});

test("resolveAllowSubagents: '1' → true (explicit opt-in)", () => {
  process.env.AGENTKIMI_ALLOW_SUBAGENTS = "1";
  expect(resolveAllowSubagents()).toBe(true);
});

test("resolveAllowSubagents: '0' → false", () => {
  process.env.AGENTKIMI_ALLOW_SUBAGENTS = "0";
  expect(resolveAllowSubagents()).toBe(false);
});

test("resolveAllowSubagents: 'true' → false (only the literal '1' opts in)", () => {
  process.env.AGENTKIMI_ALLOW_SUBAGENTS = "true";
  expect(resolveAllowSubagents()).toBe(false);
});

test("resolveAllowSubagents: empty string → false", () => {
  process.env.AGENTKIMI_ALLOW_SUBAGENTS = "";
  expect(resolveAllowSubagents()).toBe(false);
});

test("SUBAGENT_FANOUT_TOOLS: includes the SDK Task tool", () => {
  expect(SUBAGENT_FANOUT_TOOLS).toContain("Task");
});
