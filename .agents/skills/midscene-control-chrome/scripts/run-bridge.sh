#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/midscene-env.sh"

case "${1:-}" in
  version|--help|-h|help|connect|disconnect|close|take_screenshot|report-tool)
    ;;
  *)
    require_midscene_model_key
    ;;
esac

exec npx -y @midscene/web@1 --bridge "$@"
