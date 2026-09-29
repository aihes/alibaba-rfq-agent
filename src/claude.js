import path from "node:path";
import { runLocalAgentJson } from "./local-agent.js";
import { extractImageText } from "./ocr.js";
import { extractJson, sanitizeRfqText } from "./utils.js";
import { callModelHttp } from "./model-http.js";
import { buildModelPrompt, renderPrompt } from "./prompt-templates.js";
import { withQuoteSkill } from "./quote-skill.js";
import { recordModelUsage } from "./model-usage.js";

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableBoolean = { anyOf: [{ type: "boolean" }, { type: "null" }] };

function classificationSchema(categoryIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["categoryId", "confidence", "fields", "missingRequired", "riskFlags", "buyerQuestions", "recommendation", "imageReadStatus", "imageEvidence"],
    properties: {
      categoryId: { type: "string", enum: [...categoryIds, "unsupported"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      fields: {
        type: "object",
        additionalProperties: false,
        required: ["quantity", "widthMm", "heightMm", "bottomMm", "lengthMm", "capacityOz", "gsm", "material", "greaseproof", "printing", "flute", "color"],
        properties: {
          quantity: nullableNumber,
          widthMm: nullableNumber,
          heightMm: nullableNumber,
          bottomMm: nullableNumber,
          lengthMm: nullableNumber,
          capacityOz: nullableNumber,
          gsm: nullableNumber,
          material: nullableString,
          greaseproof: nullableBoolean,
          printing: nullableString,
          flute: nullableString,
          color: nullableString
        }
      },
      missingRequired: { type: "array", items: { type: "string" } },
      riskFlags: { type: "array", items: { type: "string" } },
      buyerQuestions: { type: "array", items: { type: "string" }, maxItems: 3 },
      recommendation: { type: "string", enum: ["quote", "review", "skip"] },
      imageReadStatus: { type: "string", enum: ["not_provided", "read", "partial", "unsupported", "error"] },
      imageEvidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "observations"],
          properties: {
            path: { type: "string" },
            observations: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  };
}

const draftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["productName", "productDetails", "buyerMessage", "port", "validityDays", "sampleAvailable"],
  properties: {
    productName: { type: "string" },
    productDetails: { type: "string" },
    buyerMessage: { type: "string" },
    port: { type: "string" },
    validityDays: { type: "number" },
    sampleAvailable: { type: "boolean" }
  }
};

const quoteRationaleSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "decisionSummary",
    "evidence",
    "ruleEvaluation",
    "calculation",
    "assumptions",
    "risks",
    "nextAction",
    "pricingBoundary"
  ],
  properties: {
    decision: { type: "string", enum: ["quoted", "conditional_quote", "needs_review", "skip"] },
    decisionSummary: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact", "source"],
        properties: {
          fact: { type: "string" },
          source: { type: "string" }
        }
      }
    },
    ruleEvaluation: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "observed", "required", "status"],
        properties: {
          check: { type: "string" },
          observed: { type: "string" },
          required: { type: "string" },
          status: { type: "string", enum: ["matched", "mismatch", "unknown"] }
        }
      }
    },
    calculation: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    nextAction: { type: "array", items: { type: "string" } },
    pricingBoundary: { type: "string" }
  }
};

export async function callAnthropicHttp(config, system, payload, maxTokens = 1600, { request = fetch, phase = "unspecified" } = {}) {
  if (!config.anthropicApiKey || !config.anthropicModel) {
    throw new Error("anthropic-http requires ANTHROPIC_API_KEY and ANTHROPIC_HTTP_MODEL");
  }
  const url = new URL(config.anthropicApiUrl || "https://api.anthropic.com/v1/messages");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1/messages")) throw new Error("Anthropic 兼容接口须为无凭据的 HTTPS messages 地址");
  let usage, status = "failed";
  try {
  const response = await request(url.href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      ...(["open.bigmodel.cn", "api.z.ai"].includes(url.hostname) ? { thinking: { type: "disabled" } } : {}),
      messages: [{ role: "user", content: JSON.stringify(payload) }]
    }),
    redirect: "error",
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}，请检查密钥、模型权限或余额`);
  const data = await response.json();
  usage = data.usage;
  if (data.error || data.stop_reason === "max_tokens") throw new Error("模型返回错误或结果被截断");
  const result = extractJson(data.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") || "");
  status = "success";
  return result;
  } finally {
    recordModelUsage({ provider: "anthropic-http", model: config.anthropicModel, phase, status, usage });
  }
}

function classificationPayload(rfq, supportedCategories, pricing) {
  return {
    categoryContract: Object.fromEntries(Object.entries(supportedCategories).map(([id, value]) => [id, value.keywords])),
    // The model needs to know which specifications matter to the local price
    // gate, but it must never receive the actual price table in a classifier
    // request. The rule engine remains the only source of calculated amounts.
    pricingCoverage: Object.fromEntries(Object.entries(pricing?.rules || {}).map(([id, rule]) => [id, {
      requiredFields: rule.requiredFields || [],
      pricedQuantities: rule.exactTiers ? Object.keys(rule.exactTiers).map(Number) : [rule.baseQty].filter(Number.isFinite),
      validatedScenario: rule.validatedScenario || ""
    }])),
    rfq: {
      title: rfq.title,
      summary: rfq.summary,
      detailText: sanitizeRfqText(rfq.detailText),
      quantity: rfq.quantity,
      country: rfq.country
    },
    localImageOcr: (rfq.imageAssets || []).map((asset) => ({
      path: asset.filePath,
      status: asset.ocrStatus || "unavailable",
      text: sanitizeRfqText(asset.ocrText || "")
    }))
  };
}

export function buildClassificationRequest(config, rfq, supportedCategories) {
  const payload = classificationPayload(rfq, supportedCategories, config.pricing);
  const imagePaths = (rfq.imagePaths || []).slice(0, config.maxRfqImages);
  // 只有本机 Claude Agent 具备 Read 工具；HTTP 模型只能使用已提取的 OCR 文本。
  const agentImagePaths = config.agentProvider === "local-claude-sdk" && config.imageAnalysisMode === "agent-read" ? imagePaths : [];
  const imageInstructions = agentImagePaths.length
    ? renderPrompt("image-read", { imagePaths: agentImagePaths.map((filePath) => `- ${filePath}`).join("\n") })
    : imagePaths.length
      ? renderPrompt("image-ocr")
    : renderPrompt("image-none");
  const { prompt, systemPrompt } = withQuoteSkill(buildModelPrompt("classification.system", { imageInstructions }, payload));

  return {
    prompt,
    systemPrompt,
    payload,
    imagePaths,
    agentImagePaths,
    imageInstructions,
    maxTurns: agentImagePaths.length ? agentImagePaths.length + 2 : 1
  };
}

export async function classifyWithClaude(config, rfq, supportedCategories) {
  const request = buildClassificationRequest(config, rfq, supportedCategories);

  if (config.agentProvider === "openai-http") {
    const data = await callModelHttp(config, request.systemPrompt, request.payload, 1600, { phase: "classification" });
    const images = rfq.imageAssets || [];
    const hasOcr = images.some((image) => image.ocrStatus === "read" && image.ocrText);
    return { ...data, imageReadStatus: hasOcr ? "partial" : images.length ? "unsupported" : "not_provided",
      imageEvidence: hasOcr && Array.isArray(data.imageEvidence) ? data.imageEvidence : [],
      agent: { provider: "openai-http", requestedModel: config.modelName } };
  }

  if (config.agentProvider === "local-claude-sdk") {
    const { data, meta } = await runLocalAgentJson(config, {
      prompt: request.prompt,
      schema: classificationSchema(Object.keys(supportedCategories)),
      imagePaths: request.agentImagePaths,
      maxTurns: request.maxTurns,
      phase: "classification"
    });
    return { ...data, agent: meta };
  }

  if (config.agentProvider === "anthropic-http") {
    const data = await callAnthropicHttp(config, request.systemPrompt, request.payload, 1600, { phase: "classification" });
    return { ...data, imageReadStatus: "not_provided", imageEvidence: [], agent: { provider: "anthropic-http", requestedModel: config.anthropicModel } };
  }
  throw new Error(`Unsupported AGENT_PROVIDER: ${config.agentProvider}`);
}

export function buildDraftRequest(rfq, analysis, quote) {
  const payload = {
    // Drafting needs the buyer's actual request, not just its search-card title.
    // Keep untrusted buyer text sanitized before it enters the model prompt.
    rfq: { title: rfq.title, summary: sanitizeRfqText(rfq.summary),
      detailText: sanitizeRfqText(rfq.detailText), country: rfq.country, quantity: rfq.quantity },
    analysis,
    quote
  };
  return { ...withQuoteSkill(buildModelPrompt("draft.system", {}, payload)), payload, maxTurns: 1 };
}

export async function draftWithClaude(config, rfq, analysis, quote) {
  const request = buildDraftRequest(rfq, analysis, quote);

  if (config.agentProvider === "openai-http") {
    const data = await callModelHttp(config, request.systemPrompt, request.payload, 1000, { phase: "draft" });
    return { ...data, agent: { provider: "openai-http", requestedModel: config.modelName } };
  }

  if (config.agentProvider === "local-claude-sdk") {
    const { data, meta } = await runLocalAgentJson(config, { prompt: request.prompt, schema: draftSchema, maxTurns: request.maxTurns, phase: "draft" });
    return { ...data, agent: meta };
  }

  if (config.agentProvider === "anthropic-http") {
    const data = await callAnthropicHttp(config, request.systemPrompt, request.payload, 1000, { phase: "draft" });
    return { ...data, agent: { provider: "anthropic-http", requestedModel: config.anthropicModel } };
  }
  throw new Error(`Unsupported AGENT_PROVIDER: ${config.agentProvider}`);
}

export function buildQuoteRationaleRequest(config, rfq, analysis, quote) {
  const categoryRule = config.pricing?.rules?.[analysis.categoryId] || null;
  const payload = {
    originalRfq: {
      title: rfq.title,
      summary: rfq.summary,
      detailText: sanitizeRfqText(rfq.detailText),
      quantity: rfq.quantity,
      country: rfq.country,
      localImageOcr: (rfq.imageAssets || []).map((asset) => ({
        path: asset.filePath,
        status: asset.ocrStatus || "unavailable",
        text: sanitizeRfqText(asset.ocrText || "")
      }))
    },
    normalizedAnalysis: analysis,
    deterministicQuote: quote,
    pricingPolicy: {
      currency: config.pricing?.currency || null,
      tradeTerm: config.pricing?.tradeTerm || null,
      rulesVersion: config.pricing?.rulesVersion || null,
      categoryRule
    }
  };
  return { ...withQuoteSkill(buildModelPrompt("rationale.system", {}, payload)), payload, maxTurns: 1 };
}

export async function explainQuoteWithClaude(config, rfq, analysis, quote) {
  const request = buildQuoteRationaleRequest(config, rfq, analysis, quote);

  if (config.agentProvider === "openai-http") {
    const data = await callModelHttp(config, request.systemPrompt, request.payload, 1800, { phase: "rationale" });
    return { request, output: data, agent: { provider: "openai-http", requestedModel: config.modelName } };
  }

  if (config.agentProvider === "local-claude-sdk") {
    const { data, meta } = await runLocalAgentJson(config, {
      prompt: request.prompt,
      schema: quoteRationaleSchema,
      maxTurns: request.maxTurns,
      phase: "rationale"
    });
    return { request, output: data, agent: meta };
  }

  if (config.agentProvider === "anthropic-http") {
    const data = await callAnthropicHttp(config, request.systemPrompt, request.payload, 1400, { phase: "rationale" });
    return {
      request,
      output: data,
      agent: { provider: "anthropic-http", requestedModel: config.anthropicModel }
    };
  }
  throw new Error(`Unsupported AGENT_PROVIDER: ${config.agentProvider}`);
}

export async function probeLocalVision(config, imagePath) {
  const ocr = await extractImageText(imagePath, config);
  const probeHints = {
    tradeTerm: ocr.text.match(/\b(EXW|FOB|CIF|CFR|DAP|DDP)\b/i)?.[1]?.toUpperCase() || null,
    quantity: Number(ocr.text.match(/\bQuantity\s*[^\d]{0,8}(\d+(?:\.\d+)?)/i)?.[1] || NaN),
    unitPrice: Number(ocr.text.match(/\bPrice\s*[^\d]{0,8}(\d+(?:\.\d+)?)/i)?.[1] || NaN)
  };
  if (!Number.isFinite(probeHints.quantity)) probeHints.quantity = null;
  if (!Number.isFinite(probeHints.unitPrice)) probeHints.unitPrice = null;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["imageReadStatus", "method", "tradeTerm", "quantity", "unitPrice", "notes"],
    properties: {
      imageReadStatus: { type: "string", enum: ["read", "partial", "unsupported", "error"] },
      method: { type: "string", enum: ["native-vision", "local-ocr", "none"] },
      tradeTerm: nullableString,
      quantity: nullableNumber,
      unitPrice: nullableNumber,
      notes: { type: "array", items: { type: "string" } }
    }
  };
  const absolutePath = path.resolve(imagePath);
  const agentRead = config.imageAnalysisMode === "agent-read";
  const prompt = renderPrompt("vision-probe", {
    imageInstruction: agentRead ? renderPrompt("vision-read", { imagePath: absolutePath }) : renderPrompt("vision-ocr"),
    ocrStatus: ocr.status, parserJson: JSON.stringify(probeHints), ocrText: ocr.text
  });
  const result = await runLocalAgentJson(config, {
    prompt,
    schema,
    imagePaths: agentRead ? [absolutePath] : [],
    maxTurns: agentRead ? 3 : 1
  });
  if (!agentRead && ocr.status === "read") {
    result.data = {
      ...result.data,
      imageReadStatus: "partial",
      method: "local-ocr",
      tradeTerm: result.data.tradeTerm || probeHints.tradeTerm,
      quantity: result.data.quantity ?? probeHints.quantity,
      unitPrice: result.data.unitPrice ?? probeHints.unitPrice
    };
  }
  return result;
}
