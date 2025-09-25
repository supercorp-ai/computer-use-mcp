#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <x> <y> [button]" >&2
  exit 1
fi

HOST=${HOST:-localhost}
PORT=${PORT:-8000}
SESSION=${SESSION:-single}

X_COORD=$1
Y_COORD=$2
BUTTON=${3:-left}

payload=$(cat <<JSON
{
  "jsonrpc": "2.0",
  "id": "click",
  "method": "tools/call",
  "params": {
    "name": "computer_call",
    "arguments": {
      "action": {
        "type": "click",
        "button": "${BUTTON}",
        "x": ${X_COORD},
        "y": ${Y_COORD}
      }
    }
  }
}
JSON
)

curl -s \
  -H 'Content-Type: application/json' \
  -H "mcp-session-id: ${SESSION}" \
  -X POST \
  --data "${payload}" \
  "http://${HOST}:${PORT}/" | jq '.'
