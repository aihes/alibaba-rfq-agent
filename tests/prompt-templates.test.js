import test from "node:test";
import assert from "node:assert/strict";
import { buildModelPrompt, renderPrompt } from "../src/prompt-templates.js";
import { buildClassificationRequest, buildDraftRequest, buildQuoteRationaleRequest } from "../src/claude.js";

test("prompt templates render declared placeholders and carry structured RFQ input", () => {
  const payload = { rfq: { title: "Kraft paper bag", quantity: 500 } };
  const result = buildModelPrompt("classification.system", { imageInstructions: "OCR 已读取" }, payload);
  assert.match(result.systemPrompt, /OCR 已读取/);
  assert.match(result.prompt, /Kraft paper bag/);
  assert.match(result.prompt, /"quantity":500/);
  assert.doesNotMatch(result.prompt, /\{\{[a-zA-Z]/);
});

test("prompt templates reject missing, extra and unknown placeholders", () => {
  assert.throws(() => renderPrompt("classification.system"), /Missing prompt placeholder/);
  assert.throws(() => renderPrompt("image-ocr", { extra: "no" }), /Unused prompt placeholder/);
  assert.throws(() => renderPrompt("outside", {}), /Unknown prompt template/);
});

test("HTTP model prompts never ask for the local Claude Read tool", () => {
  const request = buildClassificationRequest({ agentProvider: "openai-http", imageAnalysisMode: "agent-read", maxRfqImages: 1 },
    { title: "Paper bag", imagePaths: ["/tmp/rfq-image.png"], imageAssets: [] }, { paper_bag: { keywords: ["paper bag"] } });
  assert.deepEqual(request.agentImagePaths, []);
  assert.doesNotMatch(request.systemPrompt, /Use the Read tool/);
});

test("classification sees local price coverage without receiving sell prices", () => {
  const request = buildClassificationRequest({ agentProvider: "local-claude-sdk", maxRfqImages: 0,
    pricing: { rules: { tumbler_40oz: { requiredFields: ["quantity", "capacityOz", "material", "printing"],
      baseQty: 150, validatedScenario: "40oz 304 full-wrap", unitPriceUsd: 7.5, setupUsd: 170 } } } },
  { title: "40oz tumbler", imagePaths: [], imageAssets: [] }, { tumbler_40oz: { keywords: ["40oz"] } });
  assert.deepEqual(request.payload.pricingCoverage.tumbler_40oz.pricedQuantities, [150]);
  assert.deepEqual(request.payload.pricingCoverage.tumbler_40oz.requiredFields,
    ["quantity", "capacityOz", "material", "printing"]);
  assert.equal(JSON.stringify(request.payload).includes("unitPriceUsd"), false);
  assert.equal(JSON.stringify(request.payload).includes("setupUsd"), false);
  assert.match(request.systemPrompt, /Never copy a specification from pricingCoverage/);
  assert.match(request.systemPrompt, /price-availability status in riskFlags/);
});

test("packaged quote skill reaches classification, rationale and draft model requests", () => {
  const rfq = { title: "Paper bag", summary: "500 bags", imagePaths: [], imageAssets: [] };
  const analysis = { categoryId: "paper_shopping_bag", fields: { quantity: 500 } };
  const quote = { status: "needs_review", reason: "No approved price" };
  const requests = [
    buildClassificationRequest({ agentProvider: "local-claude-sdk", maxRfqImages: 0 }, rfq, { paper_shopping_bag: {} }),
    buildQuoteRationaleRequest({ pricing: { currency: "USD", rules: {} } }, rfq, analysis, quote),
    buildDraftRequest(rfq, analysis, quote)
  ];
  for (const request of requests) {
    assert.match(request.systemPrompt, /LOCAL_QUOTE_SKILL:/);
    assert.match(request.systemPrompt, /历史 PI 和客户报价单/);
    assert.match(request.prompt, /LOCAL_QUOTE_SKILL:/);
    assert.match(request.prompt, /Paper bag/);
  }
});
