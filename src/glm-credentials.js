const GLM_KEYS = ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "ZAI_API_KEY", "ZAI_APIKEY"];
const GLM_HOSTS = new Set(["open.bigmodel.cn", "api.z.ai"]);

export function glmApiOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && GLM_HOSTS.has(url.hostname) ? url.origin : null;
  } catch { return null; }
}

/** Resolve a credential only when its configured model endpoint belongs to
 * Zhipu. Generic Anthropic or proxy credentials must never be sent to OCR.
 */
export function resolveGlmCredential(env = {}) {
  for (const keyVariable of GLM_KEYS) {
    const apiKey = env[keyVariable]?.trim();
    if (!apiKey) continue;
    const base = env.GLM_BASE_URL || env.ZAI_BASE_URL || (keyVariable.startsWith("ZAI")
      ? "https://api.z.ai/api/paas/v4" : "https://open.bigmodel.cn/api/paas/v4");
    const origin = glmApiOrigin(base);
    if (origin) return { apiKey, origin, keyVariable };
  }
  if (env.MODEL_API_KEY?.trim()) {
    const origin = glmApiOrigin(env.MODEL_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    if (origin) return { apiKey: env.MODEL_API_KEY.trim(), origin, keyVariable: "MODEL_API_KEY" };
  }
  const anthropicUrl = env.ANTHROPIC_API_URL || env.ANTHROPIC_BASE_URL;
  const anthropicKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  const origin = anthropicUrl && glmApiOrigin(anthropicUrl);
  if (origin && anthropicKey?.trim()) return { apiKey: anthropicKey.trim(), origin,
    keyVariable: env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY" };
  return null;
}

export const glmOcrUrl = (origin) => `${origin}/api/paas/v4/layout_parsing`;
export const DEFAULT_GLM_OCR_URL = glmOcrUrl("https://open.bigmodel.cn");
