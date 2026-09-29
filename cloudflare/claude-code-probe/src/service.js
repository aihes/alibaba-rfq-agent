export const MAX_BODY_BYTES = 9 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGES = 2;
export const AGENT_MODEL = "glm-5.3";
export const AGENT_IMAGE_MODEL = "glm-5.3-flash";
export const OCR_MODEL = "glm-ocr";
export const OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
export const ANTHROPIC_URL = "https://api.z.ai/api/anthropic";

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "json_required");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, "request_too_large");
  if (!request.body) throw new ApiError(400, "empty_body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new ApiError(400, "empty_body");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("object required");
    return data;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

export function parseImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_image");
  let mime = value.mime_type;
  let base64 = value.data;
  if (typeof base64 !== "string") throw new ApiError(400, "invalid_image");
  const dataUrl = /^data:(image\/(?:png|jpeg));base64,(.*)$/is.exec(base64);
  if (dataUrl) {
    if (mime && mime !== dataUrl[1].toLowerCase()) throw new ApiError(400, "invalid_image_mime");
    mime = dataUrl[1].toLowerCase();
    base64 = dataUrl[2];
  }
  if (mime !== "image/png" && mime !== "image/jpeg") throw new ApiError(400, "unsupported_image_mime");
  if (!base64.length || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ApiError(400, "invalid_image_data");
  }
  let bytes;
  try {
    const binary = atob(base64);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(400, "invalid_image_data");
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ApiError(413, "image_too_large");
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if ((mime === "image/png" && !png) || (mime === "image/jpeg" && !jpeg)) {
    throw new ApiError(400, "image_content_mismatch");
  }
  return { mime_type: mime, data: base64, byte_length: bytes.length };
}

export function validateAgent(body) {
  const query = body.query;
  if (typeof query !== "string" || !query.trim() || query.length > 6000) {
    throw new ApiError(400, "invalid_query");
  }
  const sessionId = body.session_id == null ? crypto.randomUUID() : body.session_id;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    throw new ApiError(400, "invalid_session_id");
  }
  const rawImages = body.images ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > MAX_IMAGES) throw new ApiError(400, "invalid_images");
  return { sessionId, query, images: rawImages.map(parseImage) };
}

export function validateOcr(body) {
  return { image: parseImage(body.image) };
}

export function selectAgentModel(previousModel, images) {
  return images.length || previousModel === AGENT_IMAGE_MODEL ? AGENT_IMAGE_MODEL : AGENT_MODEL;
}

export function buildClaudeInput(query, images) {
  const content = [{ type: "text", text: query }, ...images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mime_type, data: image.data }
  }))];
  return `${JSON.stringify({ type: "user", message: { role: "user", content },
    parent_tool_use_id: null })}\n`;
}

export async function callGlmOcr(image, apiKey, request = fetch) {
  let response;
  try {
    response = await request(OCR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OCR_MODEL,
        file: `data:${image.mime_type};base64,${image.data}`,
        return_crop_images: false, need_layout_visualization: false }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    console.error("OCR upstream fetch failed", error?.name ?? "unknown",
      String(error?.message ?? "").replaceAll(apiKey, "[redacted]").slice(0, 180));
    throw new ApiError(502, "ocr_network_error");
  }
  if (response.status === 429) throw new ApiError(503, "ocr_rate_limited");
  if (!response.ok) throw new ApiError(502, "ocr_upstream_error");
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(502, "ocr_invalid_response");
  }
  if (data.error) throw new ApiError(502, "ocr_upstream_error");
  const raw = typeof data.md_results === "string" ? data.md_results
    : Array.isArray(data.layout_details) ? data.layout_details.flat().map((part) => typeof part?.content === "string" ? part.content : "").join("\n") : null;
  if (raw === null) throw new ApiError(502, "ocr_invalid_response");
  const text = raw.slice(0, 50_000).trim();
  return { status: text ? "read" : "empty", text, provider_request_id: data.request_id || data.id || null };
}
