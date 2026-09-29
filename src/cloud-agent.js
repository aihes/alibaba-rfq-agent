import fs from "node:fs/promises";
import { extractJson } from "./utils.js";
import { recordModelUsage } from "./model-usage.js";

const endpointPath = "/v1/agent";

export function cloudEndpoint(value, path = endpointPath) {
  const url = new URL(value || `https://glm.knowflow.work${path}`);
  if (url.protocol !== "https:" || url.hostname !== "glm.knowflow.work" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== path) {
    throw new Error(`云端接口必须是无凭据的 HTTPS ${path} 地址`);
  }
  return url.href;
}

async function imageBlock(filePath) {
  let bytes = await fs.readFile(filePath);
  if (!bytes.length) throw new Error("RFQ 图片为空");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  let mime = png ? "image/png" : jpeg ? "image/jpeg" : "";
  if (!mime || bytes.length > 3 * 1024 * 1024) {
    const { default: sharp } = await import("sharp");
    bytes = await sharp(bytes, { limitInputPixels: 25_000_000, animated: false })
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 }).toBuffer();
    mime = "image/jpeg";
  }
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error("RFQ 图片超过云端 3 MiB 限制");
  return { mime_type: mime, data: bytes.toString("base64") };
}

/** One isolated Claude Code session per product request; classification,
 * drafting and rationale already carry all required context in their prompts.
 */
export async function runCloudAgentJson(config, { prompt, imagePaths = [], phase = "unspecified" }, { request = fetch } = {}) {
  if (!config.cloudAgentToken) throw new Error("请在设置中填写云端服务授权令牌");
  if (prompt.length > 50_000) throw new Error("本次需求内容超过云端 Agent 限制");
  if (imagePaths.length > 2) throw new Error("云端 Agent 每次最多可读取两张图片");
  const url = cloudEndpoint(config.cloudAgentUrl);
  const images = await Promise.all(imagePaths.map(imageBlock));
  let status = "failed", model;
  try {
    const response = await request(url, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.cloudAgentToken}` },
      body: JSON.stringify({ query: prompt, images }),
      signal: AbortSignal.timeout(config.cloudAgentTimeoutMs || 210_000)
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("云端服务授权失败，请更新授权令牌");
      if (response.status === 429) throw new Error("云端服务请求达到限额，请稍后重试");
      throw new Error(`云端 Claude 请求失败（HTTP ${response.status}）`);
    }
    const result = await response.json();
    if (result.ok !== true || typeof result.answer !== "string") throw new Error("云端 Claude 返回格式无效");
    model = result.model;
    const data = extractJson(result.answer);
    status = "success";
    return { data, meta: { provider: "cloud-claude", requestedModel: model || "glm-5.3", modelsUsed: model ? [model] : [],
      imageCount: images.length, sessionId: result.session_id } };
  } finally {
    recordModelUsage({ provider: "cloud-claude", model: model || (images.length ? "glm-5.3-flash" : "glm-5.3"), phase, status });
  }
}
