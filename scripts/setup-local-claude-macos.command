#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本仅适用于 macOS。"
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
helper="$script_dir/configure-local-claude.cjs"
app_node="$script_dir/../../../MacOS/RFQ助手"
if [[ -x "$app_node" ]]; then
  node_command=("$app_node")
  export ELECTRON_RUN_AS_NODE=1
elif command -v node >/dev/null 2>&1; then
  node_command=("$(command -v node)")
else
  echo "找不到 RFQ 助手内置运行环境。请从已安装的 RFQ 助手设置页打开此脚本。"
  exit 1
fi

echo "RFQ 助手 · 本机 Claude 安装与 GLM 配置"
echo "此操作会安装 Anthropic 官方 Claude Code，并更新 ~/.claude/settings.json 中的 GLM 认证与接口。"
echo "其他设置会保留，原文件会备份。Key 会以明文写入用户目录内的设置文件；不会放进命令行参数。"
read -r -p "继续吗？[y/N] " consent
if [[ "$consent" != "y" && "$consent" != "Y" ]]; then exit 0; fi

claude_path=""
for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  if [[ -f "$candidate" && -x "$candidate" ]]; then claude_path="$candidate"; break; fi
done
if [[ -z "$claude_path" ]]; then
  echo "正在从 claude.ai 下载并运行 Anthropic 官方安装脚本…"
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    'https://claude.ai/install.sh' --output "$installer"
  bash "$installer"
  if [[ -f "$HOME/.local/bin/claude" && -x "$HOME/.local/bin/claude" ]]; then
    claude_path="$HOME/.local/bin/claude"
  fi
fi
if [[ -z "$claude_path" ]]; then
  echo "Claude 安装未完成或未位于受支持路径。请查看上方错误信息。"
  exit 1
fi
"$claude_path" --version

echo "请选择 API Key 所属平台："
echo "  1) 智谱国内 open.bigmodel.cn"
echo "  2) Z.AI 国际 api.z.ai"
read -r -p "输入 1 或 2：" choice
case "$choice" in
  1) region=china ;;
  2) region=zai ;;
  *) echo "未选择有效平台；未修改 Claude 设置。"; exit 1 ;;
esac
read -r -s -p "粘贴该平台的 API Key（输入时不显示）：" api_key
echo
printf '%s' "$api_key" | "${node_command[@]}" "$helper" --region "$region" --executable "$claude_path"
unset api_key
echo "完成。请回到 RFQ 助手，点击「重新读取本机环境变量」，再点击「测试模型连接」。"
if [[ -t 0 ]]; then read -r -p "按回车关闭窗口…" _; fi
