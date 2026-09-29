import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reanalyzeDraft } from "../src/reanalyze-draft.js";

const config = {
  useClaude: true, useClaudeDraft: false, agentProvider: "local-claude-sdk",
  localClaudeModel: "test-model", imageAnalysisMode: "local-ocr", maxRfqImages: 4,
  supportedCategories: { paper_shopping_bag: { keywords: ["paper bag"] } },
  pricing: { rules: {}, currency: "USD", tradeTerm: "EXW", rulesVersion: "test" }
};
const analyzed = {
  categoryId: "paper_shopping_bag", confidence: 0.96,
  fields: { quantity: 1000, widthMm: null, heightMm: null, bottomMm: null,
    gsm: null, material: "kraft paper", printing: null },
  missingRequired: [], riskFlags: [], buyerQuestions: ["Please confirm paper weight"],
  recommendation: "quote", imageReadStatus: "not_provided", imageEvidence: []
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-reanalyze-"));
  const directory = path.join(root, "data/drafts");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "test-rfq.json");
  const record = { createdAt: "2026-09-20T00:00:00Z",
    rfq: { id: "test-rfq", title: "Kraft paper bag", summary: "1000 bags", detailText: "1000 kraft paper bags", quantity: 1000 },
    analysis: { ...analyzed, recommendation: "review", missingRequired: ["gsm"] },
    quote: { status: "needs_review", reason: "No current price" }, draft: null,
    submission: { status: "skipped" }, notification: { status: "sent" } };
  fs.writeFileSync(file, JSON.stringify(record));
  const bytes = fs.readFileSync(file);
  return { root, file, record, bytes, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

test("reanalysis updates only an untouched RFQ and archives its original evidence", async () => {
  const { root, file, bytes, hash } = fixture();
  try {
    const result = await reanalyzeDraft(root, "test-rfq", hash, config, {
      classify: async () => analyzed, makeDraft: async () => null,
      now: () => new Date("2026-09-29T09:00:00Z")
    });
    assert.equal(result.browserAction, "none");
    assert.equal(result.recommendation, "quote");
    const updated = JSON.parse(fs.readFileSync(file));
    assert.equal(updated.analysis.recommendation, "quote");
    assert.equal(updated.quote.status, "needs_review");
    assert.equal(updated.quote.unitPriceUsd, undefined);
    assert.equal(updated.submission.status, "skipped");
    assert.equal(updated.notification, null);
    assert.equal(updated.createdAt, "2026-09-20T00:00:00Z");
    assert.equal(updated.reanalysis.previousHash, hash);
    const revisions = fs.readdirSync(path.join(root, "data/drafts/revisions"));
    assert.equal(revisions.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, "data/drafts/revisions", revisions[0])), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed, stale, or priced reanalysis leaves the original draft intact", async () => {
  const { root, file, bytes, hash } = fixture();
  try {
    await assert.rejects(reanalyzeDraft(root, "test-rfq", hash, config, {
      classify: async () => { throw new Error("model unavailable"); }
    }), /model unavailable/);
    await assert.rejects(reanalyzeDraft(root, "test-rfq", hash, config, {
      classify: async () => ({ categoryId: "unknown", recommendation: "quote", fields: {} })
    }), /模型未返回完整/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    await assert.rejects(reanalyzeDraft(root, "test-rfq", "0".repeat(64), config, {
      classify: async () => analyzed
    }), /草稿已变化/);
    await assert.rejects(reanalyzeDraft(root, "test-rfq", hash, config, {
      classify: async () => { fs.writeFileSync(file, `${bytes.toString("utf8")}\n`); return analyzed; },
      makeDraft: async () => null
    }), /草稿已变化/);
    fs.writeFileSync(file, bytes);
    for (const change of [
      (record) => { record.quote.priceEvidence = { kind: "operator_verified_sell_price" }; },
      (record) => { record.submission.status = "filled_not_submitted"; },
      (record) => { record.quote.status = "quoted"; }
    ]) {
      const record = JSON.parse(bytes);
      change(record);
      const changed = Buffer.from(JSON.stringify(record));
      fs.writeFileSync(file, changed);
      const changedHash = crypto.createHash("sha256").update(changed).digest("hex");
      await assert.rejects(reanalyzeDraft(root, "test-rfq", changedHash, config, {
        classify: async () => analyzed
      }), /不能覆盖分析/);
      assert.deepEqual(fs.readFileSync(file), changed);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
