#!/usr/bin/env node
// Receives the API key on stdin so it never appears in a command line or log.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const endpoints = {
  china: "https://open.bigmodel.cn/api/anthropic",
  zai: "https://api.z.ai/api/anthropic"
};

function configure({ region, executable, home = os.homedir(), key }) {
  if (!Object.hasOwn(endpoints, region)) throw new Error("请选择智谱国内或 Z.AI 平台");
  if (!key || key.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(key)) throw new Error("API Key 为空或包含无效字符");
  if (!path.isAbsolute(executable) || /\.(cmd|bat)$/i.test(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("未找到可用的 Claude 原生可执行文件");
  }
  const directory = path.join(home, ".claude");
  const file = path.join(directory, "settings.json");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Claude 设置目录不能是符号链接");
  let settings = {}, original = null;
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Claude 设置文件不是普通文件");
    original = fs.readFileSync(file);
    try { settings = JSON.parse(original.toString("utf8")); }
    catch { throw new Error("现有 Claude 设置不是有效 JSON，未修改文件"); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("现有 Claude 设置格式无效，未修改文件");
  }
  if (settings.env != null && (typeof settings.env !== "object" || Array.isArray(settings.env))) {
    throw new Error("现有 Claude env 设置格式无效，未修改文件");
  }
  // A previous Anthropic API key can take precedence over the new GLM token.
  // Keep it in the backup, but do not leave conflicting credentials active.
  const claudeEnv = { ...settings.env };
  delete claudeEnv.ANTHROPIC_API_KEY;
  delete claudeEnv.ANTHROPIC_API_URL;
  settings.env = { ...claudeEnv,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_BASE_URL: endpoints[region],
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
    LOCAL_CLAUDE_EXECUTABLE: executable
  };
  const temporary = path.join(directory, `.settings.json.rfq-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  let backup = null;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (original) {
      backup = path.join(directory, `settings.json.before-rfq-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.bak`);
      fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return { file, backup, region };
}

if (require.main === module) {
  try {
    const [regionFlag, region, executableFlag, executable] = process.argv.slice(2);
    if (regionFlag !== "--region" || executableFlag !== "--executable" || !executable || process.argv.length !== 6) {
      throw new Error("用法：configure-local-claude.cjs --region china|zai --executable 绝对路径；Key 从标准输入读取");
    }
    const key = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
    const result = configure({ region, executable, key });
    process.stdout.write(`Claude 已配置：${result.region}。设置文件：${result.file}\n`);
    if (result.backup) process.stdout.write(`原设置备份：${result.backup}\n`);
  } catch (error) {
    process.stderr.write(`配置失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configure };
