import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildAgentInputAudit } from "./agent-audit.js";
import { classifyWithClaude } from "./claude.js";
import { normalizeAgentAnalysis } from "./classifier.js";
import { createDraft } from "./drafter.js";
import { findVerifiedPriceLeads, loadVerifiedPriceLeads } from "./price-memory.js";
import { assessPriceOpportunity, loadHistoricalCaseQuotes } from "./price-opportunity.js";
import { priceRfq } from "./pricing.js";
import { reportProgress, reportProgressResult } from "./progress.js";
import { assessQuoteReadiness } from "./quote-readiness.js";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const untouchedSubmission = new Set(["not_submitted", "skipped", "plugin_prepared_not_submitted", "dry_run_not_submitted"]);

function readOriginal(root, id, expectedHash) {
  if (!safeId.test(id || "") || !/^[a-f0-9]{64}$/.test(expectedHash || "")) throw new Error("RFQ 或草稿版本无效");
  const directory = path.join(root, "data/drafts");
  const file = fs.realpathSync(path.join(directory, `${id}.json`));
  if (!file.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error("草稿路径无效");
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== expectedHash) throw new Error("草稿已变化，请刷新后重新分析");
  const record = JSON.parse(bytes.toString("utf8"));
  // A second analysis may replace only an untouched, unpriced draft. It must
  // never erase an operator's current-price approval or a browser action.
  if (record.quote?.status !== "needs_review" || record.quote?.priceEvidence || record.priceApproval ||
    !untouchedSubmission.has(record.submission?.status || "not_submitted") || !record.rfq?.id)
    throw new Error("这条 RFQ 已核价或有浏览器报价记录，不能覆盖分析");
  return { directory, file, bytes, hash, record };
}

/** Reassess an already saved RFQ without opening Alibaba. The explicit model
 * call uses the packaged quote Skill; a failed call leaves the draft intact.
 * The hash is checked again after the call so edits made meanwhile win. */
export async function reanalyzeDraft(root, id, expectedHash, config, {
  now = () => new Date(), classify = classifyWithClaude, makeDraft = createDraft
} = {}) {
  const original = readOriginal(root, id, expectedHash);
  if (config.useClaude === false || config.agentProvider === "local-rules")
    throw new Error("请先配置可用的需求分析模型");
  const { record } = original;
  const classifierAudit = buildAgentInputAudit(config, record.rfq);
  const analysisStage = reportProgress("analysis", "正在用当前报价 Skill 重新分析已保存 RFQ", {},
    { rfqId: record.rfq.id, previousRecommendation: record.analysis?.recommendation || null,
      provider: classifierAudit.provider, requestedModel: classifierAudit.requestedModel,
      prompt: classifierAudit.classifier.prompt, inputJson: classifierAudit.classifier.inputJson });
  const modelResult = await classify(config, record.rfq, config.supportedCategories);
  if (!modelResult || !new Set([...Object.keys(config.supportedCategories), "unsupported"]).has(modelResult.categoryId) ||
    !["quote", "review", "skip"].includes(modelResult.recommendation) ||
    !modelResult.fields || typeof modelResult.fields !== "object" || Array.isArray(modelResult.fields) ||
    !Array.isArray(modelResult.missingRequired) || !Array.isArray(modelResult.riskFlags))
    throw new Error("模型未返回完整的需求分析；原草稿保持不变");
  const analysis = normalizeAgentAnalysis(modelResult, record.rfq, config);
  reportProgressResult(analysisStage, { rfqId: record.rfq.id, analysis });
  const pricingStage = reportProgress("pricing", "正在检查当前价格规则", {},
    { rfqId: record.rfq.id, categoryId: analysis.categoryId, fields: analysis.fields });
  const quote = priceRfq(record.rfq, analysis, config.pricing);
  const priceOpportunity = assessPriceOpportunity(record.rfq, analysis, quote, loadHistoricalCaseQuotes(root));
  const priceMemoryLeads = findVerifiedPriceLeads(record.rfq, analysis, loadVerifiedPriceLeads(root));
  const quoteReadiness = assessQuoteReadiness({ rfq: record.rfq, analysis, quote });
  reportProgressResult(pricingStage, { rfqId: record.rfq.id, quote, priceOpportunity, priceMemoryLeads, quoteReadiness });
  const draftStage = reportProgress("draft", "正在整理本次可用的报价草稿", {},
    { rfqId: record.rfq.id, quoteStatus: quote.status });
  const draft = await makeDraft(config, record.rfq, analysis, quote);
  reportProgressResult(draftStage, { rfqId: record.rfq.id, draft,
    note: draft ? "已生成拟回复；仍需逐单核对，未发送" : "价格或规格未达生成条件，未编写买家回复" });
  const checked = readOriginal(root, id, expectedHash);
  const reviewedAt = now().toISOString();
  const updated = { ...record, analysis, quote, priceOpportunity, priceMemoryLeads, quoteReadiness, draft,
    agentInput: buildAgentInputAudit(config, record.rfq, analysis, quote, draft),
    notification: null,
    reanalysis: { reviewedAt, previousHash: original.hash,
      previousRecommendation: record.analysis?.recommendation || null,
      previousQuoteStatus: record.quote.status } };
  const revisions = path.join(checked.directory, "revisions");
  fs.mkdirSync(revisions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(revisions, `${id}-${crypto.randomUUID()}.json`), checked.bytes,
    { flag: "wx", mode: 0o600 });
  const temporary = path.join(checked.directory, `.${id}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, checked.file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  reportProgressResult(reportProgress("save", "已保存新的分析并保留原稿", {}, { rfqId: record.rfq.id }),
    { rfqId: record.rfq.id, previousRecommendation: record.analysis?.recommendation || null,
      recommendation: analysis.recommendation, quoteStatus: quote.status, fileName: `${id}.json` });
  return { id, rfqId: record.rfq.id, previousRecommendation: record.analysis?.recommendation || null,
    recommendation: analysis.recommendation, quoteStatus: quote.status, reviewedAt,
    browserAction: "none" };
}
