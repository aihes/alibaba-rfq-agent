#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/midscene-env.sh"
require_midscene_model_key

MODE="${1:-ask}"
shift || true

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <ask|act|assert|tabs> <prompt>" >&2
  exit 1
fi

exec npx -y tsx "$ROOT_DIR/scripts/bridge-ai.ts" "$MODE" "$@"
