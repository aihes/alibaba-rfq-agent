import fs from "node:fs";
import path from "node:path";
import { explainQuoteWithClaude } from "../src/claude.js";
import { loadConfig, projectDir } from "../src/config.js";

const caseFiles = [
  ["Case 1", "data/drafts/rfq-c063adcab4640c7b6dc08cad-midscene.json"],
  ["Case 2", "data/drafts/rfq-13d3a098d4b523d4f60fb003.json"],
  ["Case 3", "data/drafts/rfq-da701a6112740f3a9cea4d7d.json"]
];

const outputPath = path.join(
  projectDir,
  "data/runs/20260918T145100Z-corrugated-carton-box/AGENT_QUOTE_RATIONALES.json"
);
const config = loadConfig();

if (config.agentProvider !== "local-claude-sdk") {
  throw new Error(`This audit run requires local-claude-sdk, received ${config.agentProvider}`);
}

const manifest = {
  title: "Alibaba RFQ Agent Quote Rationales",
  generatedAt: new Date().toISOString(),
  provenance: {
    provider: config.agentProvider,
    requestedModel: config.localClaudeModel || "inherit-local-default",
    purpose: "Auditable decision rationale; not hidden chain-of-thought",
    pricingAuthority: "deterministicQuote and config/pricing-rules.json"
  },
  cases: []
};

for (const [label, relativePath] of caseFiles) {
  const sourcePath = path.join(projectDir, relativePath);
  const record = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const startedAt = new Date().toISOString();
  const result = await explainQuoteWithClaude(config, record.rfq, record.analysis, record.quote);
  const item = {
    label,
    rfqId: record.rfq.id,
    sourcePath: relativePath,
    startedAt,
    completedAt: new Date().toISOString(),
    exactInput: {
      prompt: result.request.prompt,
      inputJson: result.request.payload,
      maxTurns: result.request.maxTurns,
      allowedTools: [],
      imagePixelsSent: false
    },
    agent: result.agent,
    output: result.output
  };
  manifest.cases.push(item);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ label, rfqId: item.rfqId, agent: item.agent, decision: item.output.decision }));
}

console.log(JSON.stringify({ outputPath, cases: manifest.cases.length }, null, 2));
