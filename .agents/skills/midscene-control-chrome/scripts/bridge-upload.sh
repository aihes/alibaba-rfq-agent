#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/midscene-env.sh"
require_midscene_model_key

if [[ $# -eq 0 ]]; then
  cat >&2 <<'USAGE'
Usage:
  bridge-upload.sh --prompt <visible-upload-control-description> <file...>

Example:
  bridge-upload.sh --prompt "the upload audio button" /absolute/path/audio.mp3

Set MIDSCENE_URL=https://example.com to open a specific page first.
USAGE
  exit 1
fi

exec npx -y tsx "$ROOT_DIR/scripts/bridge-upload.ts" "$@"
