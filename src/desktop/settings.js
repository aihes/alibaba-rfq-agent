import fs from "node:fs";
import path from "node:path";
import { findLocalClaudeExecutable, pickModelEnvironment, resolveEnvironmentModel } from "./model-environment.js";
import { glmApiOrigin, glmOcrUrl, resolveGlmCredential, DEFAULT_GLM_OCR_URL } from "../glm-credentials.js";
import { cloudEndpoint } from "../cloud-agent.js";

export const defaults = {
  modelConfigSource: "auto", agentProvider: "cloud-claude", modelName: "glm-5.3",
  modelApiUrl: "https://glm.knowflow.work/v1/agent",
  ocrProvider: "cloud-ocr", ocrApiUrl: "https://glm.knowflow.work/v1/ocr",
  quotePort: "", pollIntervalSeconds: "600"
};
const secrets = ["modelApiKey", "ocrApiKey"];

/** 密钥只在主进程解密并交给任务，不通过 GET/日志回传前端。
 * blank 表示保留已有密钥，删除需要显式 clearSecrets；加密不可用时
 * 拒绝落盘，避免把明文当作“已加密”保存。
 */
export class DesktopSettings {
  constructor(directory, encryption, { localEnvironment = { variables: {}, source: "本机环境变量" }, reloadEnvironment,
    detectClaude = findLocalClaudeExecutable } = {}) {
    this.file = path.join(directory, "model-settings.json");
    this.encryption = encryption;
    this.encryptedStorage = null;
    this.value = { ...defaults };
    this.localEnvironment = localEnvironment; this.reloadEnvironment = reloadEnvironment; this.detectClaude = detectClaude;
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const key of Object.keys(defaults)) if (typeof saved[key] === "string") this.value[key] = saved[key];
      for (const key of secrets) if (saved[key]) this.value[key] = encryption.decryptString(Buffer.from(saved[key], "base64"));
      // An untouched automatic local-Claude selection follows the new cloud
      // default. Explicit manual or environment selections remain unchanged.
      if ((!saved.modelConfigSource || saved.modelConfigSource === "auto") && saved.agentProvider === "local-claude-sdk" && !saved.modelApiKey) {
        this.value.agentProvider = "cloud-claude";
        this.value.modelApiUrl = defaults.modelApiUrl;
        if (saved.ocrProvider === "glm-ocr" && !saved.ocrApiKey && (!saved.ocrApiUrl || saved.ocrApiUrl === DEFAULT_GLM_OCR_URL)) {
          this.value.ocrProvider = "cloud-ocr"; this.value.ocrApiUrl = defaults.ocrApiUrl;
        }
      }
      // 0.7.3 保存过空密钥的旧默认设置时，升级到新默认；用户明确
      // 配置过 HTTP、模型名或密钥则保留原选择。
      if ((!saved.modelConfigSource || saved.modelConfigSource === "auto") && saved.agentProvider === "openai-http"
        && saved.modelName === "glm-4.7" && !saved.modelApiKey) {
        this.value.agentProvider = defaults.agentProvider; this.value.modelName = defaults.modelName;
        this.value.modelApiUrl = defaults.modelApiUrl;
        if (saved.ocrProvider === "glm-ocr" && !saved.ocrApiKey && (!saved.ocrApiUrl || saved.ocrApiUrl === DEFAULT_GLM_OCR_URL)) {
          this.value.ocrProvider = "cloud-ocr"; this.value.ocrApiUrl = defaults.ocrApiUrl;
        }
      }
      if (secrets.some((key) => saved[key])) this.encryptedStorage = true;
    }
  }
  resolved() {
    let local = null, error = this.localEnvironment.error || null;
    try { local = resolveEnvironmentModel(this.localEnvironment.variables); }
    catch { error = "本机模型地址格式无效，请检查环境变量或改用手动配置"; }
    const claudeExecutable = this.detectClaude({ ...this.localEnvironment.claudeVariables, ...this.localEnvironment.variables });
    const cloudToken = pickModelEnvironment(this.localEnvironment.variables).RFQ_CLOUD_TOKEN || "";
    const useLocal = this.value.modelConfigSource === "environment" || (this.value.modelConfigSource === "auto" && this.value.agentProvider !== "cloud-claude"
      && !this.value.modelApiKey && local && (this.value.agentProvider !== "local-claude-sdk" || !claudeExecutable));
    const cloud = !useLocal && this.value.agentProvider === "cloud-claude" && !this.value.modelApiKey && cloudToken;
    return { value: useLocal ? { ...this.value, agentProvider: local?.agentProvider || defaults.agentProvider, modelName: local?.modelName || defaults.modelName,
      modelApiUrl: local?.modelApiUrl || defaults.modelApiUrl, modelApiKey: local?.modelApiKey || "" }
      : cloud ? { ...this.value, modelApiKey: cloudToken } : this.value,
      source: useLocal ? "environment" : cloud ? "environment" : this.value.agentProvider === "local-claude-sdk" ? "local-claude" : "manual", local, error, claudeExecutable };
  }
  async refreshEnvironment() {
    if (!this.reloadEnvironment) throw new Error("当前运行方式不支持重新读取环境变量");
    this.localEnvironment = await this.reloadEnvironment();
    return this.info();
  }
  ocrConfiguration(resolved = this.resolved()) {
    const e = pickModelEnvironment(this.localEnvironment.variables);
    if (this.value.ocrProvider === "cloud-ocr") {
      const url = this.value.ocrApiUrl;
      const model = resolved.value;
      const shared = model.agentProvider === "cloud-claude" && new URL(model.modelApiUrl).origin === new URL(url).origin
        ? model.modelApiKey || "" : "";
      return { apiKey: this.value.ocrApiKey || shared, apiUrl: url,
        source: this.value.ocrApiKey ? "saved-ocr" : shared ? "cloud-model" : "missing" };
    }
    const c = pickModelEnvironment(this.localEnvironment.claudeVariables || {});
    const configuredUrl = e.GLM_OCR_API_URL || this.value.ocrApiUrl;
    if (this.value.ocrApiKey) return { apiKey: this.value.ocrApiKey, apiUrl: this.value.ocrApiUrl, source: "saved-ocr" };
    if (e.GLM_OCR_API_KEY) return { apiKey: e.GLM_OCR_API_KEY, apiUrl: configuredUrl, source: "environment-ocr", keyVariable: "GLM_OCR_API_KEY" };

    // The selected model may use a generic Anthropic/proxy key. Reuse a saved
    // model key only when its URL is an official Zhipu endpoint; otherwise look
    // for a separately identified GLM key in the local environment.
    const savedOrigin = glmApiOrigin(this.value.modelApiUrl);
    const savedModel = this.value.modelApiKey && savedOrigin && resolved.source !== "environment"
      ? { apiKey: this.value.modelApiKey, origin: savedOrigin, source: "saved-model" } : null;
    const environment = resolveGlmCredential(e) || resolveGlmCredential(c);
    const shared = savedModel || (environment && { ...environment, source: "environment-model" });
    if (!shared) return { apiKey: "", apiUrl: configuredUrl, source: "missing" };

    // The default URL follows the key's official platform. An explicit OCR URL
    // may only inherit a shared key if it stays on that same origin.
    const customUrl = (e.GLM_OCR_API_URL && e.GLM_OCR_API_URL !== DEFAULT_GLM_OCR_URL ? e.GLM_OCR_API_URL : "")
      || (this.value.ocrApiUrl !== DEFAULT_GLM_OCR_URL ? this.value.ocrApiUrl : "");
    if (customUrl && glmApiOrigin(customUrl) !== shared.origin) return { apiKey: "", apiUrl: customUrl, source: "endpoint-mismatch" };
    return { apiKey: shared.apiKey, apiUrl: customUrl || glmOcrUrl(shared.origin), source: shared.source,
      keyVariable: shared.keyVariable };
  }
  info() {
    const resolved = this.resolved(), v = resolved.value, ocr = this.ocrConfiguration(resolved);
    return { ...Object.fromEntries(Object.keys(defaults).map((key) => [key, v[key]])),
      modelKeyConfigured: Boolean(v.modelApiKey), modelReady: v.agentProvider === "local-claude-sdk" ? Boolean(resolved.claudeExecutable) : Boolean(v.modelApiKey),
      claudeExecutableAvailable: Boolean(resolved.claudeExecutable),
      ocrKeyConfigured: Boolean(ocr.apiKey), ocrKeySource: ocr.source, ocrKeyVariable: ocr.keyVariable || null,
      effectiveOcrApiUrl: ocr.apiUrl,
      effectiveModelSource: resolved.source, environmentModelAvailable: Boolean(resolved.local), environmentSource: this.localEnvironment.source,
      environmentKeyVariable: resolved.local?.keyVariable || null, environmentError: resolved.error,
      // macOS 的能力查询也可能等待钥匙串授权。读取设置页无需密钥，
      // 不在 GET 请求中触发系统授权；null 表示尚未实际检查。
      encryptedStorage: this.encryptedStorage };
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
    if (!["auto", "environment", "manual"].includes(next.modelConfigSource) || !["cloud-claude", "local-claude-sdk", "openai-http", "anthropic-http"].includes(next.agentProvider) || !["cloud-ocr", "glm-ocr", "off"].includes(next.ocrProvider) || !next.modelName) throw new Error("请选择支持的模型服务");
    for (const key of ["modelApiUrl", "ocrApiUrl"]) {
      const url = new URL(next[key]);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("模型服务地址必须是 HTTPS 且不包含登录凭据");
      // 切换供应商时不能把上一个供应商的密钥带过去；用户须显式
      // 填写新的 Key。同服务留空仍可保留原密钥。
      const secret = key === "modelApiUrl" ? "modelApiKey" : "ocrApiKey";
      if (url.origin !== new URL(this.value[key]).origin && !changes[secret]?.trim()) delete next[secret];
    }
    if (next.agentProvider === "anthropic-http" && !new URL(next.modelApiUrl).pathname.endsWith("/v1/messages")) throw new Error("Anthropic 兼容接口地址须以 /v1/messages 结尾");
    if (next.agentProvider === "cloud-claude") cloudEndpoint(next.modelApiUrl);
    if (next.ocrProvider === "cloud-ocr") cloudEndpoint(next.ocrApiUrl, "/v1/ocr");
    if (!/^\d+$/.test(next.pollIntervalSeconds) || Number(next.pollIntervalSeconds) < 60 || Number(next.pollIntervalSeconds) > 86400) throw new Error("监控间隔必须为 60–86400 秒");
    if (secrets.some((key) => next[key])) {
      this.encryptedStorage = this.encryption.isEncryptionAvailable();
      if (!this.encryptedStorage) throw new Error("系统密钥加密不可用，请解锁系统钥匙串后重试");
    }
    const disk = { ...next };
    for (const key of secrets) if (next[key]) disk[key] = this.encryption.encryptString(next[key]).toString("base64");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(disk, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.value = next;
    return this.info();
  }
  environment() {
    const resolved = this.resolved(), v = resolved.value, e = pickModelEnvironment(this.localEnvironment.variables),
      c = pickModelEnvironment(this.localEnvironment.claudeVariables || {}), localClaude = v.agentProvider === "local-claude-sdk",
      claudeAuth = (c.ANTHROPIC_AUTH_TOKEN || c.ANTHROPIC_API_KEY) && c.ANTHROPIC_BASE_URL ? c : e,
      ocr = this.ocrConfiguration(resolved);
    const cloudClaude = v.agentProvider === "cloud-claude";
    return { AGENT_PROVIDER: v.agentProvider, MODEL_NAME: v.modelName, MODEL_API_URL: v.modelApiUrl,
      RFQ_MODEL_CONFIG_SOURCE: resolved.source === "environment" ? this.localEnvironment.source : localClaude ? "本机 Claude" : "已保存配置",
      MODEL_API_KEY: localClaude ? "" : v.modelApiKey || "",
      RFQ_CLOUD_TOKEN: cloudClaude ? v.modelApiKey || "" : "",
      RFQ_CLOUD_AGENT_URL: cloudClaude ? v.modelApiUrl : "",
      ...(localClaude ? { ...((!claudeAuth.ANTHROPIC_AUTH_TOKEN && claudeAuth.ANTHROPIC_API_KEY) ? { ANTHROPIC_API_KEY: claudeAuth.ANTHROPIC_API_KEY } : {}),
        ...((claudeAuth.ANTHROPIC_AUTH_TOKEN) ? { ANTHROPIC_AUTH_TOKEN: claudeAuth.ANTHROPIC_AUTH_TOKEN } : {}),
        ...((claudeAuth.ANTHROPIC_BASE_URL) ? { ANTHROPIC_BASE_URL: claudeAuth.ANTHROPIC_BASE_URL } : {}) }
        : cloudClaude ? {} : { ANTHROPIC_API_KEY: v.modelApiKey || "", ANTHROPIC_HTTP_MODEL: v.modelName, ANTHROPIC_API_URL: v.modelApiUrl }),
      LOCAL_CLAUDE_EXECUTABLE: localClaude ? resolved.claudeExecutable : "",
      // 界面中显示的模型名就是 SDK 实际请求的模型。用户级 Claude
      // 默认模型可能指向别的服务或上下文变体，不覆盖本应用的选择。
      LOCAL_CLAUDE_MODEL: localClaude ? v.modelName : "",
      // 只复用本机 Claude 的认证/端点，不加载用户级 hooks、插件或
      // 额外指令；这些会改变报价任务的回合数与执行边界。
      LOCAL_CLAUDE_SETTING_SOURCES: "none",
      OCR_PROVIDER: v.ocrProvider, GLM_OCR_API_URL: ocr.apiUrl, GLM_OCR_API_KEY: ocr.apiKey,
      RFQ_CLOUD_OCR_TOKEN: v.ocrProvider === "cloud-ocr" ? ocr.apiKey : "",
      IMAGE_ANALYSIS_MODE: cloudClaude ? "agent-read" : "local-ocr", USE_CLAUDE: "true", USE_CLAUDE_DRAFT: "true",
      QUOTE_PORT: v.quotePort, POLL_INTERVAL_SECONDS: v.pollIntervalSeconds };
  }
}
