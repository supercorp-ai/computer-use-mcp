#!/usr/bin/env bash
set -euo pipefail

HOST=${HOST:-localhost}
PORT=${PORT:-8000}
SESSION=${SESSION:-single}

call_tool() {
  local payload=$1
  curl -s \
    -H 'Content-Type: application/json' \
    -H "mcp-session-id: ${SESSION}" \
    -X POST \
    --data "${payload}" \
    "http://${HOST}:${PORT}/" | jq '.'
}

# Start move
call_tool '{"jsonrpc":"2.0","id":"move","method":"tools/call","params":{"name":"computer_use_call","arguments":{"action":{"type":"move","x":100,"y":100}}}}'

