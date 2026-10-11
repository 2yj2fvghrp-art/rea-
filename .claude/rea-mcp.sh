#!/bin/bash
# Start REA's stdio MCP server from this checkout, building it first when the
# session hook has not finished or never ran (for example, in a local clone).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/.claude/build-rea.sh"
exec node "$root/scripts/rea.mjs" mcp
