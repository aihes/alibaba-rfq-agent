import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeAutoContact } from "../../../src/auto-contact.js";
import { buildAgentInputAudit } from "../../../src/agent-audit.js";
import { connectBrowser, assertAlibabaReady } from "../../../src/browser.js";
import { classifyRfq } from "../../../src/classifier.js";
import { collectSearchPage, hydrateDetail } from "../../../src/collector.js";
import { loadConfig } from "../../../src/config.js";
import { createDraft } from "../../../src/drafter.js";
import { fillQuoteForm, submissionToken } from "../../../src/form.js";
import { priceRfq } from "../../../src/pricing.js";
import { parseNumber, stableRfqId, writeJson } from "../../../src/utils.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginDir = path.resolve(scriptDir, "..");
export const projectRoot = path.resolve(pluginDir, "../..");
const draftsDir = path.join(projectRoot, "data/drafts");
const runsDir = path.join(projectRoot, "data/runs");

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value) {
  return String(value || "rfq")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "rfq";
}

function assertRunId(runId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(String(runId || ""))) {
    throw new Error("Invalid audit run id");
  }
  return String(runId);
}

function runPaths(runId) {
  const safeRunId = assertRunId(runId);
  const directory = path.join(runsDir, safeRunId);
  fs.mkdirSync(directory, { recursive: true });
  return {
    directory,
    scanPath: path.join(directory, "scan.json"),
    reportPath: path.join(directory, "RUN_REPORT.md")
  };
}

function relativeProjectPath(filePath) {
  return path.relative(projectRoot, filePath);
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function fenced(value) {
  return String(value ?? "").replace(/```/g, "` ` `").trim();
}

export function writeRunReport(runId) {
  const paths = runPaths(runId);
  if (!fs.existsSync(paths.scanPath)) return null;
  const scan = JSON.parse(fs.readFileSync(paths.scanPath, "utf8"));
  const larkPath = path.join(paths.directory, "lark.json");
  const lark = fs.existsSync(larkPath) ? JSON.parse(fs.readFileSync(larkPath, "utf8")) : null;
  const quoteFiles = fs.readdirSync(paths.directory)
    .filter((name) => name.startsWith("quote-") && name.endsWith(".json"))
    .sort();
  const quotes = quoteFiles.map((name) => JSON.parse(fs.readFileSync(path.join(paths.directory, name), "utf8")));
  const lines = [
    "# Alibaba RFQ Midscene.js 实跑记录",
    "",
    "> 本报告由插件根据真实浏览器运行产物自动生成。RFQ 字段来自 Alibaba 页面；分析与文案来自本地 Claude Agent SDK / GLM；价格来自版本化确定性规则。未出现 `submitted` 证据时，不代表已向买家发送。",
    "",
    "## 运行信息",
    "",
    `- Run ID：\`${scan.runId}\``,
    `- 扫描时间：\`${scan.recordedAt}\``,
    `- 浏览器模式：\`${scan.browserMode}\`（\`${scan.provider}\`）`,
    `- 搜索词：\`${scan.searchTerm}\``,
    `- 页面提取数量：\`${scan.count}\``,
    `- 完整分析/报价数量：\`${quotes.length}\``,
    ...(lark?.url ? [`- Lark 文档：[${lark.title || "查看云端报告"}](${lark.url})`] : []),
    "",
    "## 一眼看懂",
    "",
    "| 指标 | 结果 |",
    "|---|---:|",
    `| 实际扫描 RFQ | ${scan.count} |`,
    `| 完整分析/报价 | ${quotes.length} |`,
    `| 已向买家提交 | ${quotes.filter((item) => item.record?.submission?.status === "submitted").length} |`,
    "",
    "> 本次报价是基于已验证规则生成的条件报价。规格未确认，因此只形成草稿，没有填写或提交 Alibaba 表单。",
    "",
    "## 实际扫描到的 RFQ",
    "",
    "| # | RFQ ID | 标题 | 数量 | 国家/地区 | 剩余席位 | 买家 | 页面 |",
    "|---:|---|---|---:|---|---:|---|---|",
    ...scan.rfqs.map((rfq, index) => `| ${index + 1} | \`${markdownCell(rfq.id)}\` | ${markdownCell(rfq.title)} | ${markdownCell(rfq.quantityText || rfq.quantity)} | ${markdownCell(rfq.countryText || rfq.country)} | ${markdownCell(rfq.remainingQuotesText || rfq.remainingQuotes)} | ${markdownCell(rfq.buyerText)} | [详情](${rfq.detailUrl}) |`),
    "",
    "### 扫描卡片原文",
    "",
    ...scan.rfqs.flatMap((rfq, index) => [
      `#### ${index + 1}. ${rfq.title}`,
      "",
      `- RFQ ID：\`${rfq.id}\``,
      `- 报价入口：[Alibaba 报价页](${rfq.quoteUrl})`,
      "",
      "```text",
      fenced(rfq.summary),
      "```",
      ""
    ]),
    "## 分析和报价结果",
    ""
  ];

  if (!quotes.length) {
    lines.push("本次运行只完成扫描，尚未对任何 RFQ 执行完整分析或报价。", "");
  }

  for (const item of quotes) {
    const record = item.record;
    const rfq = record.rfq;
    const analysis = record.analysis;
    const quote = record.quote;
    const draft = record.draft;
    const submission = record.submission || {};
    lines.push(
      `### ${rfq.title}`,
      "",
      `- RFQ ID：\`${rfq.id}\``,
      `- 买家/地区：${rfq.buyerText || "未提取"} / ${rfq.country || "未提取"}`,
      `- 数量：${rfq.quantityText || rfq.quantity || "未提取"}`,
      `- 详情页：[Alibaba RFQ](${rfq.detailUrl})`,
      `- 抓取时间：\`${rfq.collectedAt || record.createdAt}\``,
      `- Agent：\`${analysis.agent?.provider || "unknown"}\`，请求模型 \`${analysis.agent?.requestedModel || "unknown"}\`，实际链路 \`${(analysis.agent?.modelsUsed || []).join(" -> ") || "unknown"}\`，分析耗时 \`${analysis.agent?.durationMs ?? "unknown"} ms\``,
      "",
      "#### 页面原始需求",
      "",
      "```text",
      fenced(rfq.detailText || rfq.summary),
      "```",
      "",
      "#### 模型抽取与判断",
      "",
      `- 类目：\`${analysis.categoryId}\`；置信度：\`${analysis.confidence}\`；建议：\`${analysis.recommendation}\``,
      `- 结构化字段：\`${JSON.stringify(analysis.fields)}\``,
      `- 缺少字段：${analysis.missingRequired?.length ? analysis.missingRequired.map((value) => `\`${value}\``).join("、") : "无"}`,
      `- 风险项：${analysis.riskFlags?.length ? analysis.riskFlags.map((value) => `\`${value}\``).join("；") : "无"}`,
      "",
      "#### 确定性报价",
      ""
    );
    if (quote?.unitPriceUsd != null) {
      lines.push(
        `- 状态：\`${quote.status}\``,
        `- 单价：\`${quote.currency} ${quote.unitPriceUsd}\``,
        `- 数量：\`${quote.quantity}\``,
        `- 合计：\`${quote.currency} ${quote.totalUsd}\``,
        `- 贸易条款：\`${quote.tradeTerm}\`；运费：${quote.freightIncluded ? "包含" : "不包含"}；税费：${quote.taxIncluded ? "包含" : "不包含"}`,
        `- 计价假设：${quote.basis}`,
        `- 规则版本：\`${quote.rulesVersion}\``,
        `- 警告：${quote.warning}`
      );
    } else {
      lines.push(`- 状态：\`${quote?.status || "not_quoted"}\``, `- 原因：${quote?.reason || "没有可用的确定性价格规则"}`);
    }
    lines.push(
      "",
      "#### 生成的买家文案",
      "",
      draft?.buyerMessage || "未生成买家文案。",
      "",
      "#### 外部动作证据",
      "",
      `- 状态：\`${submission.status || "unknown"}\``,
      `- 提交确认令牌：${item.submitToken ? `\`${item.submitToken}\`` : "无（该报价不满足自动提交条件）"}`,
      `- 结论：${submission.status === "submitted" ? "存在已提交记录。" : "没有向买家提交报价的证据。"}`,
      ""
    );
  }

  lines.push(
    "## 证据边界",
    "",
    "- 页面标题、摘要、数量、国家、买家、详情正文与 URL：浏览器实际提取。",
    "- 类目、规格抽取、缺参、风险和买家问题：模型判断，需要人工复核。",
    "- 金额：确定性规则计算，不是模型自由猜价；条件报价不能自动发送。",
    "- `plugin_prepared_not_submitted` / `skipped`：只表示本地生成，不能视为已联系买家。",
    ""
  );
  fs.writeFileSync(paths.reportPath, `${lines.join("\n")}\n`);
  return paths.reportPath;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

async function withBrowser(config, operation) {
  const connection = await connectBrowser(config);
  try {
    return await operation(connection);
  } finally {
    await connection.browser.close().catch(() => {});
  }
}

export function resolveDraftFile(fileArg) {
  if (!fileArg) throw new Error("A draft JSON path is required");
  const candidate = path.resolve(projectRoot, fileArg);
  const allowedPrefix = `${path.resolve(draftsDir)}${path.sep}`;
  if (!candidate.startsWith(allowedPrefix) || path.extname(candidate).toLowerCase() !== ".json") {
    throw new Error("Draft path must be a JSON file inside data/drafts");
  }
  if (!fs.existsSync(candidate)) throw new Error(`Draft does not exist: ${candidate}`);
  const realCandidate = fs.realpathSync(candidate);
  const realAllowedPrefix = `${fs.realpathSync(draftsDir)}${path.sep}`;
  if (!realCandidate.startsWith(realAllowedPrefix)) throw new Error("Draft symlink resolves outside data/drafts");
  return realCandidate;
}

export function readDraft(fileArg) {
  const filePath = resolveDraftFile(fileArg);
  return { filePath, record: JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

export async function browserStatus() {
  const config = loadConfig();
  return withBrowser(config, async ({ page, selectedTab }) => {
    await assertAlibabaReady(page);
    const body = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
    return {
      provider: "chrome-bridge",
      connected: true,
      loggedIn: /退出|My Alibaba|立即报价|RFQ 详情|Order\b|Favorites\b/i.test(body.slice(0, 5000)),
      url: page.url(),
      title: selectedTab?.title || "",
      tabId: selectedTab?.id || null
    };
  });
}

export async function scanRfqs({ searchTerm, maxCards = 20 }) {
  if (!String(searchTerm || "").trim()) throw new Error("searchTerm is required");
  const config = loadConfig();
  config.maxCardsPerSearch = clamp(maxCards, 1, 30);
  return withBrowser(config, async ({ page }) => {
    const cards = await collectSearchPage(page, config, String(searchTerm).trim());
    const runId = `${compactTimestamp()}-${slug(searchTerm)}`;
    const paths = runPaths(runId);
    const record = {
      runId,
      recordedAt: new Date().toISOString(),
      browserMode: "existing-chrome",
      provider: "chrome-bridge",
      searchTerm: String(searchTerm).trim(),
      count: cards.length,
      rfqs: cards.map((card) => ({
        id: card.id,
        title: card.title,
        summary: card.summary,
        quantityText: card.quantityText,
        quantity: card.quantity,
        countryText: card.countryText,
        country: card.country,
        remainingQuotesText: card.remainingQuotesText,
        remainingQuotes: card.remainingQuotes,
        publishedText: card.publishedText,
        buyerText: card.buyerText,
        cardImageUrl: card.cardImageUrl,
        detailUrl: card.detailUrl,
        quoteUrl: card.quoteUrl,
        searchTerm: card.searchTerm,
        collectedAt: card.collectedAt
      }))
    };
    fs.writeFileSync(paths.scanPath, `${JSON.stringify(record, null, 2)}\n`);
    writeRunReport(runId);
    return {
      ...record,
      outputPath: paths.scanPath,
      reportPath: paths.reportPath
    };
  });
}

function normalizeRfqInput(input) {
  if (!input || typeof input !== "object") throw new Error("rfq must be an object returned by midscene_scan_rfqs");
  const rfq = { ...input };
  rfq.id = rfq.id || stableRfqId(rfq);
  rfq.quantity = Number.isFinite(Number(rfq.quantity)) ? Number(rfq.quantity) : parseNumber(rfq.quantityText);
  rfq.remainingQuotes = Number.isFinite(Number(rfq.remainingQuotes)) ? Number(rfq.remainingQuotes) : parseNumber(rfq.remainingQuotesText);
  if (!rfq.id || !rfq.detailUrl || !rfq.quoteUrl) throw new Error("RFQ id, detailUrl and quoteUrl are required");
  assertAlibabaRfqUrl(rfq.detailUrl, "detail");
  assertAlibabaRfqUrl(rfq.quoteUrl, "quote");
  return rfq;
}

export function assertAlibabaRfqUrl(value, kind) {
  const url = new URL(value);
  const valid = kind === "detail"
    ? url.protocol === "https:" && url.hostname === "sourcing.alibaba.com" && /\/rfq_detail\.htm$/i.test(url.pathname)
    : url.protocol === "https:" && url.hostname === "rfqposting.alibaba.com" && /\/rfq_quotation_post\.htm$/i.test(url.pathname);
  if (!valid) throw new Error(`RFQ ${kind} URL is outside the allowed Alibaba endpoint`);
  return url.toString();
}

export async function analyzeRfq({ rfq: input, runId = null }) {
  const config = loadConfig();
  const rfq = normalizeRfqInput(input);
  return withBrowser(config, async ({ page }) => {
    const hydrated = await hydrateDetail(page, rfq, config);
    const analysis = await classifyRfq(config, hydrated);
    const quote = priceRfq(hydrated, analysis, config.pricing);
    const draft = await createDraft(config, hydrated, analysis, quote);
    const record = {
      createdAt: new Date().toISOString(),
      source: "alibaba-rfq-midscene-plugin",
      auditRunId: runId || null,
      rfq: hydrated,
      analysis,
      quote,
      draft,
      agentInput: buildAgentInputAudit(config, hydrated, analysis, quote, draft),
      submission: { status: "plugin_prepared_not_submitted" }
    };
    const relativePath = `data/drafts/${hydrated.id}-midscene.json`;
    const outputPath = writeJson(relativePath, record);
    const result = {
      outputPath,
      record,
      submitToken: quote.status === "quoted" ? submissionToken(record) : null
    };
    if (runId) {
      const paths = runPaths(runId);
      if (!fs.existsSync(paths.scanPath)) throw new Error(`Audit run does not contain scan.json: ${runId}`);
      const auditPath = path.join(paths.directory, `quote-${hydrated.id}.json`);
      fs.writeFileSync(auditPath, `${JSON.stringify(result, null, 2)}\n`);
      writeRunReport(runId);
      result.auditPath = auditPath;
      result.reportPath = paths.reportPath;
    }
    return result;
  });
}

function recordRunAction(record, action, result) {
  if (!record.auditRunId) return null;
  const paths = runPaths(record.auditRunId);
  const actionPath = path.join(paths.directory, `${action}-${record.rfq.id}.json`);
  fs.writeFileSync(actionPath, `${JSON.stringify({ createdAt: new Date().toISOString(), action, result }, null, 2)}\n`);
  const quotePath = path.join(paths.directory, `quote-${record.rfq.id}.json`);
  if (fs.existsSync(quotePath)) {
    const item = JSON.parse(fs.readFileSync(quotePath, "utf8"));
    item.record = record;
    fs.writeFileSync(quotePath, `${JSON.stringify(item, null, 2)}\n`);
  }
  writeRunReport(record.auditRunId);
  return actionPath;
}

export async function fillQuote({ file }) {
  const config = loadConfig();
  const { filePath, record } = readDraft(file);
  const result = await fillQuoteForm(config, record, { submit: false });
  record.submission = result;
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  const auditPath = recordRunAction(record, "fill", result);
  return { filePath, auditPath, ...result };
}

export async function submitQuote({ file, confirmationToken, confirmLiveSubmission }) {
  if (confirmLiveSubmission !== true) {
    throw new Error("Immediate live-submission confirmation is required");
  }
  const config = loadConfig();
  const { filePath, record } = readDraft(file);
  const expected = submissionToken(record);
  if (confirmationToken !== expected) throw new Error(`Exact confirmation token required: ${expected}`);
  const result = await executeAutoContact(config, record);
  record.submission = result;
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  const auditPath = recordRunAction(record, "submit", result);
  return { filePath, auditPath, ...result };
}
