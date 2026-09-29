import crypto from "node:crypto";

/**
 * 工作台只展示确实有报价内容的草稿。needs_review 没有可核实价格；
 * conditional_quote 的金额依赖未确认条件，也不能当作明确报价。
 * 这里仅决定列表可见性，不授予浏览器回填或提交权限。
 */
export function operatorPriceExpired(record, now = Date.now()) {
  const evidence = record?.quote?.priceEvidence;
  if (evidence?.kind !== "operator_verified_sell_price") return false;
  const expiry = Date.parse(`${evidence.validThrough}T23:59:59.999Z`);
  return evidence.rfqId !== record.rfq?.id || !Number.isFinite(expiry) || expiry < now;
}

/** The price approver can document how each model risk was handled for one
 * RFQ. The snapshot must still match the current analysis and exact price
 * approval; a later scan or edited draft cannot inherit this review. */
export function quoteRiskFingerprint(record) {
  const { rfq = {}, analysis = {}, quote = {} } = record || {};
  const reviewed = {
    rfq: { id: rfq.id, title: rfq.title, summary: rfq.summary, detailText: rfq.detailText,
      quantity: rfq.quantity, quoteUrl: rfq.quoteUrl },
    analysis: { categoryId: analysis.categoryId, confidence: analysis.confidence,
      recommendation: analysis.recommendation, fields: analysis.fields,
      missingRequired: analysis.missingRequired, riskFlags: analysis.riskFlags },
    quote: { categoryId: quote.categoryId, quantity: quote.quantity, unitPriceUsd: quote.unitPriceUsd,
      setupUsd: quote.setupUsd, totalUsd: quote.totalUsd, currency: quote.currency,
      tradeTerm: quote.tradeTerm, basis: quote.basis,
      validThrough: quote.priceEvidence?.validThrough }
  };
  return crypto.createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}

export function operatorRisksReviewed(record) {
  const risks = record?.analysis?.riskFlags;
  if (!Array.isArray(risks) || !risks.length) return false;
  const evidence = record?.quote?.priceEvidence;
  const review = evidence?.riskReview;
  return evidence?.kind === "operator_verified_sell_price"
    && evidence.rfqId === record?.rfq?.id
    && review?.reviewedAt === evidence.approvedAt
    && typeof review.note === "string" && review.note.trim().length >= 30
    && Array.isArray(review.flags) && JSON.stringify(review.flags) === JSON.stringify(risks)
    && review.fingerprint === quoteRiskFingerprint(record);
}

/** A missing buyer field may be resolved by a buyer confirmation or by a
 * clearly stated supplier proposal for this exact offer. This is a human
 * decision, never a model-filled default. Bind each decision to the RFQ,
 * analysis and price revision so later changes invalidate the review. */
export function operatorMissingReviewed(record) {
  const missing = record?.analysis?.missingRequired;
  if (!Array.isArray(missing) || !missing.length) return false;
  const evidence = record?.quote?.priceEvidence;
  const review = evidence?.specReview;
  if (evidence?.kind !== "operator_verified_sell_price" || evidence.rfqId !== record?.rfq?.id ||
    review?.reviewedAt !== evidence.approvedAt || !Array.isArray(review.entries) ||
    review.entries.length !== missing.length) return false;
  if (!review.entries.every((entry, index) => entry.field === missing[index] &&
    ["buyer_confirmed", "supplier_proposal"].includes(entry.source) &&
    typeof entry.value === "string" && entry.value.trim().length >= 4 && entry.value.length <= 120)) return false;
  const message = record?.draft?.buyerMessage || "";
  if (!review.entries.every((entry) => message.includes(`${entry.field}: ${entry.value}`)) ||
    (review.entries.some((entry) => entry.source === "supplier_proposal") &&
      !message.includes("subject to your acceptance"))) return false;
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ quote: quoteRiskFingerprint(record), entries: review.entries })).digest("hex");
  return review.fingerprint === fingerprint;
}

export function hasDefiniteQuote(record, now = Date.now()) {
  const quote = record?.quote;
  const draft = record?.draft;
  if (quote?.status !== "quoted" || quote.currency !== "USD" || !draft) return false;
  // An expired offer must leave the actionable draft list, while a previously
  // submitted offer stays visible as a dated historical record.
  if (operatorPriceExpired(record, now) && record.submission?.status !== "submitted") return false;
  if ((record?.analysis?.missingRequired || []).length && !operatorMissingReviewed(record)) return false;
  const { quantity, unitPriceUsd, totalUsd } = quote;
  const setupUsd = quote.setupUsd ?? 0;
  if (![quantity, unitPriceUsd, totalUsd, setupUsd].every(Number.isFinite)
    || quantity <= 0 || unitPriceUsd <= 0 || totalUsd <= 0 || setupUsd < 0
    || Math.abs(quantity * unitPriceUsd + setupUsd - totalUsd) > 0.011) return false;
  return [quote.tradeTerm, draft.productName, draft.productDetails, draft.buyerMessage]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}
