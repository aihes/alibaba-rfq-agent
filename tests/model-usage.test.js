import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordModelUsage, summarizeModelUsage } from "../src/model-usage.js";

test("usage ledger counts model and OCR requests without saving prompts or credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-usage-"));
  const progressFile = path.join(directory, "run.progress.json");
  const before = process.env.RFQ_PROGRESS_FILE;
  process.env.RFQ_PROGRESS_FILE = progressFile;
  try {
    assert.equal(summarizeModelUsage(progressFile).recorded, false);
    fs.writeFileSync(`${progressFile}.usage.jsonl`, "");
    assert.deepEqual(summarizeModelUsage(progressFile), { recorded: true, attempts: 0,
      modelAttempts: 0, ocrAttempts: 0, inputTokens: 0, outputTokens: 0,
      reportedCostUsd: 0, unpriced: 0 });
    recordModelUsage({ provider: "local-claude-sdk", model: "claude", phase: "classification",
      status: "success", usage: { input_tokens: 120, output_tokens: 30 }, reportedCostUsd: 0.02,
      prompt: "buyer secret", apiKey: "private" });
    recordModelUsage({ provider: "glm-ocr", model: "glm-ocr", phase: "ocr", status: "failed" });
    assert.deepEqual(summarizeModelUsage(progressFile), { recorded: true, attempts: 2, modelAttempts: 1, ocrAttempts: 1,
      inputTokens: 120, outputTokens: 30, reportedCostUsd: 0.02, unpriced: 1 });
    const saved = fs.readFileSync(`${progressFile}.usage.jsonl`, "utf8");
    assert.doesNotMatch(saved, /buyer secret|private/);
  } finally {
    if (before === undefined) delete process.env.RFQ_PROGRESS_FILE;
    else process.env.RFQ_PROGRESS_FILE = before;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
