import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approveRfqPrice } from "../src/price-approval.js";
import { hasDefiniteQuote, operatorMissingReviewed, operatorRisksReviewed } from "../src/quote-visibility.js";
import { evaluateAutoContact } from "../src/auto-contact.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-price-approval-"));
  const directory = path.join(root, "data/drafts");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "draft-1.json");
  const record = { rfq: { id: "rfq-1", title: "Custom kraft bag", quantity: 1000 },
    analysis: { categoryId: "paper_shopping_bag", fields: { quantity: 1000 },
      recommendation: "review", missingRequired: ["gsm"], riskFlags: ["Artwork is unknown"], buyerQuestions: ["What GSM do you need?"] },
    quote: { status: "needs_review", reason: "No current approved price" }, submission: { status: "skipped" } };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return { root, file, record };
}
function request(file) {
  const validThrough = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return { id: "draft-1", rfqId: "rfq-1", reviewHash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    unitPriceUsd: 0.2275, validThrough, sourceNote: "Supplier quotation SP-28 confirmed on 2026-09-29",
    specification: "Kraft paper shopping bag, 1000 pieces, buyer dimensions and artwork to be confirmed; EXW.",
    riskResolution: "Buyer artwork will be confirmed before production; the approved price includes one-color printing.",
    missingResolutions: [{ field: "gsm", source: "supplier_proposal", value: "120 gsm kraft paper" }],
    approved: true };
}

test("verified current sell price produces a local draft with traceable evidence and archived original", () => {
  const { root, file } = setup();
  try {
    const input = request(file);
    const result = approveRfqPrice(root, input);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(result.browserAction, "none");
    assert.equal(record.quote.status, "quoted");
    assert.equal(record.quote.totalUsd, 227.5);
    assert.equal(record.quote.unitPriceUsd, 0.2275);
    assert.equal(record.quote.priceEvidence.kind, "operator_verified_sell_price");
    assert.equal(record.quote.priceEvidence.validThrough, input.validThrough);
    assert.deepEqual(record.quote.priceEvidence.riskReview.flags, ["Artwork is unknown"]);
    assert.equal(record.quote.priceEvidence.riskReview.note, input.riskResolution);
    assert.equal(operatorRisksReviewed(record), true);
    assert.equal(operatorMissingReviewed(record), true);
    assert.equal(record.submission.status, "not_submitted");
    assert.equal(hasDefiniteQuote(record), true);
    assert.match(record.draft.buyerMessage, /0\.2275/);
    assert.match(record.draft.buyerMessage, /120 gsm kraft paper/);
    assert.match(record.draft.buyerMessage, /subject to your acceptance/);
    assert.match(record.draft.buyerMessage, new RegExp(input.validThrough));
    assert.doesNotMatch(record.draft.buyerMessage, /Supplier quotation SP-28/);
    assert.equal(fs.readdirSync(path.join(root, "data/drafts/revisions")).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "data/drafts/revisions", fs.readdirSync(path.join(root, "data/drafts/revisions"))[0]))).quote.status, "needs_review");
    assert.throws(() => approveRfqPrice(root, input), /草稿已变化/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("price approval requires exact RFQ, supported review state and a current evidenced price", () => {
  const { root, file } = setup();
  try {
    const input = request(file);
    for (const [patch, error] of [
      [{ rfqId: "wrong" }, /RFQ ID/], [{ unitPriceUsd: 0 }, /美元单价/],
      [{ unitPriceUsd: 0.12345 }, /四位小数/], [{ sourceNote: "old PI" }, /当前售价依据/],
      [{ specification: "bag" }, /商品规格与条件/], [{ approved: false }, /逐项核对/],
      [{ riskResolution: "" }, /逐项说明原分析风险/],
      [{ missingResolutions: [] }, /逐项确认缺失规格/],
      [{ missingResolutions: [{ field: "gsm", source: "supplier_proposal", value: "" }] }, /逐项确认缺失规格/],
      [{ validThrough: "2020-01-01" }, /价格有效期/]
    ]) assert.throws(() => approveRfqPrice(root, { ...input, ...patch }), error);
    assert.equal(fs.readFileSync(file, "utf8").includes('"status":"needs_review"'), true);
    assert.equal(fs.existsSync(path.join(root, "data/drafts/revisions")), false);
    const submitted = JSON.parse(fs.readFileSync(file, "utf8"));
    submitted.submission.status = "submitted";
    fs.writeFileSync(file, JSON.stringify(submitted));
    assert.throws(() => approveRfqPrice(root, request(file)), /浏览器报价动作/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an expired operator price can be renewed, while it is hidden from definite quotes", () => {
  const { root, file } = setup();
  try {
    approveRfqPrice(root, { ...request(file), validThrough: "2026-09-02" },
      { now: new Date("2026-09-01T09:00:00Z") });
    const expired = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(hasDefiniteQuote(expired), false);
    assert.equal(hasDefiniteQuote({ ...expired, submission: { status: "submitted" } }), true);
    const renewed = approveRfqPrice(root, { ...request(file), unitPriceUsd: 0.245 });
    assert.equal(renewed.quote.totalUsd, 245);
    assert.equal(hasDefiniteQuote(JSON.parse(fs.readFileSync(file, "utf8"))), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a priced and reviewed RFQ is fillable only in its manually started flow", () => {
  const { root, file } = setup();
  try {
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    original.rfq.quoteUrl = "https://sourcing.alibaba.com/rfq_detail.htm?id=rfq-1";
    original.rfq.remainingQuotes = 2;
    original.analysis.recommendation = "quote";
    original.analysis.confidence = 0.85;
    fs.writeFileSync(file, JSON.stringify(original));
    approveRfqPrice(root, request(file), { port: "Hangzhou" });
    const priced = JSON.parse(fs.readFileSync(file, "utf8"));
    const config = { autoContactMode: "fill", autoContactCategories: ["paper_shopping_bag"],
      autoContactMinConfidence: 0.92, autoContactMaxTotalUsd: 2500,
      autoContactDailyLimit: 3, quotePort: "Hangzhou" };
    assert.equal(evaluateAutoContact(config, priced).eligible, false);
    assert.ok(evaluateAutoContact(config, priced).reasons.includes("Risk flags require human review"));
    assert.ok(evaluateAutoContact(config, priced).reasons.includes("Required fields are missing"));
    assert.equal(evaluateAutoContact({ ...config, manualOperatorQuote: true }, priced).eligible, true);
    priced.quote.priceEvidence.specReview.entries[0].value = "80 gsm kraft paper";
    assert.equal(hasDefiniteQuote(priced), false);
    assert.ok(evaluateAutoContact({ ...config, manualOperatorQuote: true }, priced).reasons.includes("Required fields are missing"));
    const withoutProposal = JSON.parse(fs.readFileSync(file, "utf8"));
    withoutProposal.draft.buyerMessage = withoutProposal.draft.buyerMessage.replace("120 gsm kraft paper", "");
    assert.equal(hasDefiniteQuote(withoutProposal), false);
    assert.ok(evaluateAutoContact({ ...config, manualOperatorQuote: true }, withoutProposal).reasons.includes("Required fields are missing"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
