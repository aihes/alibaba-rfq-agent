import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceRfq } from "../src/pricing.js";
import { assertSubmitAllowed, submissionToken } from "../src/form.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pricing = JSON.parse(fs.readFileSync(path.join(root, "config/pricing-rules.json"), "utf8"));

test("prices validated kraft food bag scenario", () => {
  const rfq = { quantity: 25000 };
  const analysis = { categoryId: "kraft_food_bag", fields: { quantity: 25000, widthMm: 110, heightMm: 110, bottomMm: 50, gsm: 80, material: "kraft paper", greaseproof: true } };
  const quote = priceRfq(rfq, analysis, pricing);
  assert.equal(quote.status, "quoted");
  assert.equal(quote.unitPriceUsd, 0.019);
  assert.equal(quote.totalUsd, 545);
});

test("prices validated 40oz tumbler scenario", () => {
  const rfq = { quantity: 150 };
  const analysis = { categoryId: "tumbler_40oz", fields: { quantity: 150, capacityOz: 40, material: "304 stainless steel", printing: "360 full wrap" } };
  const quote = priceRfq(rfq, analysis, pricing);
  assert.equal(quote.status, "quoted");
  assert.equal(quote.totalUsd, 1295);
});

test("keeps 500-piece corrugated offer conditional and recommends model MOQ separately", () => {
  const rfq = { quantity: 500 };
  const analysis = { categoryId: "corrugated_rsc", fields: { quantity: 500, lengthMm: 310, widthMm: 235, heightMm: 165, flute: "B", printing: "none" } };
  const quote = priceRfq(rfq, analysis, pricing);
  assert.equal(quote.status, "conditional_quote");
  assert.equal(quote.unitPriceUsd, 0.99);
  assert.equal(quote.totalUsd, 495);
});

test("does not invent a price for an incomplete specification", () => {
  const quote = priceRfq({ quantity: 20000 }, { categoryId: "kraft_food_bag", fields: { quantity: 20000, material: "kraft paper" } }, pricing);
  assert.equal(quote.status, "needs_review");
});

test("does not reuse a validated bulk price at a different quantity", () => {
  const rfq = { quantity: 10000 };
  const analysis = { categoryId: "kraft_food_bag", fields: { quantity: 10000, widthMm: 110, heightMm: 110, bottomMm: 50, gsm: 80, material: "kraft paper", greaseproof: true } };
  const quote = priceRfq(rfq, analysis, pricing);
  assert.equal(quote.status, "needs_review");
  assert.match(quote.reason, /25000/);
});

test("live submission requires both environment enablement and exact per-RFQ token", () => {
  const record = { rfq: { id: "rfq-1" }, quote: { unitPriceUsd: 7.5 } };
  assert.equal(submissionToken(record), "rfq-1:7.5:SUBMIT");
  assert.throws(() => assertSubmitAllowed({ allowLiveSubmit: false }, record, submissionToken(record)), /disabled/);
  assert.throws(() => assertSubmitAllowed({ allowLiveSubmit: true }, record, "wrong"), /Exact confirmation/);
  assert.doesNotThrow(() => assertSubmitAllowed({ allowLiveSubmit: true }, record, submissionToken(record)));
});
