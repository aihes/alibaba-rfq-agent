import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGeneratedDraft } from "../src/drafter.js";

test("forces verified operational fields even when the agent invents them", () => {
  const quote = { tradeTerm: "EXW", quantity: 150, unitPriceUsd: 7.5, validityDays: 7 };
  const generated = {
    productName: "40oz Tumbler",
    productDetails: "EXW USD 7.50 per piece for 150 pieces.",
    buyerMessage: "Our EXW price is USD 7.50 for 150 pieces.",
    port: "Invented Port",
    validityDays: 30,
    sampleAvailable: true
  };
  const result = normalizeGeneratedDraft(generated, {}, { quotePort: "Verified Factory City" }, quote);
  assert.equal(result.port, "Verified Factory City");
  assert.equal(result.validityDays, 7);
  assert.equal(result.sampleAvailable, false);
});

test("falls back when generated wording does not preserve the deterministic price", () => {
  const quote = { tradeTerm: "EXW", quantity: 150, unitPriceUsd: 7.5, validityDays: 7 };
  const fallback = { productName: "Safe local draft", productDetails: "safe", buyerMessage: "safe" };
  const result = normalizeGeneratedDraft({
    productName: "Wrong",
    productDetails: "FOB USD 6.00",
    buyerMessage: "100 pieces",
    sampleAvailable: true
  }, fallback, { quotePort: "" }, quote);
  assert.equal(result.productName, "Safe local draft");
  assert.equal(result.sampleAvailable, false);
});
