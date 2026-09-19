import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../src/config.js";

function option(name) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const index = process.argv.indexOf(`--${name}`);
  return direct ? direct.slice(name.length + 3) : index >= 0 ? process.argv[index + 1] : "";
}

const escapeXml = (value = "") => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

function msLabel(value) {
  if (!Number.isFinite(value)) return "—";
  return `${(value / 1000).toFixed(1)} 秒`;
}

function localTime(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

const inputArg = option("input");
if (!inputArg) throw new Error("Use --input data/runs/<run-id>/ONE_HOUR_RUN.json");
const inputPath = path.isAbsolute(inputArg) ? inputArg : path.join(projectDir, inputArg);
const manifest = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const outputPath = path.join(path.dirname(inputPath), "LARK_ONE_HOUR_REPORT.xml");
const scanned = manifest.cycles.reduce((sum, cycle) => sum + Number(cycle.result?.scanned || 0), 0);
const submitted = manifest.cases.filter((item) => item.record.submission?.status === "submitted");
const quoted = manifest.cases.filter((item) => item.record.quote?.status === "quoted");
const needsReview = manifest.cases.filter((item) => item.record.quote?.status === "needs_review");

const lines = [
  "<hr/>",
  "<h1>一小时真实自动报价运行</h1>",
  `<p><b>运行窗口：</b>${escapeXml(localTime(manifest.startedAt))} 至 ${escapeXml(localTime(manifest.completedAt || manifest.plannedEndAt))}（Asia/Shanghai）　<b>Run ID：</b><code>${escapeXml(manifest.runId)}</code></p>`,
  `<p><b>统计口径：</b>计划运行 60 分钟，实际运行 ${escapeXml(msLabel(Date.parse(manifest.completedAt || manifest.plannedEndAt) - Date.parse(manifest.startedAt)))}；最后一轮在计划结束前已经开始，因此完整收尾后结束。累计扫描数是各轮页面卡片观察次数之和，包含不同轮次对同一列表卡片的重复观察；“新处理 RFQ”才是本轮首次进入详情分析的去重数量。</p>`,
  "<p>本节只记录这一小时内真实扫描、真实 Agent 调用和真实 Alibaba 外部动作。只有页面提交成功提示得到验证且 <code>submission.status=submitted</code> 的记录才计入成功报价；<code>needs_review</code>、<code>skipped</code>、<code>needs_manual_review</code> 均不算成功。</p>",
  "<h2>运行结果</h2>",
  "<table><colgroup><col width=\"210\"/><col width=\"130\"/></colgroup><thead><tr><th background-color=\"light-gray\">指标</th><th background-color=\"light-gray\">结果</th></tr></thead><tbody>",
  `<tr><td>实际轮次</td><td>${manifest.cycles.length}</td></tr>`,
  `<tr><td>累计扫描 RFQ 卡片</td><td>${scanned}</td></tr>`,
  `<tr><td>新处理 RFQ</td><td>${manifest.cases.length}</td></tr>`,
  `<tr><td>确定性规则可报价</td><td>${quoted.length}</td></tr>`,
  `<tr><td>成功提交报价</td><td>${submitted.length}</td></tr>`,
  `<tr><td>需要复核、未报数字</td><td>${needsReview.length}</td></tr>`,
  `<tr><td>是否提前停止</td><td>${manifest.stoppedEarly ? `是：${escapeXml(manifest.stopReason || "未知原因")}` : "否"}</td></tr>`,
  "</tbody></table>",
  "<h2>从发现到报价的耗时</h2>"
];

if (manifest.cases.length) {
  lines.push(
    "<table><colgroup><col width=\"165\"/><col width=\"135\"/><col width=\"120\"/><col width=\"100\"/><col width=\"100\"/><col width=\"110\"/></colgroup><thead><tr><th background-color=\"light-gray\">RFQ ID</th><th background-color=\"light-gray\">类目</th><th background-color=\"light-gray\">外部结果</th><th background-color=\"light-gray\">发现→草稿</th><th background-color=\"light-gray\">提交动作</th><th background-color=\"light-gray\">发现→提交</th></tr></thead><tbody>",
    ...manifest.cases.map((item) => {
      const record = item.record;
      return `<tr><td><code>${escapeXml(record.rfq.id)}</code></td><td><code>${escapeXml(record.analysis.categoryId)}</code></td><td><code>${escapeXml(record.submission?.status || "unknown")}</code></td><td>${escapeXml(msLabel(record.timing?.discoveryToDraftMs))}</td><td>${escapeXml(msLabel(record.timing?.submissionDurationMs))}</td><td>${escapeXml(msLabel(record.timing?.discoveryToSubmissionMs))}</td></tr>`;
    }),
    "</tbody></table>"
  );
} else {
  lines.push("<p>这一小时没有发现尚未处理的新 RFQ，因此没有单条报价耗时。</p>");
}

for (const [index, item] of manifest.cases.entries()) {
  const { record, quoteRationale } = item;
  const rationale = quoteRationale?.output;
  lines.push(
    `<h2>运行 Case ${index + 1}｜${escapeXml(record.rfq.title)}</h2>`,
    `<p><b>RFQ ID：</b><code>${escapeXml(record.rfq.id)}</code>　<b>买家：</b>${escapeXml(record.rfq.buyerText || "未提取")}　<b>国家：</b>${escapeXml(record.rfq.country || "未提取")}　<a href="${escapeXml(record.rfq.detailUrl)}">查看原始 RFQ</a></p>`,
    `<p><b>发现时间：</b>${escapeXml(localTime(record.timing?.discoveredAt || record.rfq.collectedAt))}　<b>分类：</b><code>${escapeXml(record.analysis.categoryId)}</code>　<b>置信度：</b>${escapeXml(record.analysis.confidence)}　<b>外部动作：</b><code>${escapeXml(record.submission?.status || "unknown")}</code></p>`,
    "<h3>买家原始需求</h3>",
    `<pre lang="text" caption="运行 Case ${index + 1}｜Alibaba RFQ 原始字段"><code>${escapeXml(record.rfq.detailText || record.rfq.summary || "")}</code></pre>`,
    "<h3>Agent 报价依据（真实运行）</h3>",
    `<p><b>运行证据：</b>请求模型 <code>${escapeXml(quoteRationale?.agent?.requestedModel || record.analysis.agent?.requestedModel || "unknown")}</code>，实际链路 <code>${escapeXml((quoteRationale?.agent?.modelsUsed || record.analysis.agent?.modelsUsed || []).join(" → ") || "unknown")}</code>，独立报价依据耗时 ${escapeXml(msLabel(quoteRationale?.agent?.durationMs))}。完整精确输入和原始 JSON 输出保存在本地 Case 审计文件中。</p>`,
    `<p><b>结论：</b>${escapeXml(rationale?.decisionSummary || record.quote?.reason || "没有独立报价依据")}</p>`
  );
  if (rationale?.ruleEvaluation?.length) {
    lines.push(
      "<table><colgroup><col width=\"145\"/><col width=\"180\"/><col width=\"210\"/><col width=\"90\"/></colgroup><thead><tr><th background-color=\"light-gray\">检查项</th><th background-color=\"light-gray\">观察值</th><th background-color=\"light-gray\">价格规则</th><th background-color=\"light-gray\">结果</th></tr></thead><tbody>",
      ...rationale.ruleEvaluation.map((check) => `<tr><td>${escapeXml(check.check)}</td><td>${escapeXml(check.observed)}</td><td>${escapeXml(check.required)}</td><td>${escapeXml(check.status)}</td></tr>`),
      "</tbody></table>"
    );
  }
  if (rationale?.calculation?.length) {
    lines.push(`<p><b>计算：</b>${escapeXml(rationale.calculation.join("；"))}</p>`);
  }
  if (rationale?.assumptions?.length) {
    lines.push(`<p><b>关键假设：</b>${escapeXml(rationale.assumptions.join("；"))}</p>`);
  }
  if (rationale?.risks?.length) {
    lines.push(`<p><b>风险：</b>${escapeXml(rationale.risks.join("；"))}</p>`);
  }
  lines.push(
    `<p><b>价格边界：</b>${escapeXml(rationale?.pricingBoundary || record.quote?.reason || "无")}</p>`,
    "<h3>我们的报价与 Alibaba 动作</h3>"
  );
  if (record.quote?.unitPriceUsd != null) {
    lines.push(
      "<table><colgroup><col width=\"150\"/><col width=\"470\"/></colgroup><tbody>",
      `<tr><td background-color="light-gray"><b>报价状态</b></td><td><code>${escapeXml(record.quote.status)}</code></td></tr>`,
      `<tr><td background-color="light-gray"><b>单价</b></td><td>${escapeXml(record.quote.currency)} ${escapeXml(record.quote.unitPriceUsd)}</td></tr>`,
      `<tr><td background-color="light-gray"><b>数量 / 总价</b></td><td>${escapeXml(record.quote.quantity)} / ${escapeXml(record.quote.currency)} ${escapeXml(record.quote.totalUsd)}</td></tr>`,
      `<tr><td background-color="light-gray"><b>贸易条款</b></td><td>${escapeXml(record.quote.tradeTerm)}；运费与税费${record.quote.freightIncluded || record.quote.taxIncluded ? "按记录" : "不包含"}</td></tr>`,
      `<tr><td background-color="light-gray"><b>页面提交状态</b></td><td><code>${escapeXml(record.submission?.status || "unknown")}</code></td></tr>`,
      `<tr><td background-color="light-gray"><b>发现→提交</b></td><td>${escapeXml(msLabel(record.timing?.discoveryToSubmissionMs))}</td></tr>`,
      "</tbody></table>",
      `<blockquote>${escapeXml(record.draft?.buyerMessage || "未生成买家回复")}</blockquote>`
    );
  } else {
    lines.push(
      `<p><b>没有数字报价：</b>${escapeXml(record.quote?.reason || "没有匹配的确定性价格规则")}。因此 Alibaba 动作为 <code>${escapeXml(record.submission?.status || "unknown")}</code>，不计入成功报价。</p>`
    );
  }
}

lines.push(
  "<h2>证据边界</h2>",
  "<p>页面原文、标题、数量、国家、买家和 URL 来自浏览器实际读取；类目、规格抽取与报价依据来自 Agent，需要按来源复核；金额只来自版本化确定性规则；外部成功只以 Alibaba 成功页验证和 <code>submitted</code> 状态为准。本节展示的是可审计决策依据，不包含也不声称暴露模型内部隐藏思维链。</p>"
);

fs.writeFileSync(outputPath, `${lines.join("\n\n")}\n`);
console.log(JSON.stringify({ outputPath, cases: manifest.cases.length, submitted: submitted.length }, null, 2));
