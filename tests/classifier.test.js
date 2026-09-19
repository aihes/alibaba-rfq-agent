import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentAnalysis } from "../src/classifier.js";

test("normalizes agent numbers and forces local OCR evidence to partial", () => {
  const config = {
    supportedCategories: { tumbler_40oz: { keywords: ["40oz"] } },
    imageAnalysisMode: "local-ocr",
    maxRfqImages: 4
  };
  const rfq = {
    imagePaths: ["/tmp/product.png"],
    imageAssets: [{ ocrStatus: "read", ocrText: "40oz, quantity 150" }]
  };
  const normalized = normalizeAgentAnalysis({
    categoryId: "tumbler_40oz",
    confidence: "0.91",
    fields: { quantity: "150", capacityOz: "40", material: "304 stainless steel", greaseproof: "yes" },
    missingRequired: [],
    riskFlags: [],
    buyerQuestions: [],
    recommendation: "quote",
    imageReadStatus: "read",
    imageEvidence: []
  }, rfq, config);
  assert.equal(normalized.fields.quantity, 150);
  assert.equal(normalized.fields.capacityOz, 40);
  assert.equal(normalized.fields.greaseproof, null);
  assert.equal(normalized.imageReadStatus, "partial");
});

test("rejects categories outside the configured contract", () => {
  const normalized = normalizeAgentAnalysis({
    categoryId: "injected_category",
    confidence: 2,
    fields: {},
    recommendation: "auto_submit"
  }, { imagePaths: [], imageAssets: [] }, {
    supportedCategories: {},
    imageAnalysisMode: "local-ocr",
    maxRfqImages: 4
  });
  assert.equal(normalized.categoryId, "unsupported");
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.recommendation, "review");
  assert.equal(normalized.imageReadStatus, "not_provided");
});
