#!/usr/bin/env bash
set -euo pipefail

MIDSCENE_TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$MIDSCENE_TOOL_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$MIDSCENE_TOOL_DIR/.env.local"
  set +a
fi

export MIDSCENE_BRIDGE_TIMEOUT_MS="${MIDSCENE_BRIDGE_TIMEOUT_MS:-20000}"

if [[ -z "${MIDSCENE_PROVIDER:-}" ]]; then
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    export MIDSCENE_PROVIDER="openrouter"
  else
    export MIDSCENE_PROVIDER="dashscope"
  fi
fi

if [[ "${MIDSCENE_PROVIDER}" == "openrouter" ]]; then
  export MIDSCENE_MODEL_NAME="${MIDSCENE_MODEL_NAME:-qwen/qwen3.7-plus}"
  export MIDSCENE_MODEL_BASE_URL="${MIDSCENE_MODEL_BASE_URL:-https://openrouter.ai/api/v1}"
  export MIDSCENE_MODEL_FAMILY="${MIDSCENE_MODEL_FAMILY:-qwen3}"
  if [[ -z "${MIDSCENE_MODEL_API_KEY:-}" && -n "${OPENROUTER_API_KEY:-}" ]]; then
    export MIDSCENE_MODEL_API_KEY="$OPENROUTER_API_KEY"
  fi
else
  export MIDSCENE_MODEL_NAME="${MIDSCENE_MODEL_NAME:-qwen-vl-max-latest}"
  export MIDSCENE_MODEL_BASE_URL="${MIDSCENE_MODEL_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}"
  export MIDSCENE_MODEL_FAMILY="${MIDSCENE_MODEL_FAMILY:-qwen2.5-vl}"
  if [[ -z "${MIDSCENE_MODEL_API_KEY:-}" && -n "${DASHSCOPE_API_KEY:-}" ]]; then
    export MIDSCENE_MODEL_API_KEY="$DASHSCOPE_API_KEY"
  fi
fi

require_midscene_model_key() {
  if [[ -z "${MIDSCENE_MODEL_API_KEY:-}" ]]; then
    echo "Missing MIDSCENE_MODEL_API_KEY, OPENROUTER_API_KEY, or DASHSCOPE_API_KEY." >&2
    echo "Create $MIDSCENE_TOOL_DIR/.env.local from $MIDSCENE_TOOL_DIR/.env.example, or export a supported key in the shell." >&2
    exit 1
  fi
}
