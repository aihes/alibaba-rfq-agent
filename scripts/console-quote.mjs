#!/usr/bin/env node
/** Review one local draft before any browser quote action. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_CONTACT_ACK, evaluateAutoContact, loadContactState } from "../src/auto-contact.js";
import { loadConfig } from "../src/config.js";
import { submissionToken } from "../src/form.js";
import { fillQuote, submitQuote } from "../plugins/alibaba-rfq-midscene/scripts/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    id: draftId, reviewHash: hash, rfq: { id: rfq.id || "", title: rfq.title || "", buyer: rfq.country || "",
      quantityText: rfq.quantityText || "", remainingQuotes: rfq.remainingQuotes },
    quote: { status: quote.status || "unknown", reason: quote.reason || "", categoryId: record.analysis?.categoryId || "",
      quantity: quote.quantity, unitPriceUsd: quote.unitPriceUsd, setupUsd: quote.setupUsd, totalUsd: quote.totalUsd,
      currency: quote.currency, tradeTerm: quote.tradeTerm, validityDays: quote.validityDays },
    draft: { productName: draft.productName || "", productDetails: draft.productDetails || "",
      port: draft.port || "", buyerMessage: draft.buyerMessage || "" },
    submission: { status: submission.status || "未操作", filledValues: submission.filledValues || null },
    fillEligible: fillReasons.length === 0, fillReasons, submitEligible: submitReasons.length === 0,
    submitReasons, screenshotAvailable: filled, fileName: path.basename(file)
  };
}

if (command === "list") {
  const rows = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((name) => name.endsWith(".json")).map((name) => {
    try {
      const { record } = loadDraft(name.slice(0, -5));
      if (!record.rfq?.id || !record.quote) return null;
      return { id: name.slice(0, -5), rfqId: record.rfq.id, title: record.rfq.title || "未命名 RFQ",
        quoteStatus: record.quote.status || "unknown", submissionStatus: record.submission?.status || "未操作",
        reason: record.quote.reason || "", updatedAt: fs.statSync(path.join(draftsDir, name)).mtime.toISOString() };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
  console.log(JSON.stringify({ drafts: rows, counts: { total: rows.length, quoted: rows.filter((row) => row.quoteStatus === "quoted").length } }));
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
