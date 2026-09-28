import test from "node:test";
import assert from "node:assert/strict";
import { buildModelPrompt, renderPrompt } from "../src/prompt-templates.js";
import { buildClassificationRequest } from "../src/claude.js";

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
