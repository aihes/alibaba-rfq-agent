#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <midscene-yaml-file>" >&2
  exit 1
fi

source "$ROOT_DIR/scripts/midscene-env.sh"
require_midscene_model_key

exec npx -y @midscene/cli@1 "$@"
