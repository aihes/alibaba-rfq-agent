import fs from "node:fs";
import path from "node:path";
import { explainQuoteWithClaude } from "../src/claude.js";
import { loadConfig, projectDir } from "../src/config.js";
import { runCycle } from "../src/pipeline.js";
import { sleep } from "../src/utils.js";

function argNumber(name, fallback) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const index = process.argv.indexOf(`--${name}`);
  const raw = direct ? direct.slice(name.length + 3) : index >= 0 ? process.argv[index + 1] : fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function writeManifest(outputPath, manifest) {
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function msLabel(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value / 1000).toFixed(1)} 秒`;
}

function reportMarkdown(manifest) {
  const processed = manifest.cases.length;
  const submitted = manifest.cases.filter((item) => item.record.submission?.status === "submitted");
  const failed = manifest.cases.filter((item) => item.record.submission?.status === "needs_manual_review");
  const quoted = manifest.cases.filter((item) => item.record.quote?.status === "quoted");
  const lines = [
    "# Alibaba RFQ 一小时真实运行报告",
    "",
    "> 浏览器字段来自已登录 Alibaba 页面；RFQ 分析和报价依据来自本地 Claude Agent SDK / GLM；金额来自确定性价格规则。只有 `submission.status=submitted` 且页面成功提示得到验证，才计入成功报价。",
    "",
    "## 运行汇总",
    "",
    `- Run ID：\`${manifest.runId}\``,
    `- 开始：\`${manifest.startedAt}\``,
    `- 结束：\`${manifest.completedAt || "运行中"}\``,
    `- 计划时长：${Math.round(manifest.requestedDurationMs / 60000)} 分钟`,
    `- 实际轮次：${manifest.cycles.length}`,
    `- 扫描卡片累计：${manifest.cycles.reduce((sum, cycle) => sum + Number(cycle.result?.scanned || 0), 0)}`,
    `- 新处理 RFQ：${processed}`,
    `- 确定性可报价：${quoted.length}`,
    `- 成功提交报价：${submitted.length}`,
    `- 提交后需人工复核：${failed.length}`,
    "",
    "## 报价耗时",
    "",
    "| RFQ | 类目 | 结果 | 发现→草稿 | 提交动作 | 发现→成功提交 |",
    "|---|---|---|---:|---:|---:|",
    ...manifest.cases.map((item) => {
      const record = item.record;
      return `| \`${record.rfq.id}\` | \`${record.analysis.categoryId}\` | \`${record.submission?.status || "unknown"}\` | ${msLabel(record.timing?.discoveryToDraftMs)} | ${msLabel(record.timing?.submissionDurationMs)} | ${msLabel(record.timing?.discoveryToSubmissionMs)} |`;
    }),
    ""
  ];

  for (const item of manifest.cases) {
    const { record, quoteRationale } = item;
    lines.push(
      `## ${record.rfq.title}`,
      "",
      `- RFQ ID：\`${record.rfq.id}\``,
      `- 买家/国家：${record.rfq.buyerText || "未提取"} / ${record.rfq.country || "未提取"}`,
      `- 发现时间：\`${record.timing?.discoveredAt || record.rfq.collectedAt}\``,
      `- 提交结果：\`${record.submission?.status || "unknown"}\``,
      "",
      "### 原始需求",
      "",
      "```text",
      String(record.rfq.detailText || record.rfq.summary || "").replace(/```/g, "` ` `"),
      "```",
      "",
      "### Agent 报价依据",
      "",
      quoteRationale?.output?.decisionSummary || "未生成独立报价依据。",
      "",
      ...(quoteRationale?.output?.ruleEvaluation || []).map((check) => `- ${check.check}：观察值 ${check.observed}；规则 ${check.required}；结论 ${check.status}`),
      "",
      ...(quoteRationale?.output?.calculation || []).map((line) => `- ${line}`),
      "",
      `价格边界：${quoteRationale?.output?.pricingBoundary || record.quote?.reason || "无"}`,
      "",
      "### 最终报价与外部动作",
      ""
    );
    if (record.quote?.unitPriceUsd != null) {
      lines.push(
        `- 报价状态：\`${record.quote.status}\``,
        `- 单价：${record.quote.currency} ${record.quote.unitPriceUsd}`,
        `- 数量：${record.quote.quantity}`,
        `- 总价：${record.quote.currency} ${record.quote.totalUsd}`,
        `- 条款：${record.quote.tradeTerm}`,
        `- 买家回复：${record.draft?.buyerMessage || "未生成"}`
      );
    } else {
      lines.push(`- 未产生数字报价：${record.quote?.reason || "没有匹配的确定性价格规则"}`);
    }
    lines.push(`- Alibaba 动作：\`${record.submission?.status || "unknown"}\``, "");
  }
  return `${lines.join("\n")}\n`;
}

const durationMs = argNumber("duration-seconds", 3600) * 1000;
const config = loadConfig();
const intervalMs = Math.max(60000, config.pollIntervalSeconds * 1000);
const startedAt = new Date();
const endAt = new Date(startedAt.getTime() + durationMs);
const runId = `${compactTimestamp(startedAt)}-one-hour-live-quote`;
const runDir = path.join(projectDir, "data/runs", runId);
const outputPath = path.join(runDir, "ONE_HOUR_RUN.json");
const reportPath = path.join(runDir, "RUN_REPORT.md");
fs.mkdirSync(runDir, { recursive: true });

const manifest = {
  runId,
  startedAt: startedAt.toISOString(),
  plannedEndAt: endAt.toISOString(),
  completedAt: null,
  requestedDurationMs: durationMs,
  stoppedEarly: false,
  stopReason: null,
  config: {
    browserProvider: "chrome-bridge",
    searchTerms: config.searchTerms,
    pollIntervalSeconds: config.pollIntervalSeconds,
    maxNewRfqsPerCycle: config.maxNewRfqsPerCycle,
    autoContactMode: config.autoContactMode,
    allowLiveSubmit: config.allowLiveSubmit,
    autoContactAckValid: config.autoContactAck === "I_UNDERSTAND_AUTO_QUOTES_ARE_SENT",
    autoContactCategories: config.autoContactCategories,
    autoContactDailyLimit: config.autoContactDailyLimit,
    autoContactMaxTotalUsd: config.autoContactMaxTotalUsd,
    quotePortPresent: Boolean(config.quotePort),
    requestedModel: config.localClaudeModel || "inherit-local-default"
  },
  cycles: [],
  cases: []
};
writeManifest(outputPath, manifest);
console.log(JSON.stringify({ event: "run_started", runId, startedAt: manifest.startedAt, plannedEndAt: manifest.plannedEndAt, outputPath }));

let cycleIndex = 0;
while (Date.now() < endAt.getTime()) {
  cycleIndex += 1;
  const cycle = { cycleIndex, startedAt: new Date().toISOString(), completedAt: null, result: null, error: null };
  try {
    cycle.result = await runCycle(config);
    for (const summary of cycle.result.records || []) {
      const record = JSON.parse(fs.readFileSync(summary.outputPath, "utf8"));
      let quoteRationale = null;
      try {
        const rationaleStartedAt = new Date().toISOString();
        const rationale = await explainQuoteWithClaude(config, record.rfq, record.analysis, record.quote);
        quoteRationale = {
          generatedAt: new Date().toISOString(),
          startedAt: rationaleStartedAt,
          exactInput: {
            prompt: rationale.request.prompt,
            inputJson: rationale.request.payload,
            maxTurns: rationale.request.maxTurns,
            allowedTools: [],
            imagePixelsSent: false
          },
          agent: rationale.agent,
          output: rationale.output
        };
      } catch (error) {
        quoteRationale = { error: error.message, failedAt: new Date().toISOString() };
      }
      const caseAudit = { capturedAt: new Date().toISOString(), record, quoteRationale };
      manifest.cases.push(caseAudit);
      fs.writeFileSync(path.join(runDir, `case-${record.rfq.id}.json`), `${JSON.stringify(caseAudit, null, 2)}\n`);
      console.log(JSON.stringify({
        event: "case_completed",
        cycleIndex,
        rfqId: record.rfq.id,
        quoteStatus: record.quote?.status,
        submissionStatus: record.submission?.status,
        discoveryToSubmissionMs: record.timing?.discoveryToSubmissionMs,
        rationaleDecision: quoteRationale?.output?.decision || null
      }));
    }
  } catch (error) {
    cycle.error = error.message;
    if (/CAPTCHA|verification challenge|login is required|Cannot attach to the existing Chrome session through Chrome Bridge|Bridge call timeout|setDestroyOptions/i.test(error.message)) {
      manifest.stoppedEarly = true;
      manifest.stopReason = error.message;
    }
  }
  cycle.completedAt = new Date().toISOString();
  manifest.cycles.push(cycle);
  writeManifest(outputPath, manifest);
  fs.writeFileSync(reportPath, reportMarkdown(manifest));
  console.log(JSON.stringify({
    event: "cycle_completed",
    cycleIndex,
    scanned: cycle.result?.scanned || 0,
    newCandidates: cycle.result?.newCandidates || 0,
    processedTotal: manifest.cases.length,
    submittedTotal: manifest.cases.filter((item) => item.record.submission?.status === "submitted").length,
    error: cycle.error
  }));
  if (manifest.stoppedEarly || Date.now() >= endAt.getTime()) break;
  await sleep(Math.min(intervalMs, endAt.getTime() - Date.now()));
}

manifest.completedAt = new Date().toISOString();
writeManifest(outputPath, manifest);
fs.writeFileSync(reportPath, reportMarkdown(manifest));
console.log(JSON.stringify({
  event: "run_completed",
  runId,
  completedAt: manifest.completedAt,
  stoppedEarly: manifest.stoppedEarly,
  stopReason: manifest.stopReason,
  cycles: manifest.cycles.length,
  processed: manifest.cases.length,
  quoted: manifest.cases.filter((item) => item.record.quote?.status === "quoted").length,
  submitted: manifest.cases.filter((item) => item.record.submission?.status === "submitted").length,
  outputPath,
  reportPath
}, null, 2));
