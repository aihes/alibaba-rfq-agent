import { buildClassificationRequest, buildDraftRequest } from "./claude.js";

const disallowedTools = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"
];

export function buildAgentInputAudit(config, rfq, analysis = null, quote = null, draft = null) {
  const classification = buildClassificationRequest(config, rfq, config.supportedCategories);
  const audit = {
    auditVersion: 1,
    reconstruction: false,
    provider: config.agentProvider,
    requestedModel: config.localClaudeModel || config.anthropicModel || "inherit-local-default",
    imageAnalysisMode: config.imageAnalysisMode,
    classifier: {
      prompt: classification.prompt,
      inputJson: classification.payload,
      downloadedImagePaths: classification.imagePaths,
      imagePathsSentToReadTool: classification.agentImagePaths,
      allowedTools: classification.agentImagePaths.length ? ["Read"] : [],
      disallowedTools,
      maxTurns: classification.maxTurns
    },
    browserMetadataNotSentToClassifier: {
      id: rfq.id || null,
      buyerText: rfq.buyerText || "",
      quantityText: rfq.quantityText || "",
      countryText: rfq.countryText || "",
      remainingQuotesText: rfq.remainingQuotesText || "",
      publishedText: rfq.publishedText || "",
      searchTerm: rfq.searchTerm || "",
      detailUrl: rfq.detailUrl || "",
      quoteUrl: rfq.quoteUrl || "",
      collectedAt: rfq.collectedAt || null
    },
    imageAssets: rfq.imageAssets || []
  };
  if (draft && analysis && quote) {
    const drafting = buildDraftRequest(rfq, analysis, quote);
    audit.drafter = {
      prompt: drafting.prompt,
      inputJson: drafting.payload,
      allowedTools: [],
      disallowedTools,
      maxTurns: drafting.maxTurns
    };
  } else {
    audit.drafter = null;
  }
  return audit;
}
