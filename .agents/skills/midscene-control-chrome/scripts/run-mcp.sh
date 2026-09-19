#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/midscene-env.sh"
require_midscene_model_key

exec npx -y @midscene/web-bridge-mcp@1 "$@"
