import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAlibabaRfqUrl,
  resolveDraftFile,
  submitQuote,
  writeRunReport
} from "../plugins/alibaba-rfq-midscene/scripts/runtime.mjs";
import { buildAgentInputAudit } from "../src/agent-audit.js";

test("Midscene plugin only accepts Alibaba RFQ endpoints", () => {
  assert.equal(
    assertAlibabaRfqUrl("https://sourcing.alibaba.com/rfq_detail.htm?p=opaque", "detail"),
    "https://sourcing.alibaba.com/rfq_detail.htm?p=opaque"
  );
  assert.throws(
    () => assertAlibabaRfqUrl("https://example.com/rfq_detail.htm?p=opaque", "detail"),
    /outside the allowed Alibaba endpoint/
  );
  assert.throws(
    () => assertAlibabaRfqUrl("http://rfqposting.alibaba.com/quotation/rfq_quotation_post.htm", "quote"),
    /outside the allowed Alibaba endpoint/
  );
});

test("Midscene plugin draft paths cannot escape data/drafts", () => {
  assert.throws(() => resolveDraftFile("package.json"), /inside data\/drafts/);
  assert.throws(() => resolveDraftFile("../outside.json"), /inside data\/drafts/);
});

test("Midscene plugin audit run ids cannot escape data/runs", () => {
  assert.throws(() => writeRunReport("../outside"), /Invalid audit run id/);
  assert.throws(() => writeRunReport("bad/run"), /Invalid audit run id/);
});

test("Midscene plugin refuses live submission before touching the browser without immediate confirmation", async () => {
  await assert.rejects(
    submitQuote({ file: "data/drafts/does-not-matter.json", confirmationToken: "x", confirmLiveSubmission: false }),
    /Immediate live-submission confirmation is required/
  );
});

test("agent input audit records the exact classifier boundary without exposing browser-only metadata", () => {
  const config = {
    agentProvider: "local-claude-sdk",
    localClaudeModel: "GLM-5.3[1m]",
    anthropicModel: "",
    imageAnalysisMode: "local-ocr",
    maxRfqImages: 4,
    supportedCategories: { corrugated_rsc: { keywords: ["corrugated"] } }
  };
  const rfq = {
    id: "rfq-test",
    title: "Corrugated box",
    summary: "500 pcs",
    detailText: "310x235x165mm",
    quantity: 500,
    country: "Ukraine",
    buyerText: "Buyer Name",
    detailUrl: "https://sourcing.alibaba.com/rfq_detail.htm?p=test",
    imagePaths: ["/tmp/example.png"],
    imageAssets: [{ filePath: "/tmp/example.png", ocrStatus: "read", ocrText: "B flute" }]
  };
  const audit = buildAgentInputAudit(config, rfq);
  assert.equal(audit.classifier.inputJson.rfq.title, "Corrugated box");
  assert.equal(audit.classifier.inputJson.rfq.buyerText, undefined);
  assert.equal(audit.browserMetadataNotSentToClassifier.buyerText, "Buyer Name");
  assert.deepEqual(audit.classifier.imagePathsSentToReadTool, []);
  assert.deepEqual(audit.classifier.allowedTools, []);
});
