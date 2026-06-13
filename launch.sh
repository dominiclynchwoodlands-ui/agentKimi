#!/usr/bin/env bash
# agentKimi launcher.
#
# SECURITY (minimal secret footprint):
# Does NOT source the env file wholesale — that would load mainnet trading keys
# (CF_API_TOKEN, GOLDBOT_KEY, etc.) into the server process's environment.
# Instead: extracts ONLY the Kimi API key line and exports that single var.
# The server then builds an EXPLICIT child env for Kimi's subprocess.
#
# Set AGENTKIMI_ENV_FILE to override the env file location (default: .env next to this script).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${AGENTKIMI_ENV_FILE:-$SCRIPT_DIR/.env}"

if [ -f "$ENV_FILE" ]; then
  # Extract ONLY the Kimi/Moonshot key — never source the whole file
  KIMI_LINE="$(grep -E '^(KIMI_API_KEY|MOONSHOT_API_KEY)=' "$ENV_FILE" | head -1)" || true
  if [ -n "$KIMI_LINE" ]; then
    export "${KIMI_LINE?}"
  fi
fi

exec bun "$SCRIPT_DIR/server.ts"
