#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/midscene-env.sh"

if [[ $# -eq 0 ]]; then
  cat >&2 <<'USAGE'
Usage:
  bridge-atomic.sh tabs
  bridge-atomic.sh snapshot [--screenshot <path|auto>] [--text-limit 8000] [--element-limit 120]
  bridge-atomic.sh eval <javascript>
  bridge-atomic.sh click <x> <y>
  bridge-atomic.sh type <text>
  bridge-atomic.sh press <key>
  bridge-atomic.sh scroll <down|up|left|right|top|bottom> [distance]
  bridge-atomic.sh nav <url>
  bridge-atomic.sh back|forward|reload

Set MIDSCENE_URL=https://example.com to open a specific page first.
USAGE
  exit 1
fi

exec npx -y tsx "$ROOT_DIR/scripts/bridge-atomic.ts" "$@"
