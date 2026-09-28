import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 仅包含模型配置；自动提交、浏览器令牌、通知权限不从 shell 导入。
export const modelEnvironmentKeys = ["AGENT_PROVIDER", "MODEL_NAME", "MODEL_API_URL", "MODEL_API_KEY",
  "GLM_API_KEY", "GLM_MODEL", "GLM_BASE_URL", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY", "ZAI_APIKEY", "ZAI_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_URL", "ANTHROPIC_HTTP_MODEL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "GLM_OCR_API_KEY", "GLM_OCR_API_URL", "LOCAL_CLAUDE_EXECUTABLE", "LOCAL_CLAUDE_MODEL"];
export const pickModelEnvironment = (env) => Object.fromEntries(modelEnvironmentKeys
  .filter((key) => typeof env[key] === "string" && env[key].trim() && env[key].length <= 2048).map((key) => [key, env[key].trim()]));
function endpoint(value, suffix) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("环境变量中的模型地址须为无凭据的 HTTPS 地址");
  if (suffix && !url.pathname.endsWith(suffix)) url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
  return url.href;
}
export function resolveEnvironmentModel(input) {
  const e = pickModelEnvironment(input);
  const name = e.MODEL_NAME || e.GLM_MODEL || e.ANTHROPIC_HTTP_MODEL || e.ANTHROPIC_MODEL || e.ANTHROPIC_DEFAULT_SONNET_MODEL || "glm-5.3";
  if (e.MODEL_API_KEY) return { agentProvider: e.AGENT_PROVIDER === "anthropic-http" ? "anthropic-http" : "openai-http", modelName: name,
    modelApiUrl: endpoint(e.MODEL_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions"), modelApiKey: e.MODEL_API_KEY, keyVariable: "MODEL_API_KEY" };
  // 凭据和接口必须成对使用，不把智谱 Token 发送到 Anthropic 官方接口。
  const token = e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY;
  if (token && (e.ANTHROPIC_BASE_URL || e.ANTHROPIC_API_URL || e.ANTHROPIC_API_KEY)) return { agentProvider: "anthropic-http", modelName: name,
    modelApiUrl: endpoint(e.ANTHROPIC_API_URL || e.ANTHROPIC_BASE_URL || "https://api.anthropic.com", "/v1/messages"),
    modelApiKey: token, keyVariable: e.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY" };
  const keyVariable = ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY", "ZAI_APIKEY"].find((key) => e[key]);
  if (!keyVariable) return null;
  const base = e.GLM_BASE_URL || e.ZAI_BASE_URL || (keyVariable.startsWith("ZAI") ? "https://api.z.ai/api/paas/v4" : "https://open.bigmodel.cn/api/paas/v4");
  return { agentProvider: "openai-http", modelName: name, modelApiUrl: endpoint(base, "/chat/completions"), modelApiKey: e[keyVariable], keyVariable };
}

/** 只定位用户已安装的 Claude CLI，不运行它，也不加载用户配置。
 * 桌面版会在用户选用本机 Claude 模式时把路径传给 SDK；报错时提示
 * 切换 HTTP，不静默切换供应商或把报价数据发到另一个模型。
 */
export function findLocalClaudeExecutable(env = process.env, home = os.homedir()) {
  const candidates = [env.LOCAL_CLAUDE_EXECUTABLE,
    path.join(home, ".claude/local/claude"), path.join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
    // Windows 优先识别原生可执行文件。npm 的 .cmd 包装器需外部 Node，
    // 桌面应用不假定用户安装了开发环境，也不能把 .cmd 直接交给 SDK spawn。
    ...(process.platform === "win32" ? [path.join(home, ".local/bin/claude.exe"),
      path.join(home, ".claude/local/claude.exe")] : [])];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } } catch {}
  }
  return "";
}

/** Finder/Dock 不继承终端 export。缺少配置时通过用户标准登录 shell
 * 读取白名单变量，使用应用自带 Node，无需开发环境。密钥仅留在内存；
 * 子进程输出/错误不进入日志、HTTP 或命令行参数。读取有超时与大小限制。
 */
export async function readModelEnvironment({ env = process.env, platform = process.platform, executable = process.execPath, run = execFile,
  claudeSettingsFile = path.join(os.homedir(), ".claude/settings.json") } = {}) {
  const inherited = pickModelEnvironment(env);
  // 智谱官方配置工具把变量保存在 Claude settings.json 的 env 字段。
  // 无论进程已继承何种 GLM Key，都单独记住 Claude 的认证白名单，
  // 让本机 Claude 复用它；HTTP 配置来源优先级不因此改变。
  let claudeVariables = {};
  try {
    if (fs.statSync(claudeSettingsFile).size <= 256 * 1024) {
      claudeVariables = pickModelEnvironment(JSON.parse(fs.readFileSync(claudeSettingsFile, "utf8")).env || {});
    }
  } catch {}
  try { if (resolveEnvironmentModel(inherited)) return { variables: inherited, claudeVariables, source: "进程环境变量" }; }
  catch { return { variables: inherited, claudeVariables, source: "进程环境变量" }; }
  const combined = { ...claudeVariables, ...inherited };
  try { if (resolveEnvironmentModel(combined)) return { variables: combined, claudeVariables, source: "Claude Code 本机 env 配置" }; } catch {}
  if (platform === "win32") return { variables: inherited, claudeVariables, source: "系统环境变量" };
  const shell = ["/bin/zsh", "/bin/bash", "/bin/sh"].includes(env.SHELL) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const script = `const keys=${JSON.stringify(modelEnvironmentKeys)};const data=Object.fromEntries(keys.filter(k=>process.env[k]&&process.env[k].length<=2048).map(k=>[k,process.env[k]]));process.stdout.write('__RFQ_MODEL_ENV__'+Buffer.from(JSON.stringify(data)).toString('base64')+'__RFQ_ENV_END__');`;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} -e ${quote(script)}`;
  return new Promise((resolve) => {
    run(shell, ["-ilc", command], { env: { ...env }, timeout: 8000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
      // shell 启动文件也可能输出敏感内容，不回显 stdout/stderr 或错误。
      if (!error) try {
        const encoded = String(stdout).match(/__RFQ_MODEL_ENV__([A-Za-z0-9+/=]+)__RFQ_ENV_END__/)?.[1];
        const variables = pickModelEnvironment(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
        return resolve({ variables: { ...variables, ...inherited }, claudeVariables, source: "终端环境变量" });
      } catch {}
      resolve({ variables: inherited, claudeVariables, source: "进程环境变量", error: "未能读取终端配置，可重新读取或手动配置模型" });
    });
  });
}
