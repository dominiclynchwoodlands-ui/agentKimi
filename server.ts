#!/usr/bin/env bun
/**
 * server.ts — agentKimi MCP server (stdio transport).
 *
 * Three tools:
 *   agentkimi_start  — create worktree, run first turn, return diff
 *   agentkimi_send   — resume session, run next turn, return diff
 *   agentkimi_end    — remove worktree, mark session closed
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { realpathSync, existsSync } from "node:fs";
import { ensureConfigDir } from "./sandbox.js";
import { createWorktree, captureDiff, removeWorktree } from "./worktree.js";
import {
  saveSession,
  loadSession,
  updateSession,
  closeSession,
  recordToWorktree,
  acquireSessionLock,
  releaseSessionLock,
} from "./registry.js";
import { runTurn } from "./kimi-session.js";

// --- Startup ---

ensureConfigDir();

// --- Workdir guardrail (PRIMARY protection) ---

/**
 * Default sensitive paths that must never be used as a workdir.
 * Empty by default — configure your own via the AGENTKIMI_DENY_PATHS env var
 * (colon-separated), e.g. AGENTKIMI_DENY_PATHS="$HOME/work/secrets:$HOME/.config".
 * (The bwrap namespace is the primary boundary; this is a convenience guardrail
 * so agentKimi never even creates a worktree inside a directory you mark sensitive.)
 */
const DEFAULT_DENY_WORKDIRS: string[] = [];

/** Build the full deny list: defaults + AGENTKIMI_DENY_PATHS (colon-separated). */
function buildDenyWorkdirs(): string[] {
  const extra = (process.env.AGENTKIMI_DENY_PATHS ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  return [...DEFAULT_DENY_WORKDIRS, ...extra];
}

/**
 * Validate that workdir is not under any sensitive path.
 * Returns an error string if denied, null if allowed.
 * Exported for smoke test only.
 */
export function validateWorkdir_test(workdir: string): string | null {
  return validateWorkdir(workdir);
}

function validateWorkdir(workdir: string): string | null {
  let canonical: string;
  try {
    canonical = realpathSync(workdir);
  } catch {
    return `workdir does not exist or cannot be resolved: ${workdir}`;
  }
  for (const denied of buildDenyWorkdirs()) {
    let deniedCanon: string;
    try {
      deniedCanon = existsSync(denied) ? realpathSync(denied) : denied;
    } catch {
      deniedCanon = denied;
    }
    if (canonical === deniedCanon || canonical.startsWith(deniedCanon + "/")) {
      return `workdir '${workdir}' is under a protected path '${denied}'. Point agentKimi at a non-sensitive repository.`;
    }
  }
  return null;
}
console.error("[agentKimi] server started");

// --- Helpers (mirrored from llm-panel) ---

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function requireString(
  value: unknown,
  fieldName: string
): ReturnType<typeof errorResult> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return errorResult(`Missing or empty required parameter '${fieldName}'.`);
  }
  return null;
}

function extractError(err: unknown): string {
  const isObj = err !== null && typeof err === "object";
  const status = isObj ? (err as { status?: number }).status : undefined;
  const code = isObj ? (err as { code?: string }).code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return [status && `HTTP ${status}`, code && `code=${code}`, message]
    .filter(Boolean)
    .join(" | ");
}

function generateSessionId(): string {
  return `kimi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDiffSection(diff: string, files: string[], truncated: boolean): string {
  const header = files.length > 0
    ? `**Files changed:** ${files.join(", ")}\n\n`
    : "";
  const body = diff
    ? `\`\`\`diff\n${diff}\n\`\`\``
    : "_No changes detected._";
  const note = truncated ? "\n\n⚠️ _Diff truncated at 200 KB._" : "";
  return `${header}${body}${note}`;
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "agentkimi_start",
    description:
      "Start a new Kimi agentic coding session. Kimi runs autonomously in a sandboxed git worktree, " +
      "executes tools (Write, Edit, Bash, Read, etc.), and returns a diff of all changes made. " +
      "Returns: session_id (use with agentkimi_send to continue), summary, diff, files_changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "The coding task for Kimi to execute autonomously.",
        },
        workdir: {
          type: "string",
          description:
            "Optional: absolute path to an existing git repo to work in. " +
            "Kimi will get a linked worktree on a new branch agentkimi/<id>. " +
            "If omitted, a throwaway git repo is created.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "agentkimi_send",
    description:
      "Continue an existing Kimi session with a follow-up message. " +
      "Kimi resumes with full context of the previous turn. " +
      "Returns: summary, diff (cumulative from session start), files_changed, test_output (if any).",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "The session ID returned by agentkimi_start.",
        },
        message: {
          type: "string",
          description: "Your follow-up instruction or question for Kimi.",
        },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "agentkimi_end",
    description:
      "End a Kimi session: removes the worktree (the branch is preserved for linked worktrees) " +
      "and marks the session closed. Returns a summary of what was done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: {
          type: "string",
          description: "The session ID to close.",
        },
      },
      required: ["session_id"],
    },
  },
];

// --- Handlers ---

async function handleStart(args: Record<string, unknown>) {
  const promptErr = requireString(args.prompt, "prompt");
  if (promptErr) return promptErr;
  const prompt = args.prompt as string;
  const workdir = args.workdir as string | undefined;

  // Workdir guardrail — check BEFORE creating any worktree or spawning Kimi
  if (workdir) {
    const guardErr = validateWorkdir(workdir);
    if (guardErr) return errorResult(guardErr);
  }

  const sessionId = generateSessionId();
  const wt = await createWorktree(sessionId, workdir);
  saveSession(sessionId, wt);

  const turn = await runTurn({ prompt, worktree: wt });
  updateSession(sessionId, { turn: 1, sdk_session_id: turn.sessionId || null });

  const { diff, files, truncated } = captureDiff(wt);
  const diffSection = formatDiffSection(diff, files, truncated);

  return textResult(
    `**Session started: \`${sessionId}\`**\n\n` +
      `**Kimi summary:**\n${turn.summary}\n\n` +
      `**Diff:**\n${diffSection}\n\n` +
      `---\n_Tools fired: ${turn.toolsFired.join(", ") || "none"} | ` +
      `SDK session: ${turn.sessionId.slice(0, 8)} | ` +
      `Use \`agentkimi_send\` with session_id \`${sessionId}\` to continue_`
  );
}

async function handleSend(args: Record<string, unknown>) {
  const sessionIdErr = requireString(args.session_id, "session_id");
  if (sessionIdErr) return sessionIdErr;
  const messageErr = requireString(args.message, "message");
  if (messageErr) return messageErr;

  const sessionId = args.session_id as string;
  const message = args.message as string;

  const rec = loadSession(sessionId);
  if (!rec) {
    return errorResult(`Session not found: \`${sessionId}\`. It may have been ended or never started.`);
  }
  if (rec.status === "closed") {
    return errorResult(`Session \`${sessionId}\` is already closed. Start a new session.`);
  }

  // Per-session in-process mutex
  if (!acquireSessionLock(sessionId)) {
    return errorResult(`Session \`${sessionId}\` is already processing a message. Wait for it to finish.`);
  }

  try {
    const wt = recordToWorktree(rec);
    const turn = await runTurn({ prompt: message, worktree: wt, resume: rec.sdk_session_id ?? undefined });
    updateSession(sessionId, { turn: rec.turn + 1, sdk_session_id: turn.sessionId || rec.sdk_session_id });

    const { diff, files, truncated } = captureDiff(wt);
    const diffSection = formatDiffSection(diff, files, truncated);

    const testSection = turn.testOutput
      ? `\n\n**Test output:**\n\`\`\`\n${turn.testOutput}\n\`\`\``
      : "";

    return textResult(
      `**Kimi summary (turn ${rec.turn + 1}):**\n${turn.summary}${testSection}\n\n` +
        `**Diff (cumulative):**\n${diffSection}\n\n` +
        `---\n_Tools fired: ${turn.toolsFired.join(", ") || "none"}_`
    );
  } finally {
    releaseSessionLock(sessionId);
  }
}

async function handleEnd(args: Record<string, unknown>) {
  const sessionIdErr = requireString(args.session_id, "session_id");
  if (sessionIdErr) return sessionIdErr;

  const sessionId = args.session_id as string;
  const rec = loadSession(sessionId);
  if (!rec) {
    return errorResult(`Session not found: \`${sessionId}\`.`);
  }

  const wt = recordToWorktree(rec);
  const { files } = captureDiff(wt);
  removeWorktree(wt);
  closeSession(sessionId);

  return textResult(
    `**Session \`${sessionId}\` ended.**\n\n` +
      `- Turns completed: ${rec.turn}\n` +
      `- Files changed: ${files.length > 0 ? files.join(", ") : "none"}\n` +
      `- Branch: ${rec.branch ?? "(throwaway)"}\n` +
      `- Worktree removed.`
  );
}

// --- MCP server ---

const mcp = new Server(
  { name: "agentkimi", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const toolArgs = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "agentkimi_start":
        return await handleStart(toolArgs);
      case "agentkimi_send":
        return await handleSend(toolArgs);
      case "agentkimi_end":
        return await handleEnd(toolArgs);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    return errorResult(`agentKimi error: ${extractError(err)}`);
  }
});

// --- Start ---

await mcp.connect(new StdioServerTransport());
