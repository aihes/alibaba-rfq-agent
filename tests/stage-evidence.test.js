import test from "node:test";
import assert from "node:assert/strict";
import { stageEvidenceFromRecord } from "../src/stage-evidence.js";

test("old analysis stages use the saved model request and result, while search output stays qualified", () => {
  const record = { rfq: { id: "rfq-fixture", title: "Kraft bag", summary: "500 pieces", detailText: "Buyer asks for greaseproof bags" },
    analysis: { recommendation: "review", missingRequired: ["gsm"] }, quote: { status: "needs_review" },
    agentInput: { provider: "local-claude-sdk", requestedModel: "glm-fixture",
      classifier: { prompt: "classify this RFQ", inputJson: { rfq: { detailText: "Buyer asks for greaseproof bags" } } } } };
  const summary = { scanned: 60, newCandidates: 1, records: [{ id: "rfq-fixture", title: "Kraft bag", quoteStatus: "needs_review" }] };
  const analysis = stageEvidenceFromRecord({ stage: "analysis" }, summary, record);
  assert.equal(analysis.input.inputJson.rfq.detailText, "Buyer asks for greaseproof bags");
  assert.equal(analysis.output.analysis.recommendation, "review");
  const search = stageEvidenceFromRecord({ stage: "search", message: "正在搜索：bags" }, summary, record);
  assert.equal(search.input.search, "bags");
  assert.match(search.output.note, /未单独保存/);
  assert.equal(search.output.runScannedTotal, 60);
});
