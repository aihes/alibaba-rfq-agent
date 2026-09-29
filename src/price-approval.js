import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { draftLocally } from "./drafter.js";
import { hasDefiniteQuote, operatorPriceExpired, quoteRiskFingerprint } from "./quote-visibility.js";
import { roundUp } from "./utils.js";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const editableSubmission = new Set(["not_submitted", "skipped", "plugin_prepared_not_submitted", "dry_run_not_submitted"]);

function priceNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10000 ||
    Math.abs(value * 10000 - Math.round(value * 10000)) > 0.000001) throw new Error("美元单价须大于 0，且最多四位小数");
  return value;
}

/** An operator's current selling price is a new source of evidence for this
 * exact RFQ only. It never changes reusable price rules or contacts Alibaba.
 * The original scan is archived before replacement, and a revision hash keeps
 * a stale browser form from overwriting a newer scan or submission attempt. */
export function approveRfqPrice(root, input, { now = new Date(), port = "" } = {}) {
  const allowed = new Set(["id", "rfqId", "reviewHash", "unitPriceUsd", "validThrough", "sourceNote", "specification", "riskResolution", "missingResolutions", "approved"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key)) ||
    !safeId.test(input.id || "") || !safeId.test(input.rfqId || "") || input.approved !== true) throw new Error("请逐项核对 RFQ、现价和适用规格");
  const directory = path.join(root, "data/drafts");
  const file = path.join(directory, `${input.id}.json`);
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error("草稿路径无效");
  const original = fs.readFileSync(resolved);
  const hash = crypto.createHash("sha256").update(original).digest("hex");
  if (hash !== input.reviewHash) throw new Error("草稿已变化，请刷新后重新核对");
  const record = JSON.parse(original.toString("utf8"));
  if (record.rfq?.id !== input.rfqId) throw new Error("RFQ ID 确认不匹配");
  if (!record.analysis?.categoryId || record.analysis.categoryId === "unsupported" ||
    (!["needs_review", "conditional_quote"].includes(record.quote?.status) && !operatorPriceExpired(record, now.getTime())))
    throw new Error("这条 RFQ 当前不能录入核实价格");
  if (!editableSubmission.has(record.submission?.status || "not_submitted")) throw new Error("已有浏览器报价动作，不能覆盖原记录");
  const quantity = Number(record.analysis.fields?.quantity || record.rfq.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("买家数量未能确认，请先核对原始 RFQ");
  const unitPriceUsd = priceNumber(input.unitPriceUsd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validThrough || "")) throw new Error("请填写有效期截止日期");
  const expiry = Date.parse(`${input.validThrough}T23:59:59.999Z`);
  const validityDays = Math.ceil((expiry - now.getTime()) / 86_400_000);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 10) !== input.validThrough ||
    validityDays < 1 || validityDays > 180) throw new Error("价格有效期须为今天起 180 天内");
  const sourceNote = String(input.sourceNote || "").trim();
  const specification = String(input.specification || "").trim();
  const risks = Array.isArray(record.analysis.riskFlags) ? record.analysis.riskFlags : [];
  const missing = Array.isArray(record.analysis.missingRequired) ? record.analysis.missingRequired : [];
  const resolutions = input.missingResolutions || [];
  if (!Array.isArray(resolutions) || resolutions.length !== missing.length ||
    !resolutions.every((entry, index) => entry && Object.keys(entry).sort().join(",") === "field,source,value" &&
      entry.field === missing[index] && ["buyer_confirmed", "supplier_proposal"].includes(entry.source) &&
      typeof entry.value === "string" && entry.value.trim().length >= 4 && entry.value.trim().length <= 120 &&
      !/[\u0000-\u001f\u007f]/.test(entry.value)))
    throw new Error("请逐项确认缺失规格，或写明本次报价采用的供应商方案");
  const reviewedSpecs = resolutions.map((entry) => ({ field: entry.field, source: entry.source, value: entry.value.trim() }));
  if (input.riskResolution != null && typeof input.riskResolution !== "string")
    throw new Error("风险处理说明格式无效");
  const riskResolution = String(input.riskResolution || "").trim();
  if (sourceNote.length < 15 || sourceNote.length > 500) throw new Error("请写明当前售价依据、来源和确认日期（15–500 字）");
  if (specification.length < 20 || specification.length > 1000) throw new Error("请写明该售价覆盖的商品规格与条件（20–1000 字）");
  if (riskResolution.length > 2000 || (risks.length && riskResolution.length < 30))
    throw new Error("请逐项说明原分析风险如何核实或处理（30–2000 字）");
  const approvedAt = now.toISOString();
  const quote = {
    status: "quoted", categoryId: record.analysis.categoryId, quantity, currency: "USD", tradeTerm: "EXW",
    unitPriceUsd, setupUsd: 0, totalUsd: roundUp(quantity * unitPriceUsd, 2),
    freightIncluded: false, taxIncluded: false, validityDays,
    rulesVersion: "operator-rfq-price-1", basis: specification,
    priceEvidence: { kind: "operator_verified_sell_price", sourceNote, approvedAt,
      validThrough: input.validThrough, rfqId: record.rfq.id },
    warning: "EXW selling price entered and approved by the operator for this exact RFQ; review buyer specifications before browser fill."
  };
  if (risks.length) quote.priceEvidence.riskReview = { flags: [...risks], note: riskResolution,
      reviewedAt: approvedAt, fingerprint: quoteRiskFingerprint({ ...record, quote }) };
  if (missing.length) {
    quote.priceEvidence.specReview = { entries: reviewedSpecs, reviewedAt: approvedAt,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify({
        quote: quoteRiskFingerprint({ ...record, quote }), entries: reviewedSpecs
      })).digest("hex") };
  }
  const draft = draftLocally(record.rfq, record.analysis, quote);
  draft.port = String(port || "").trim().slice(0, 120);
  const updated = { ...record, quote, draft, submission: { status: "not_submitted" },
    priceApproval: { approvedAt, previousQuote: record.quote, previousDraft: record.draft || null,
      originalHash: hash, source: "operator_verified_sell_price" } };
  if (!hasDefiniteQuote(updated, now.getTime())) throw new Error("报价草稿金额或内容无法核对");
  const revisions = path.join(directory, "revisions");
  fs.mkdirSync(revisions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(revisions, `${input.id}-${crypto.randomUUID()}.json`), original, { flag: "wx", mode: 0o600 });
  const temporary = path.join(directory, `.${input.id}-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, resolved); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  return { id: input.id, rfqId: record.rfq.id, quote: { status: quote.status, quantity, unitPriceUsd,
    totalUsd: quote.totalUsd, currency: quote.currency, tradeTerm: quote.tradeTerm,
    validThrough: input.validThrough }, approvedAt, browserAction: "none" };
}
