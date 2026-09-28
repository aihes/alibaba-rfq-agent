#!/usr/bin/env node
/** Review one local draft before any browser quote action. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_CONTACT_ACK, evaluateAutoContact, loadContactState } from "../src/auto-contact.js";
import { loadConfig, projectDir } from "../src/config.js";
import { submissionToken } from "../src/form.js";
import { canArchiveDraft, readDraftArchive } from "../src/draft-archive.js";
import { buyerRfqUrl, quoteImages } from "../src/quote-images.js";
import { hasDefiniteQuote } from "../src/quote-visibility.js";
import { fillQuote, submitQuote } from "../plugins/alibaba-rfq-midscene/scripts/runtime.mjs";

const root = projectDir;
const draftsDir = path.join(root, "data/drafts");
const id = process.argv[3] || "";
const command = process.argv[2] || "list";

function loadDraft(draftId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draftId)) throw new Error("Invalid draft ID");
  const file = path.join(draftsDir, `${draftId}.json`);
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(`${fs.realpathSync(draftsDir)}${path.sep}`)) throw new Error("Draft is outside data/drafts");
  const bytes = fs.readFileSync(resolved);
  return { file: resolved, record: JSON.parse(bytes.toString("utf8")), hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function review(draftId) {
  const { file, record, hash } = loadDraft(draftId);
  const stat = fs.statSync(file);
  const rfq = record.rfq || {};
  const quote = record.quote || {};
  const draft = record.draft || {};
  const submission = record.submission || {};
  const config = loadConfig();
  const base = { ...config, autoContactMode: "fill", autoContactCategories: [record.analysis?.categoryId].filter(Boolean),
    quotePort: draft.port || "", autoContactAllowFixtureUrls: false };
  const contactState = loadContactState();
  const fillPolicy = evaluateAutoContact(base, record, contactState);
  const fillReasons = [...fillPolicy.reasons];
  if (!draft.port) fillReasons.push("草稿缺少逐单核实的交货地点");
  if (!draft.productName || !draft.productDetails) fillReasons.push("草稿商品名称或规格描述不完整");
  if (quote.currency !== "USD") fillReasons.push("当前浏览器报价仅支持美元报价");
  if (!Number.isFinite(quote.quantity) || !Number.isFinite(quote.unitPriceUsd) || !Number.isFinite(quote.totalUsd) ||
      Math.abs(quote.quantity * quote.unitPriceUsd + Number(quote.setupUsd || 0) - quote.totalUsd) > 0.011) {
    fillReasons.push("报价数量、单价与总价无法核对");
  }
  if (Number(quote.setupUsd || 0) !== 0) fillReasons.push("报价含一次性费用，当前浏览器表单无法单独表示");
  if (["submitted", "attempting", "needs_manual_review"].includes(submission.status)) fillReasons.push(`已有报价动作状态：${submission.status}`);
  const expectedScreenshot = path.join(draftsDir, `${rfq.id}-filled.png`);
  const filled = submission.status === "filled_not_submitted" &&
    submission.filledValues?.quantity === String(quote.quantity) &&
    submission.filledValues?.unitPrice === String(quote.unitPriceUsd) &&
    submission.filledValues?.buyerMessage === draft.buyerMessage &&
    submission.filledValues?.port === draft.port &&
    submission.filledValues?.productName === draft.productName &&
    submission.filledValues?.tradeTerm === quote.tradeTerm &&
    submission.screenshotPath === expectedScreenshot && fs.existsSync(expectedScreenshot);
  const submitPolicy = evaluateAutoContact({ ...base, autoContactMode: "submit", allowLiveSubmit: true,
    autoContactAck: AUTO_CONTACT_ACK }, record, contactState);
  const submitReasons = [...submitPolicy.reasons, ...fillReasons.filter((reason) => !fillPolicy.reasons.includes(reason))];
  if (!filled) submitReasons.push("须先回填，并核对浏览器字段及截图");
  return {
    id: draftId, reviewHash: hash,
    createdAt: Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(), submittedAt: submission.completedAt || record.timing?.submissionCompletedAt || null,
    // 若草稿后来被 CLI 或旧版工作台回填/提交，旧整理标记不能隐藏新证据。
    archivedAt: canArchiveDraft(submission.status) ? readDraftArchive(root)[draftId]?.archivedAt || null : null,
    rfq: { id: rfq.id || "", title: rfq.title || "", buyer: rfq.country || "", buyerText: rfq.buyerText || "",
      detailUrl: buyerRfqUrl(rfq.detailUrl),
      summary: rfq.summary || "", detailText: rfq.detailText || "", publishedText: rfq.publishedText || "",
      searchTerm: rfq.searchTerm || "", collectedAt: rfq.collectedAt || null,
      quantityText: rfq.quantityText || "", remainingQuotes: rfq.remainingQuotes },
    analysis: { categoryId: record.analysis?.categoryId || "", confidence: record.analysis?.confidence ?? null,
      recommendation: record.analysis?.recommendation || "", fields: record.analysis?.fields || {},
      missingRequired: record.analysis?.missingRequired || [], riskFlags: record.analysis?.riskFlags || [],
      buyerQuestions: record.analysis?.buyerQuestions || [], imageReadStatus: record.analysis?.imageReadStatus || "" },
    quote: { status: quote.status || "unknown", reason: quote.reason || "", categoryId: record.analysis?.categoryId || "",
      quantity: quote.quantity, unitPriceUsd: quote.unitPriceUsd, setupUsd: quote.setupUsd, totalUsd: quote.totalUsd,
      currency: quote.currency, tradeTerm: quote.tradeTerm, validityDays: quote.validityDays,
      basis: quote.basis || "", missingFields: quote.missingFields || [] },
    images: quoteImages(root, record),
    hasDraft: Boolean(record.draft),
    draft: { productName: draft.productName || "", productDetails: draft.productDetails || "",
      port: draft.port || "", buyerMessage: draft.buyerMessage || "" },
    submission: { status: submission.status || "未操作", filledValues: submission.filledValues || null },
    fillEligible: fillReasons.length === 0, fillReasons, submitEligible: submitReasons.length === 0,
    submitReasons, screenshotAvailable: filled, fileName: path.basename(file)
  };
}

if (command === "list") {
  const archived = readDraftArchive(root);
  const rows = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((name) => name.endsWith(".json")).map((name) => {
    try {
      const { record } = loadDraft(name.slice(0, -5));
      if (!record.rfq?.id || !record.quote) return null;
      const stat = fs.statSync(path.join(draftsDir, name));
      const createdAt = Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : stat.birthtime.toISOString();
      return { id: name.slice(0, -5), rfqId: record.rfq.id, title: record.rfq.title || "未命名 RFQ",
        quoteStatus: record.quote.status || "unknown", submissionStatus: record.submission?.status || "未操作",
        reason: record.quote.reason || "", categoryId: record.analysis?.categoryId || record.quote.categoryId || "未分类",
        summary: record.rfq.summary || "", searchTerm: record.rfq.searchTerm || "", country: record.rfq.country || "",
        searchText: [record.rfq.title, record.rfq.summary, record.rfq.detailText, record.draft?.buyerMessage,
          record.rfq.id].filter(Boolean).join("\n").slice(0, 16000),
        hasDraft: Boolean(record.draft), definiteQuote: hasDefiniteQuote(record), createdAt, updatedAt: stat.mtime.toISOString(),
        submittedAt: record.submission?.completedAt || record.timing?.submissionCompletedAt || null,
        quantity: record.quote.quantity ?? null, unitPriceUsd: record.quote.unitPriceUsd ?? null,
        totalUsd: record.quote.totalUsd ?? null, currency: record.quote.currency || null,
        archivedAt: canArchiveDraft(record.submission?.status) ? archived[name.slice(0, -5)]?.archivedAt || null : null };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
  const active = rows.filter((row) => !row.archivedAt);
  console.log(JSON.stringify({ drafts: rows, counts: { total: active.length, archived: rows.length - active.length,
    quoted: active.filter((row) => row.quoteStatus === "quoted").length,
    submitted: active.filter((row) => row.submissionStatus === "submitted").length } }));
} else if (command === "review") {
  console.log(JSON.stringify(review(id)));
} else if (command === "fill" || command === "submit") {
  const reviewed = review(id);
  const hash = process.argv[4] || "";
  const confirmation = process.argv[5] || "";
  if (hash !== reviewed.reviewHash) throw new Error("Draft changed after review; reload the quote details");
  if (confirmation !== reviewed.rfq.id) throw new Error("Confirm the exact RFQ ID shown in the review");
  if (command === "fill" && !reviewed.fillEligible) throw new Error(`Draft is not fill-eligible: ${reviewed.fillReasons.join("; ")}`);
  if (command === "submit" && !reviewed.submitEligible) throw new Error(`Draft is not submit-eligible: ${reviewed.submitReasons.join("; ")}`);
  const file = path.join(draftsDir, `${id}.json`);
  const result = command === "fill" ? await fillQuote({ file }) : await submitQuote({
    file, confirmationToken: submissionToken(loadDraft(id).record), confirmLiveSubmission: true
  });
  console.log(JSON.stringify(result));
} else {
  throw new Error("Unknown quote-console command");
}
