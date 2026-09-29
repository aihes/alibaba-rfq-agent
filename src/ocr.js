import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { sanitizeRfqText } from "./utils.js";
import { recordModelUsage } from "./model-usage.js";

/** GLM-OCR 官方 layout_parsing 协议；无需 Python、GPU 或本机编译。
 * 图片只作为识别数据，响应只作为不可信证据。缺少密钥或识别失败均返回
 * 明确状态，不中断草稿保存，不把远端错误正文/密钥写入 CASE。
 */
export async function extractImageText(imagePath, config = loadConfig(), { request = fetch } = {}) {
  const provider = config.ocrProvider || "glm-ocr";
  const unavailable = (error) => ({ status: "unavailable", text: "", provider, error });
  if (provider === "off") return unavailable("图片 OCR 已关闭");
  if (provider !== "glm-ocr") return unavailable("不支持的 OCR 服务");
  if (!config.ocrApiKey) return unavailable("请在模型设置中填写 GLM OCR API Key");
  let requestSent = false, requestStatus = "failed", usage;
  try {
    const endpoint = new URL(config.ocrApiUrl || "https://open.bigmodel.cn/api/paas/v4/layout_parsing");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("OCR 接口必须使用 HTTPS");
    let bytes = await fs.readFile(imagePath);
    const maxBytes = Math.min(config.maxImageBytes || 10 * 1024 * 1024, 10 * 1024 * 1024);
    if (!bytes.length || bytes.length > maxBytes) throw new Error("OCR 图片为空或超过大小限制");
    let mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : "";
    if (!mime) {
      // Alibaba 附件常为 WebP/GIF。sharp 随应用携带，统一为 PNG；限制
      // 解码像素，避免小体积但超大尺寸的图片耗尽内存。
      const { default: sharp } = await import("sharp");
      bytes = await sharp(bytes, { limitInputPixels: 25_000_000, animated: false }).png().toBuffer();
      mime = "image/png";
      if (bytes.length > maxBytes) throw new Error("转换后的 OCR 图片超过大小限制");
    }
    requestSent = true;
    const response = await request(endpoint.href, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.ocrApiKey}` },
      body: JSON.stringify({ model: "glm-ocr", file: `data:${mime};base64,${bytes.toString("base64")}`,
        return_crop_images: false, need_layout_visualization: false }),
      signal: AbortSignal.timeout(config.ocrTimeoutMs || 60000)
    });
    if (!response.ok) throw new Error(`GLM OCR HTTP ${response.status}，请检查密钥、余额或网络`);
    const data = await response.json();
    usage = data.usage;
    if (data.error) throw new Error("GLM OCR 返回业务错误，请检查服务配置");
    const raw = typeof data.md_results === "string" ? data.md_results
      : Array.isArray(data.layout_details) ? data.layout_details.flat().map((x) => typeof x?.content === "string" ? x.content : "").join("\n") : null;
    if (raw === null) throw new Error("GLM OCR 返回格式无法识别");
    const text = sanitizeRfqText(raw).slice(0, 50000).trim();
    requestStatus = "success";
    return { status: text ? "read" : "empty", text, provider, requestId: data.request_id || data.id || null, error: "" };
  } catch (error) {
    return { status: "error", text: "", provider,
      error: /Timeout|Abort/.test(error.name) ? "GLM OCR 请求超时" : String(error.message).replaceAll(config.ocrApiKey, "[redacted]").slice(0, 300) };
  } finally {
    if (requestSent) recordModelUsage({ provider: "glm-ocr", model: "glm-ocr", phase: "ocr",
      status: requestStatus, usage });
  }
}
