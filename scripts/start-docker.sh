#!/usr/bin/env bash
set -euo pipefail

IMAGE="computer-use-mcp-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$PROJECT_ROOT"

docker build -t "$IMAGE" .

docker run --rm \
  -p 8000:8000 \
  "$IMAGE" \
  --chromePath /usr/local/bin/chromium-wrapper "$@"
