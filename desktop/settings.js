import fs from "node:fs";
import path from "node:path";

export const defaults = {
  agentProvider: "openai-http", modelName: "glm-4.7",
  modelApiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  ocrProvider: "glm-ocr", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
  quotePort: "", pollIntervalSeconds: "600"
};
const secrets = ["modelApiKey", "ocrApiKey"];

/** 密钥只在主进程解密并交给任务，不通过 GET/日志回传前端。
 * blank 表示保留已有密钥，删除需要显式 clearSecrets；加密不可用时
 * 拒绝落盘，避免把明文当作“已加密”保存。
 */
export class DesktopSettings {
  constructor(directory, encryption) {
    this.file = path.join(directory, "model-settings.json");
    this.encryption = encryption;
    this.value = { ...defaults };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const key of Object.keys(defaults)) if (typeof saved[key] === "string") this.value[key] = saved[key];
      for (const key of secrets) if (saved[key]) this.value[key] = encryption.decryptString(Buffer.from(saved[key], "base64"));
    }
  }
  info() {
    return { ...Object.fromEntries(Object.keys(defaults).map((key) => [key, this.value[key]])),
      modelKeyConfigured: Boolean(this.value.modelApiKey), ocrKeyConfigured: Boolean(this.value.ocrApiKey),
      encryptedStorage: this.encryption.isEncryptionAvailable() };
  }
  save(changes) {
    const allowed = [...Object.keys(defaults), ...secrets, "clearSecrets"];
    if (!changes || Array.isArray(changes) || typeof changes !== "object" || Object.keys(changes).some((key) => !allowed.includes(key))) throw new Error("模型设置参数无效");
    const next = { ...this.value };
    for (const key of [...Object.keys(defaults), ...secrets]) {
      if (changes[key] === undefined) continue;
      if (typeof changes[key] !== "string" || changes[key].length > 2048) throw new Error("模型设置格式无效");
      if (!secrets.includes(key) || changes[key].trim()) next[key] = changes[key].trim();
    }
    if (changes.clearSecrets !== undefined) {
      if (!Array.isArray(changes.clearSecrets) || changes.clearSecrets.some((key) => !secrets.includes(key))) throw new Error("密钥删除参数无效");
      for (const key of changes.clearSecrets) delete next[key];
    }
    if (!["openai-http", "anthropic-http"].includes(next.agentProvider) || !["glm-ocr", "off"].includes(next.ocrProvider) || !next.modelName) throw new Error("请选择支持的模型服务");
    for (const key of ["modelApiUrl", "ocrApiUrl"]) {
      const url = new URL(next[key]);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("模型服务地址必须是 HTTPS 且不包含登录凭据");
      // 切换供应商时不能把上一个供应商的密钥带过去；用户须显式
      // 填写新的 Key。同服务留空仍可保留原密钥。
      const secret = key === "modelApiUrl" ? "modelApiKey" : "ocrApiKey";
      if (url.origin !== new URL(this.value[key]).origin && !changes[secret]?.trim()) delete next[secret];
    }
    if (next.agentProvider === "anthropic-http" && next.modelApiUrl !== "https://api.anthropic.com/v1/messages") throw new Error("Anthropic 服务请使用官方 messages 接口地址");
    if (!/^\d+$/.test(next.pollIntervalSeconds) || Number(next.pollIntervalSeconds) < 60 || Number(next.pollIntervalSeconds) > 86400) throw new Error("监控间隔必须为 60–86400 秒");
    if (secrets.some((key) => next[key]) && !this.encryption.isEncryptionAvailable()) throw new Error("系统密钥加密不可用，请解锁系统钥匙串后重试");
    const disk = { ...next };
    for (const key of secrets) if (next[key]) disk[key] = this.encryption.encryptString(next[key]).toString("base64");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(disk, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.value = next;
    return this.info();
  }
  environment() {
    const v = this.value;
    return { AGENT_PROVIDER: v.agentProvider, MODEL_NAME: v.modelName, MODEL_API_URL: v.modelApiUrl,
      MODEL_API_KEY: v.modelApiKey || "", ANTHROPIC_API_KEY: v.modelApiKey || "", ANTHROPIC_HTTP_MODEL: v.modelName,
      OCR_PROVIDER: v.ocrProvider, GLM_OCR_API_URL: v.ocrApiUrl, GLM_OCR_API_KEY: v.ocrApiKey || "",
      IMAGE_ANALYSIS_MODE: "local-ocr", USE_CLAUDE: "true", USE_CLAUDE_DRAFT: "true",
      QUOTE_PORT: v.quotePort, POLL_INTERVAL_SECONDS: v.pollIntervalSeconds };
  }
}
