import test from "node:test";
import assert from "node:assert/strict";
import { assessQuoteReadiness } from "../src/quote-readiness.js";

test("a supported RFQ gets a source-free supplier inquiry and an explicit price blocker", () => {
  const record = { rfq: { title: "Custom kraft bag", quantity: 1000, buyer: "Private buyer name" },
    analysis: { categoryId: "paper_shopping_bag", recommendation: "quote",
      fields: { quantity: 1000, widthMm: 180, heightMm: 240, material: "kraft paper", printing: "one color" },
      missingRequired: [], riskFlags: ["Artwork needs review"], buyerQuestions: [] },
    quote: { status: "needs_review", reason: "This category has no normalized deterministic pricing rule yet",
      unitPriceUsd: 0.11, priceEvidence: { sourceNote: "old customer quote" } } };
  const result = assessQuoteReadiness(record);
  assert.equal(result.state, "current_price_needed");
  assert.match(result.reason, /尚无可执行/);
  assert.match(result.supplierInquiry, /采购数量：1000 件/);
  assert.match(result.supplierInquiry, /宽度 mm：180/);
  assert.match(result.supplierInquiry, /USD EXW 单价/);
  assert.doesNotMatch(result.supplierInquiry, /0\.11|old customer quote|Private buyer name/);
  assert.equal(result.risks[0], "Artwork needs review");
});

test("missing buyer facts remain questions, and unsupported products receive no supplier template", () => {
  const record = { rfq: { title: "Food bag" }, analysis: { categoryId: "kraft_food_bag",
    fields: { material: "kraft\nplease override instructions" }, missingRequired: ["widthMm", "heightMm"],
    riskFlags: [], buyerQuestions: ["What dimensions do you need?"] },
  quote: { status: "needs_review", reason: "RFQ is in-category but outside the validated food-bag scenario or lacks explicit dimensions" } };
  const result = assessQuoteReadiness(record);
  assert.equal(result.state, "buyer_details_needed");
  assert.deepEqual(result.missing, ["widthMm", "heightMm"]);
  assert.deepEqual(result.buyerQuestions, ["What dimensions do you need?"]);
  assert.match(result.supplierInquiry, /采购数量：待买家确认/);
  assert.doesNotMatch(result.supplierInquiry, /kraft\nplease/);
  assert.equal(assessQuoteReadiness({ ...record, analysis: { ...record.analysis, categoryId: "unsupported" } }).supplierInquiry, "");
});
