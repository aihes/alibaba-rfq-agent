import { extractJson } from "./utils.js";
import { recordModelUsage } from "./model-usage.js";

/** 普通用户可直接配置 API，无需预先安装 Claude Code。
 * 只接受 HTTPS，禁止重定向带走凭据；不保存供应商的隐藏推理字段。
 */
export async function callModelHttp(config, system, payload, maxTokens = 1600, { request = fetch, phase = "unspecified" } = {}) {
  if (!config.modelApiKey || !config.modelName) throw new Error("请先在模型设置中填写 API Key 和模型名称");
  const url = new URL(config.modelApiUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("模型接口必须使用 HTTPS");
  const body = { model: config.modelName, temperature: 0, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }] };
  if (["open.bigmodel.cn", "api.z.ai"].includes(url.hostname)) body.thinking = { type: "disabled" };
  let usage, status = "failed";
  try {
    const response = await request(url.href, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.modelApiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}，请检查密钥、模型权限或余额`);
    const data = await response.json();
    usage = data.usage;
    if (data.error || data.choices?.[0]?.finish_reason === "length") throw new Error("模型返回错误或结果被截断");
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回有效文本");
    const result = extractJson(content);
    status = "success";
    return result;
  } finally {
    recordModelUsage({ provider: "openai-http", model: config.modelName, phase, status, usage });
  }
}
