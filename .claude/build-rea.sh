#!/bin/bash
# Install locked dependencies when needed and build this checkout's REA CLI,
# MCP server, and packaged skill. Safe to rerun and to run concurrently. All
# output goes to stderr so the MCP launcher keeps stdout for the protocol.
set -euo pipefail
exec >&2
cd "$(dirname "$0")/.."

mkdir -p .cache
if command -v flock >/dev/null 2>&1; then
  exec 9>.cache/claude-build-rea.lock
  flock 9
fi

# npm ci keeps package-lock.json exact; skip it while node_modules matches.
if [ ! -f node_modules/.package-lock.json ] ||
  [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
fi
npm run build:cached
