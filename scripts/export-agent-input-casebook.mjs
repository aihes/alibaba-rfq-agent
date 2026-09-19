import fs from "node:fs";
import path from "node:path";
import { buildAgentInputAudit } from "../src/agent-audit.js";
import { loadConfig, projectDir } from "../src/config.js";

const cases = [
  ["Case 1", "data/drafts/rfq-c063adcab4640c7b6dc08cad-midscene.json"],
  ["Case 2", "data/drafts/rfq-13d3a098d4b523d4f60fb003.json"],
  ["Case 3", "data/drafts/rfq-da701a6112740f3a9cea4d7d.json"],
  ["Case 4", "data/drafts/rfq-e2d1cdffd566e451eb1e8d61.json"],
  ["Case 5", "data/drafts/rfq-e64b722fcd87d1633a1e92b3.json"],
  ["Case 6", "data/drafts/rfq-02c491fe161c91c97bbb2cdd.json"]
];

const outputDir = path.join(projectDir, "data/runs/20260918T145100Z-corrugated-carton-box");
const config = loadConfig();
const records = cases.map(([label, relativePath]) => {
  const sourcePath = path.join(projectDir, relativePath);
  const record = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const audit = buildAgentInputAudit(config, record.rfq, record.analysis, record.quote, record.draft);
  audit.reconstruction = true;
  audit.reconstructionNote = "The historical run stored the hydrated RFQ and model metadata but not a separate prompt snapshot. This request is deterministically reconstructed from that stored RFQ using the production prompt builder. Future runs persist agentInput directly.";
  return {
    label,
    sourcePath: relativePath,
    createdAt: record.createdAt,
    rfq: record.rfq,
    agentInput: audit,
    agentOutput: {
      analysis: record.analysis,
      quote: record.quote,
      draft: record.draft,
      submission: record.submission
    }
  };
});

const manifest = {
  title: "Alibaba RFQ Agent Input Casebook",
  generatedAt: new Date().toISOString(),
  historicalPromptStatus: "deterministically_reconstructed",
  futurePromptStatus: "persisted_in_each_draft.agentInput",
  cases: records
};

fs.writeFileSync(path.join(outputDir, "AGENT_INPUT_CASEBOOK.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const escapeXml = (value = "") => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");
const jsonBlock = (value, caption) => `<pre lang="json" caption="${escapeXml(caption)}"><code>${escapeXml(JSON.stringify(value, null, 2))}</code></pre>`;

const lines = [
  "<hr/>",
  "<h1>附录｜Agent 实际输入审计</h1>",
  "<p>本附录回答一个具体问题：浏览器抓到的 RFQ 中，哪些字段真正进入了 Claude/GLM，图片如何处理，模型输出又是什么。历史运行没有单独保存 prompt 快照，因此以下内容由当时落盘的 hydrated RFQ 使用同一生产 prompt builder 确定性重建；不是重新调用模型。自下一次运行起，完整输入会直接写入每条草稿的 <code>agentInput</code> 字段。</p>",
  "<callout emoji=\"📝\" background-color=\"light-blue\" border-color=\"blue\"><p><b>当前图片模式是 local-ocr。</b> 原图先下载到本地并执行 OCR；分类 Agent 收到的是图片路径、OCR 状态和 OCR 文本，但 <code>imagePathsSentToReadTool</code> 为空、<code>allowedTools</code> 为空。因此文档中的图片是 RFQ 输入证据，不代表 GLM 在当次运行中直接看到了像素。</p></callout>",
  "<h2>分类 Agent 的固定输入协议</h2>",
  "<p>每个 Case 的分类调用都包含相同的安全指令和 JSON 输出契约。变化的部分是 <code>INPUT_JSON</code>：类目关键词合同、RFQ 的 title/summary/detailText/quantity/country，以及本地图片 OCR。买家名、RFQ URL、剩余席位和发布时间保留在浏览器记录中，但不发送给分类 Agent。</p>"
];

for (const item of records) {
  const { label, rfq, agentInput, agentOutput } = item;
  lines.push(
    "<hr/>",
    `<h1>${label} 输入审计｜${escapeXml(rfq.title)}</h1>`,
    `<p><b>源文件：</b><code>${escapeXml(item.sourcePath)}</code>　<b>RFQ ID：</b><code>${escapeXml(rfq.id)}</code>　<b>运行时间：</b><code>${escapeXml(item.createdAt)}</code></p>`,
    "<h2>浏览器记录但未发送给分类 Agent</h2>",
    jsonBlock(agentInput.browserMetadataNotSentToClassifier, `${label} browser-only metadata`),
    "<h2>图片输入清单</h2>"
  );
  if (agentInput.imageAssets.length) {
    for (const [index, asset] of agentInput.imageAssets.entries()) {
      lines.push(
        `<p><b>图片 ${index + 1}：</b><code>${escapeXml(asset.filePath)}</code><br/><b>来源：</b>${escapeXml(asset.sourceUrl)}<br/><b>大小 / MIME：</b>${escapeXml(asset.bytes)} bytes / ${escapeXml(asset.contentType)}<br/><b>OCR：</b><code>${escapeXml(asset.ocrStatus || "unavailable")}</code> — ${escapeXml(asset.ocrText || "无可用文字")}</p>`,
        `<img href="${escapeXml(asset.sourceUrl)}" caption="${label}｜RFQ 原始附件 ${index + 1}；OCR 状态：${escapeXml(asset.ocrStatus || "unavailable")}"/>`
      );
    }
  } else {
    lines.push("<p>该 RFQ 没有下载到产品图片，因此分类 Agent 的 <code>localImageOcr</code> 为空，<code>imageReadStatus</code> 必须为 <code>not_provided</code>。</p>");
  }
  lines.push(
    "<h2>真正传给分类 Agent 的 INPUT_JSON</h2>",
    jsonBlock(agentInput.classifier.inputJson, `${label} exact classification INPUT_JSON`),
    "<h2>工具与模型边界</h2>",
    jsonBlock({
      provider: agentInput.provider,
      requestedModel: agentInput.requestedModel,
      imageAnalysisMode: agentInput.imageAnalysisMode,
      downloadedImagePaths: agentInput.classifier.downloadedImagePaths,
      imagePathsSentToReadTool: agentInput.classifier.imagePathsSentToReadTool,
      allowedTools: agentInput.classifier.allowedTools,
      disallowedTools: agentInput.classifier.disallowedTools,
      maxTurns: agentInput.classifier.maxTurns
    }, `${label} agent execution boundary`),
    "<h2>分类 Agent 实际输出</h2>",
    jsonBlock(agentOutput.analysis, `${label} classification output`)
  );
  if (agentInput.drafter) {
    lines.push(
      "<h2>第二次调用：报价文案 Agent 输入</h2>",
      "<p>只有该 Case 产生了可用的条件报价，所以又触发了一次文案生成调用。这个 Agent 不再接收完整 detailText 或图片，只接收 RFQ 的 title/country/quantity、已经归一化的 analysis 和确定性 quote。</p>",
      jsonBlock(agentInput.drafter.inputJson, `${label} exact drafting INPUT_JSON`),
      "<h2>报价文案 Agent 输出</h2>",
      jsonBlock(agentOutput.draft, `${label} drafting output`)
    );
  } else {
    lines.push("<p><b>没有第二次文案调用：</b>报价状态为 <code>needs_review</code>，因此 drafter 没有运行，也没有生成买家报价文案。</p>");
  }
}

fs.writeFileSync(path.join(outputDir, "LARK_AGENT_INPUT_APPENDIX.xml"), `${lines.join("\n\n")}\n`);
console.log(JSON.stringify({
  json: path.join(outputDir, "AGENT_INPUT_CASEBOOK.json"),
  larkXml: path.join(outputDir, "LARK_AGENT_INPUT_APPENDIX.xml"),
  cases: records.length
}, null, 2));
