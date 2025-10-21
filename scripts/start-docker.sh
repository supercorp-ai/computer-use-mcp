#!/usr/bin/env bash
set -euo pipefail

IMAGE="computer-use-mcp-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$PROJECT_ROOT"

docker build --platform=linux/amd64 -t "$IMAGE" .

docker run --rm \
  --platform=linux/amd64 \
  -p 8000:8000 \
  "$IMAGE" \
  "$@"
