# agentKimi

> **Status: work in progress.** This is an early public release under active
> development — expect rough edges and breaking changes. **Bug reports and pull
> requests are very welcome** — open an
> [issue](https://github.com/dominiclynchwoodlands-ui/agentKimi/issues) or a PR
> (see [Contributing](#contributing)).

An MCP server that runs **Kimi K2.7-code** (Moonshot AI) as an autonomous coding
agent inside a **bubblewrap-sandboxed git worktree**. Kimi gets the full Claude Code
toolset (Write, Edit, Bash, Read, Glob, Grep, …) via the Claude Agent SDK, works in
an isolated worktree, and the server returns a **git diff** of everything it changed
as ground truth for review.

Built with TypeScript + [Bun](https://bun.sh), the
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) (stdio
transport), and [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)
pointed at Moonshot's Anthropic-compatible endpoint.

> **Platform:** Linux only. Requires `bubblewrap` (`bwrap`) and unprivileged user
> namespaces — the sandbox **fails closed** if they're unavailable (no unsandboxed
> fallback).

---

## Tools

| Tool | Returns |
|---|---|
| `agentkimi_start(prompt, workdir?)` | `{ session_id, summary, diff, files_changed }` |
| `agentkimi_send(session_id, message)` | `{ summary, diff, files_changed, test_output }` |
| `agentkimi_end(session_id)` | Closes the session (removes the worktree, keeps the branch). |

Multi-turn conversations resume via the SDK's `resume` (survives server restarts).
One worktree per session.

### Worktree modes

- **`workdir` is inside a git repo** → a **linked worktree** on branch
  `agentkimi/<id>` off `HEAD`. The branch is preserved after `agentkimi_end`, so you
  can inspect, merge, or delete it. Its git-dir lives in the source repo and is never
  exposed to the sandbox.
- **No `workdir`** → a **throwaway** `git init` repo under
  `~/.agentkimi/worktrees/<id>`, with a **separated git-dir** under
  `~/.agentkimi/gitdirs/<id>` that is never mounted into the sandbox. Removed on end.

---

## Security model

The threat model assumes Kimi may be **jailbroken or prompt-injected** and will try to
read host secrets, escape the sandbox, or run code outside it. There are two real
boundaries, plus several hardening layers.

### bwrap namespace — the PRIMARY boundary (`bwrap.ts`)

Each turn runs as a bubblewrapped subprocess in a fresh user/PID/IPC/UTS/cgroup
namespace:

- **Host secrets are not mounted** — `~/.ssh`, `~/.aws`, `~/.git-credentials`, and any
  other home/secret directory simply **do not exist** inside the namespace (ENOENT),
  even via interpreters (`python`, `node`, `bun`). This is containment by
  construction, not by command filtering.
- **`--clearenv`** — the namespace starts from an empty environment; only `HOME`,
  `PATH`, and `CLAUDE_CODE_TMPDIR` are set. The API key never appears in the
  namespace environment, so it can't be read via `/proc/<pid>/environ`.
- **Private SDK tmpfs** — the SDK extracts its bundled `claude` binary into a
  per-session tmpfs (`/sbx-tmp`, via `CLAUDE_CODE_TMPDIR`). The host-shared
  `/tmp/claude-<uid>` is never mounted, so a sandboxed process can't poison a binary
  an unsandboxed host process later runs, or read another session's output.
- **Empty tmpfs `HOME`**; the project dir and Bun runtime are mounted **read-only**;
  the worktree is the only writable workspace.
- **`AGENTKIMI_NO_NET=1`** adds `--unshare-net` to drop all network egress.

### In-process gate — SECONDARY, defense-in-depth (`sandbox.ts`)

A `PreToolUse` hook plus a `canUseTool` callback confine file operations to the active
worktree (symlink-safe, deepest-existing-ancestor realpath, no lexical fallback) and
deny destructive commands, egress tools, and env/process introspection. This raises
the bar against casual misuse — but the bwrap namespace is what actually contains a
determined attacker (a regex gate cannot confine an interpreter).

### Hardened git operations (`worktree.ts`)

The worktree contents are fully attacker-controlled, and the server runs git against
them **outside** the sandbox — a classic host-RCE surface. So every git call:

- uses an **argv array** (`execFileSync`, no shell) — no path/branch can inject a
  command;
- passes **`--git-dir`/`--work-tree` explicitly** against a git-dir the sandbox can't
  write, so an in-tree `.git`/`.gitattributes` can't define a command;
- runs with `--no-ext-diff --no-textconv`, `-c core.hooksPath=/dev/null
  -c core.fsmonitor=`, `GIT_CONFIG_SYSTEM/GLOBAL=/dev/null`, and a child env with all
  `GIT_*` variables stripped (these otherwise bypass the `-c` overrides);
- cleanup uses `fs.rmSync` (no `rm -rf` shell string) with a path-prefix check.

**Linked-mode filter repos are refused by default.** A git repo can define
`filter.<name>.smudge`/`clean` in its config and commit a `.gitattributes` that runs
the filter command on checkout/diff — i.e. opening an untrusted repo can execute code
on the host. agentKimi enumerates the source repo's filter drivers and **refuses** to
create a linked worktree if any are defined, unless you opt in with
`AGENTKIMI_ALLOW_FILTERS=1` (only for repos you trust — e.g. ones using git-lfs).

### Minimal secret footprint (`launch.sh`, `config.ts`)

`launch.sh` `grep`s **only** the Kimi key line out of the env file — it never sources
the file, so unrelated secrets never enter the server process. The server builds an
explicit child env for Kimi containing only what it needs; `process.env` is never
spread.

### Honest residual risk

- **Network is ON by default** (Kimi needs Moonshot + WebFetch). With net on, a
  jailbroken Kimi could exfiltrate **the worktree code it is working on**. No host
  secret is reachable (they aren't mounted, and the namespace env is cleared), but set
  `AGENTKIMI_NO_NET=1` for sensitive repos.
- **The worktree is writable** — Kimi can write anything there. Review the returned
  diff before merging.
- Requires kernel support for unprivileged user namespaces; bwrap fails with a clear
  error at spawn if unavailable.

---

## Setup

### 1. Install

```bash
git clone https://github.com/dominiclynchwoodlands-ui/agentKimi
cd agentKimi
bun install
```

You also need `bubblewrap` installed (`bwrap --version`). On Debian/Ubuntu:
`sudo apt install bubblewrap`; on Arch: `sudo pacman -S bubblewrap`.

### 2. Provide the Kimi key

Create an env file containing a single line, and point `AGENTKIMI_ENV_FILE` at it
(only `KIMI_API_KEY` or `MOONSHOT_API_KEY` is read):

```bash
mkdir -p ~/.agentkimi
printf 'KIMI_API_KEY=%s\n' "<your-moonshot-key>" > ~/.agentkimi/.env
chmod 600 ~/.agentkimi/.env
```

### 3. Register with Claude Code

MCP servers live in `~/.claude.json` (user scope) — **not** `settings.json`. Add:

```jsonc
"agentkimi": {
  "type": "stdio",
  "command": "/abs/path/to/agentKimi/launch.sh",
  "env": { "AGENTKIMI_ENV_FILE": "/home/you/.agentkimi/.env" }
}
```

or:

```bash
claude mcp add agentkimi --scope user \
  -e AGENTKIMI_ENV_FILE=/home/you/.agentkimi/.env \
  -- /abs/path/to/agentKimi/launch.sh
```

Restart Claude Code so it picks up the new server.

---

## Configuration

| Env var | Effect |
|---|---|
| `AGENTKIMI_ENV_FILE` | Path to the file holding the Kimi key (`launch.sh` greps just that line). |
| `AGENTKIMI_NO_NET=1` | Drop all network egress from the sandbox (`--unshare-net`). |
| `AGENTKIMI_DENY_PATHS` | Colon-separated paths that may not be used as a `workdir` (e.g. `"$HOME/work/secrets:$HOME/.config"`). Empty by default. |
| `AGENTKIMI_ALLOW_FILTERS=1` | Permit a linked worktree on a repo that defines git filter drivers (refused by default). Only for repos you trust. |

### Runtime state

```
~/.agentkimi/
  .env             # your Kimi key (you create this)
  cfg/             # isolated config dir: deny-only settings.json + skills symlink
  sessions.json    # durable session registry (atomic writes + cross-process lock)
  worktrees/<id>/  # per-session working trees
  gitdirs/<id>/    # separated git-dirs for throwaway repos (never mounted)
```

---

## Development

```bash
bun install
bunx tsc --noEmit          # type-check
bun test                   # security regression suite (no API key needed)
bun smoke.ts               # bwrap + SDK integration check (needs KIMI_API_KEY in env)
```

The `*.security.test.ts` files are fast, hermetic regressions for the git-RCE and
env-isolation hardening. `smoke.ts` exercises the real bwrap sandbox and a live SDK
turn, and requires `KIMI_API_KEY` to be exported.

---

## Contributing

agentKimi is a work in progress and contributions are welcome.

- **Bug reports** — open a
  [GitHub issue](https://github.com/dominiclynchwoodlands-ui/agentKimi/issues)
  with steps to reproduce, your OS/kernel, and `bwrap --version`. Sandbox or
  isolation issues are especially valuable.
- **Pull requests** — open a PR against `main`. Before submitting, run
  `bunx tsc --noEmit` and `bun test` (both must be green) and describe what you
  changed and why.

Because the security model is the core of this project, any change touching the
sandbox (`bwrap.ts`, `sandbox.ts`, `worktree.ts`) should add or update the
relevant `*.security.test.ts` regressions.

## License

[MIT](./LICENSE)
