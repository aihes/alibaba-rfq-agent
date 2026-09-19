import { classifyWithClaude } from "./claude.js";
import { keywordPrefilter } from "./collector.js";

const numberNear = (text, pattern) => {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
};

export function classifyLocally(rfq, supportedCategories) {
  const ranked = keywordPrefilter(rfq, supportedCategories);
  const categoryId = ranked[0]?.categoryId || "unsupported";
  const text = `${rfq.title}\n${rfq.summary}\n${rfq.detailText || ""}`.toLowerCase();
  const dimensions = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)/gi)][0];
  const scale = dimensions?.[0]?.toLowerCase().includes("cm") ? 10 : 1;
  return {
    categoryId,
    confidence: ranked[0] ? Math.min(0.55 + ranked[0].score * 0.1, 0.9) : 0.1,
    fields: {
      quantity: rfq.quantity,
      lengthMm: dimensions ? Number(dimensions[1]) * scale : null,
      widthMm: dimensions ? Number(dimensions[2]) * scale : null,
      heightMm: dimensions ? Number(dimensions[3]) * scale : null,
      bottomMm: numberNear(text, /(?:bottom|底)[^\d]{0,15}(\d+(?:\.\d+)?)\s*mm/i),
      capacityOz: numberNear(text, /(\d+(?:\.\d+)?)\s*oz/i),
      gsm: numberNear(text, /(\d+(?:\.\d+)?)\s*gsm/i),
      material: /304|18\/8/.test(text) ? "304 stainless steel" : /kraft/.test(text) ? "kraft paper" : null,
      greaseproof: /greaseproof|oil[- ]?proof|防油/.test(text) ? true : null,
      printing: /360|full wrap/.test(text) ? "360 full wrap" : /no print|unprinted|无印刷/.test(text) ? "none" : null,
      flute: text.match(/\b([abcef])\s*[- ]?flute\b/i)?.[1]?.toUpperCase() || null,
      color: text.match(/\b(black|white|brown|kraft|silver|red|blue|green)\b/i)?.[1] || null
    },
    missingRequired: [],
    riskFlags: ["Local classifier used; verify extracted specifications"],
    buyerQuestions: [],
    recommendation: categoryId === "unsupported" ? "skip" : "review"
  };
}

const numericFields = new Set(["quantity", "widthMm", "heightMm", "bottomMm", "lengthMm", "capacityOz", "gsm"]);
const fieldNames = ["quantity", "widthMm", "heightMm", "bottomMm", "lengthMm", "capacityOz", "gsm", "material", "greaseproof", "printing", "flute", "color"];

function stringList(value, max = 20) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, max) : [];
}

export function normalizeAgentAnalysis(value, rfq, config) {
  const allowedCategories = new Set([...Object.keys(config.supportedCategories), "unsupported"]);
  const fields = {};
  for (const name of fieldNames) {
    const raw = value?.fields?.[name];
    if (numericFields.has(name)) {
      const parsed = raw === null || raw === undefined || raw === "" ? null : Number(raw);
      fields[name] = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } else if (name === "greaseproof") {
      fields[name] = typeof raw === "boolean" ? raw : null;
    } else {
      fields[name] = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : null;
    }
  }
  const hasImages = (rfq.imagePaths || []).length > 0;
  const hasOcr = (rfq.imageAssets || []).some((asset) => asset.ocrStatus === "read" && asset.ocrText);
  const forcedImageStatus = !hasImages
    ? "not_provided"
    : config.imageAnalysisMode === "local-ocr"
      ? hasOcr ? "partial" : "error"
      : ["read", "partial", "unsupported", "error"].includes(value?.imageReadStatus) ? value.imageReadStatus : "error";
  return {
    ...value,
    categoryId: allowedCategories.has(value?.categoryId) ? value.categoryId : "unsupported",
    confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0)),
    fields,
    missingRequired: stringList(value?.missingRequired),
    riskFlags: stringList(value?.riskFlags),
    buyerQuestions: stringList(value?.buyerQuestions, 3),
    recommendation: ["quote", "review", "skip"].includes(value?.recommendation) ? value.recommendation : "review",
    imageReadStatus: forcedImageStatus,
    imageEvidence: Array.isArray(value?.imageEvidence) ? value.imageEvidence.slice(0, config.maxRfqImages) : []
  };
}

export async function classifyRfq(config, rfq) {
  if (config.useClaude && config.agentProvider !== "local-rules") {
    try {
      return normalizeAgentAnalysis(await classifyWithClaude(config, rfq, config.supportedCategories), rfq, config);
    } catch (error) {
      const fallback = classifyLocally(rfq, config.supportedCategories);
      fallback.imageReadStatus = (rfq.imagePaths || []).length ? "error" : "not_provided";
      fallback.imageEvidence = [];
      fallback.riskFlags.push(`Agent fallback: ${error.message}`);
      return fallback;
    }
  }
  const local = classifyLocally(rfq, config.supportedCategories);
  local.imageReadStatus = (rfq.imagePaths || []).length ? "unsupported" : "not_provided";
  local.imageEvidence = [];
  return local;
}
