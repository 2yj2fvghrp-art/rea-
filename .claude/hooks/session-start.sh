#!/bin/bash
# Prepare REA in Claude Code cloud sessions so its CLI, MCP server, tests and
# linters work without manual setup.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

"$CLAUDE_PROJECT_DIR/.claude/build-rea.sh"

# Expose this checkout as the `rea` command the bundled skill prefers.
mkdir -p "$CLAUDE_PROJECT_DIR/.cache/bin"
ln -sf ../../scripts/rea.mjs "$CLAUDE_PROJECT_DIR/.cache/bin/rea"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$CLAUDE_PROJECT_DIR/.cache/bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi
