#!/usr/bin/env bun
/**
 * kimi-worker.ts — runs ONE query() turn inside the bwrap namespace.
 *
 * Reads a WorkerJob from stdin (JSON), streams query(), writes a WorkerResult
 * to stdout (JSON). stderr is forwarded to the parent for gate/debug logs.
 *
 * SECURITY: this file runs INSIDE the bwrap sandbox. Home-dir secrets are
 * not mounted — they are unreachable by any means including interpreters.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { buildHook, buildCanUseTool } from "./sandbox.js";
import { resolveAllowSubagents, SUBAGENT_FANOUT_TOOLS } from "./config.js";

export interface WorkerJob {
  prompt: string;
  worktreePath: string;       // canonical path, bind-mounted rw
  cfgDir: string;             // isolated config dir, bind-mounted rw
  env: Record<string, string>;
  resume?: string;            // SDK session_id for multi-turn
}

export interface WorkerResult {
  sessionId: string;
  summary: string;
  testOutput: string | null;
  toolsFired: string[];
  error?: string;
  subtype?: string;
  isError?: boolean;
}

const TEST_OUTPUT_RE = /```###\s*TEST OUTPUT\s*\n([\s\S]*?)```/i;

const SANDBOX_NOTICE = `
You are running inside a sandboxed git worktree with OS-level namespace confinement (bubblewrap).
Your home directory is an empty tmpfs — ~/.ssh, ~/.aws, ~/.git-credentials, and all host secrets
are NOT mounted and are unreachable by any means.
Hard constraints:
- Only read or write files INSIDE the current working directory.
- No destructive shell commands (rm -rf, dd, mkfs, shred, parted, sudo, systemctl, git push, gh).
- No egress tools (curl, wget, nc, ssh, etc.) unless the task explicitly requires network access.
- If you run tests, emit all test output in a fenced block: \`\`\`### TEST OUTPUT\n...\`\`\`
`.trim();

async function main() {
  // Read job from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const job: WorkerJob = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  const gateLog: string[] = [];
  const hookFn = buildHook(job.worktreePath, gateLog);
  const canUseTool = buildCanUseTool(job.worktreePath, gateLog);

  const baseOptions: Options = {
    cwd: job.worktreePath,
    env: job.env,
    permissionMode: "default",
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [hookFn] }] },
    systemPrompt: { type: "preset", preset: "claude_code", append: SANDBOX_NOTICE },
    settingSources: ["user"],
    skills: "all",
    executable: "bun",
    maxTurns: 30,
    // Cap fan-out: by default the agent may not spawn its own sub-agents.
    // spawnSync serializes turns, so the Task tool is the only uncapped way a
    // single turn can multiply processes/memory. Opt in with AGENTKIMI_ALLOW_SUBAGENTS=1.
    ...(resolveAllowSubagents() ? {} : { disallowedTools: [...SUBAGENT_FANOUT_TOOLS] }),
  };
  const options: Options = job.resume ? { ...baseOptions, resume: job.resume } : baseOptions;

  let sessionId = "";
  let summary = "";
  let subtype: string | undefined;
  let isError = false;
  let sessionIdEmitted = false;
  const toolsFired = new Set<string>();

  try {
    for await (const msg of query({ prompt: job.prompt, options })) {
      const m = msg as Record<string, unknown>;
      if (typeof m.session_id === "string" && m.session_id) {
        sessionId = m.session_id;
        // Emit the SDK session id to stderr the moment it's first captured.
        // If a long turn is later SIGTERM-killed by the parent's spawnSync
        // timeout, this sentinel line is already in the buffered stderr that
        // Node returns on ETIMEDOUT — letting the caller recover sessionId
        // and keep the turn resumable even though stdout never got written.
        if (!sessionIdEmitted) {
          sessionIdEmitted = true;
          process.stderr.write(`__AGENTKIMI_SESSION__ ${sessionId}\n`);
        }
      }
      if (msg.type === "assistant") {
        const content = (m.message as { content: unknown[] })?.content ?? [];
        for (const b of content)
          if ((b as { type: string }).type === "tool_use") toolsFired.add((b as { name: string }).name);
      }
      if (msg.type === "result") {
        summary = (m.result as string) ?? "";
        subtype = typeof m.subtype === "string" ? m.subtype : undefined;
        isError = typeof m.is_error === "boolean" ? m.is_error : false;
        if (isError && summary === "") {
          summary = `(kimi session ended: ${subtype ?? "error"})`;
        }
      }
    }
  } catch (e) {
    const result: WorkerResult = {
      sessionId, summary: "", testOutput: null, toolsFired: [],
      error: (e as Error).message ?? String(e),
    };
    process.stdout.write(JSON.stringify(result) + "\n");
    for (const l of gateLog) process.stderr.write(`[gate] ${l}\n`);
    process.exit(1);
  }

  for (const l of gateLog) process.stderr.write(`[gate] ${l}\n`);

  const testMatch = TEST_OUTPUT_RE.exec(summary);
  const result: WorkerResult = {
    sessionId,
    summary,
    testOutput: testMatch?.[1]?.trim() ?? null,
    toolsFired: [...toolsFired],
    subtype,
    isError: isError || undefined,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
