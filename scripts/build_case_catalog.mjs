#!/usr/bin/env node
/** Build a local, traceable case catalog from RFQ drafts and archived workbooks.
 *
 * The generated catalog stays under data/ (gitignored). Spreadsheet prices are
 * recorded as documentary evidence, never promoted to live pricing rules.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const ARCHIVE = path.join(DATA, "reference-materials/2026-09-23-dingtalk/9.23报价模版收集.zip");
const OUTPUT = path.join(DATA, "case-catalog/cases.json");
const RFQ_INFO_MARKER = "/RFQ客户信息/";
const PI_NAME = /\bpi\b|pi\.xlsx|报价|报客户/i;
const PRICE_LABEL = /(?:unit\s*price|\bprice\b|单价)/i;
const TOTAL_LABEL = /(?:total\s*price|总价|总金额|合计金额)/i;
const QTY_LABEL = /(?:quantity|\bqty\b|数量)/i;
const DESCRIPTION_LABEL = /(?:description|product|goods|品名|产品名称)/i;
const COST_LABEL = /(?:单价|报价|成本|利润|运费|出厂价|工厂价)/i;
const PK_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const digest = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
const clean = (value, limit = 1200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

// ponytail: latin1 round-trip only when adm-zip left the name byte-mapped; real unicode passes through
function decodeZipName(name) {
  if (/[\u0100-\uFFFF]/.test(name)) return name;
  const fixed = Buffer.from(name, "latin1").toString("utf8");
  return fixed.includes("�") ? name : fixed;
}

function number(value) {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && value > 0) return Math.round(value * 1e6) / 1e6;
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "");
    if (/^(?:USD\s*|\$\s*)?\d+(?:\.\d+)?$/i.test(text)) return Number(text.match(/\d+(?:\.\d+)?/)[0]);
  }
  return null;
}

function category(text) {
  const t = String(text || "").toLowerCase();
  const buckets = [
    ["杯壶", ["tumbler", "cup", "mug", "bottle", "flask", "水杯", "不锈钢杯", "保温杯", "塑料杯", "陶瓷杯"]],
    ["纸袋", ["paper bag", "kraft bag", "kraft paper", "纸袋", "牛皮纸袋", "手提袋"]],
    ["纸箱彩盒", ["carton", "corrugated", "paper box", "纸箱", "纸盒", "彩盒"]],
    ["其他袋类", ["pouch", "bag", "无纺布袋", "塑料袋", "布袋", "手袋"]],
  ];
  for (const [name, keywords] of buckets) {
    if (keywords.some((word) => t.includes(word))) return name;
  }
  return "其他商品";
}

function dateFromName(name) {
  const match = String(name).match(/(202[0-9])[.\-_年](1[0-2]|0?[1-9])[.\-_月](3[01]|[12][0-9]|0?[1-9])/);
  if (!match) return null;
  return `${match[1].padStart(4, "0")}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function coordinate(col, row) {
  let label = "";
  let c = col;
  while (c > 0) {
    label = String.fromCharCode(65 + ((c - 1) % 26)) + label;
    c = Math.floor((c - 1) / 26);
  }
  return label + row;
}

function workbook(source) {
  if (!source.subarray(0, 4).equals(PK_MAGIC)) return null;
  return XLSX.read(source, { type: "buffer" });
}

/** Rows as Map<1-based column, {value, coordinate}> over the capped sheet area. */
function sheetRows(sheet, maxRows = 120, maxCols = 28) {
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  if (!range) return [];
  const rows = [];
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + maxRows - 1); r++) {
    const row = new Map();
    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + maxCols - 1); c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell != null && cell.v != null) row.set(c + 1, { value: cell.v, coordinate: coordinate(c + 1, r + 1) });
    }
    rows.push(row);
  }
  return rows;
}
function findQuotes(book, sourceId) {
  const quotes = [];
  const sheets = book.SheetNames.slice(0, 5).map((name) => [book.Sheets[name], name]);
  for (const [sheet, sheetName] of sheets) {
    const rows = sheetRows(sheet, 120, 30);
    for (let index = 0; index < rows.length; index++) {
      const headers = new Map([...rows[index]].map(([column, cell]) => [column, clean(cell.value, 180).toLowerCase()]));
      const qtyCols = [...headers].filter(([, value]) => QTY_LABEL.test(value)).map(([c]) => c);
      const descCols = [...headers].filter(([, value]) => DESCRIPTION_LABEL.test(value) && !PRICE_LABEL.test(value) && !value.includes("picture") && !value.includes("图片")).map(([c]) => c);
      const priceCols = [...headers].filter(([, value]) => PRICE_LABEL.test(value) && !TOTAL_LABEL.test(value)).map(([c]) => c);
      if (!(qtyCols.length && descCols.length && priceCols.length)) continue;
      const qtyCol = qtyCols[0];
      const descCol = descCols[0];
      const totalCols = [...headers].filter(([, value]) => TOTAL_LABEL.test(value)).map(([c]) => c);
      let previousDescription = "";
      let previousDescriptionCell = null;
      for (const line of rows.slice(index + 1, index + 31)) {
        const descriptionCell = line.get(descCol);
        const quantityCell = line.get(qtyCol);
        if (descriptionCell) {
          previousDescription = String(descriptionCell.value).trim();
          previousDescriptionCell = descriptionCell;
        }
        const description = previousDescription;
        const quantity = quantityCell ? number(quantityCell.value) : null;
        if (!description || !quantity) continue;
        const productMatch = description.match(/Product\s*Name\s*[:;：]\s*([^\n\r]+)/i);
        const productName = productMatch ? clean(productMatch[1], 130) : clean(description.split("\n")[0], 130);
        for (const priceCol of priceCols) {
          const priceCell = line.get(priceCol);
          const unitPrice = priceCell ? number(priceCell.value) : null;
          if (unitPrice == null) continue;
          const priceHeader = headers.get(priceCol);
          const termMatch = priceHeader.match(/\b(EXW|FOB|DDP|CIF)\b/i);
          const term = termMatch ? termMatch[1].toUpperCase() : "未注明";
          const termTotals = term !== "未注明"
            ? totalCols.filter((c) => c > priceCol && new RegExp(`\\b${term}\\b`, "i").test(headers.get(c)))
            : [];
          const totalCol = (termTotals.length ? termTotals : totalCols.filter((c) => c > priceCol)).slice(0, 1)[0];
          const matchingTotal = totalCol ? line.get(totalCol) : null;
          const total = matchingTotal ? number(matchingTotal.value) : null;
          const crossCheck = total == null ? "not_available"
            : Math.abs(total - quantity * unitPrice) <= Math.max(0.03, total * 0.005) ? "matches" : "mismatch";
          quotes.push({
            productName, description: description.slice(0, 1800), quantity, unitPrice, totalPrice: total,
            currency: priceHeader.includes("usd") || [...headers.values()].join(" ").includes("usd") ? "USD" : "未注明",
            tradeTerm: term, status: "customer_quote_document", deliveryVerified: false, arithmeticCheck: crossCheck,
            sourceId, sheet: sheetName,
            cells: {
              description: previousDescriptionCell ? previousDescriptionCell.coordinate : null,
              quantity: quantityCell ? quantityCell.coordinate : null,
              unitPrice: priceCell.coordinate,
              totalPrice: matchingTotal ? matchingTotal.coordinate : null,
            },
          });
        }
      }
      if (quotes.length) break;
    }
  }
  return quotes;
}
function findCostNotes(book, sourceId) {
  const notes = [];
  for (const [sheet, sheetName] of book.SheetNames.slice(0, 4).map((name) => [book.Sheets[name], name])) {
    for (const row of sheetRows(sheet, 90, 25)) {
      const matches = [...row.values()].filter((cell) => typeof cell.value === "string" && COST_LABEL.test(cell.value));
      if (!matches.length) continue;
      const excerpt = [...row.values()].map((cell) => clean(cell.value, 170)).join(" · ").slice(0, 360);
      if (!/\d/.test(excerpt)) continue;
      notes.push({ sourceId, sheet: sheetName, cell: matches[0].coordinate, excerpt });
      if (notes.length >= 10) return notes;
    }
  }
  return notes;
}

function manualCases() {
  const groups = new Map();
  let htmlNamedXlsx = 0;
  const archive = new AdmZip(ARCHIVE);
  const zipEntries = archive.getEntries();
  for (let archiveIndex = 0; archiveIndex < zipEntries.length; archiveIndex++) {
    const entry = zipEntries[archiveIndex];
    const zipPath = decodeZipName(entry.entryName);
    if (!entry.isDirectory && zipPath.toLowerCase().endsWith(".xlsx") && !zipPath.startsWith("__MACOSX/")) {
      if (!entry.getData().subarray(0, 4).equals(PK_MAGIC)) htmlNamedXlsx += 1;
    }
    if (entry.isDirectory || !zipPath.toLowerCase().endsWith(".xlsx") || !zipPath.includes(RFQ_INFO_MARKER) || zipPath.startsWith("__MACOSX/")) continue;
    const tail = zipPath.split(RFQ_INFO_MARKER)[1];
    const group = tail.includes("/") ? tail.split("/")[0] : tail.replace(/\.[^.]+$/, "");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ entry, zipPath, archiveIndex });
  }

  const cases = [];
  for (const group of [...groups.keys()].sort()) {
    const entries = groups.get(group);
    const sources = [];
    const quotes = [];
    const costNotes = [];
    for (const { entry, zipPath, archiveIndex } of entries) {
      const sourceId = "file-" + digest(zipPath);
      const isPi = PI_NAME.test(path.basename(zipPath));
      const raw = entry.getData();
      const status = raw.subarray(0, 4).equals(PK_MAGIC) ? "readable_xlsx" : "html_named_xlsx";
      sources.push({ id: sourceId, kind: "archive_workbook", archiveEntry: entry.entryName, archiveIndex, path: zipPath,
        name: path.basename(zipPath), role: isPi ? "customer_quote" : "working_material", status });
      let book = null;
      try {
        book = workbook(raw);
      } catch (error) {
        sources[sources.length - 1].status = `read_error:${error.name ?? "Error"}`;
      }
      if (!book) continue;
      if (isPi) quotes.push(...findQuotes(book, sourceId));
      else costNotes.push(...findCostNotes(book, sourceId));
    }
    const firstQuote = quotes[0] ?? null;
    const title = firstQuote ? firstQuote.productName : group.replace(/^202[0-9][.\-_][0-9]+[.\-_][0-9]+/, "").trim();
    cases.push({
      id: "manual-" + digest(group),
      sourceType: "manual_workbooks",
      title: title || "未提取商品名称",
      category: category(title + " " + group),
      buyer: null,
      country: null,
      date: dateFromName(group),
      status: quotes.length ? "customer_quote_document" : "working_material_only",
      statusLabel: quotes.length ? "客户报价单记录 · 发送未验证" : "人工材料 · 未提取到客户报价",
      summary: `${entries.length} 份原始表格；提取到 ${quotes.length} 条客户报价明细。`,
      sourceGroup: group,
      quotes,
      costNotes: costNotes.slice(0, 18),
      sources,
      analysis: null,
      rationale: {
        kind: "documentary_trace",
        summary: "报价来自客户 PI 表格。工厂成本线索如有展示，仍需逐条核对日期、规格、税运及供应商。",
        evidence: ["报价明细保留工作表与单元格位置", "PI 是否发送及买家是否接受均未验证"],
      },
      rfq: null,
      images: [],
    });
  }
  return [cases, htmlNamedXlsx];
}

function listFiles(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (filter(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function agentCases() {
  const rationales = {};
  for (const file of listFiles(path.join(DATA, "runs"), (name) => name.startsWith("case-rfq-") && name.endsWith(".json"))) {
    const item = readJson(file);
    const key = item?.record?.rfq?.id;
    if (key && item?.quoteRationale?.output) rationales[key] = item.quoteRationale.output;
  }
  for (const file of listFiles(path.join(DATA, "runs"), (name) => name === "AGENT_QUOTE_RATIONALES.json")) {
    for (const item of readJson(file)?.cases ?? []) {
      if (item.output) rationales[item.rfqId] = item.output;
    }
  }

  const latest = new Map();
  for (const file of listFiles(path.join(DATA, "drafts"), (name) => name.endsWith(".json"))) {
    const item = readJson(file);
    const key = item?.rfq?.id;
    if (!key) continue;
    if (!latest.has(key) || String(item.createdAt ?? "") > String(latest.get(key).item.createdAt ?? "")) {
      latest.set(key, { item, file });
    }
  }

  const cases = [];
  for (const [key, { item, file }] of latest) {
    const { rfq, analysis, quote } = item;
    const imagePaths = [];
    for (const raw of rfq.imagePaths ?? []) {
      const imagePath = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
      const relative = path.relative(DATA, path.resolve(imagePath));
      if (relative.split(path.sep)[0] === "rfqs" && fs.existsSync(imagePath)) imagePaths.push(relative.split(path.sep).join("/"));
    }
    const modelQuote = [];
    if (["quoted", "conditional_quote"].includes(quote.status)) {
      modelQuote.push({
        productName: rfq.title ?? null, description: quote.basis ?? null,
        quantity: quote.quantity ?? null, unitPrice: quote.unitPriceUsd ?? null,
        totalPrice: quote.totalUsd ?? null, currency: quote.currency ?? null,
        tradeTerm: quote.tradeTerm ?? null, status: quote.status,
        deliveryVerified: item.submission?.status === "submitted",
        arithmeticCheck: "rules_engine", sourceId: "pricing-rules", sheet: null, cells: null,
      });
    }
    const outcome = item.submission?.status ?? null;
    cases.push({
      id: key,
      sourceType: "agent_run",
      title: rfq.title || "未命名 RFQ",
      category: category(`${rfq.title ?? ""} ${analysis.categoryId ?? ""}`),
      categoryId: analysis.categoryId ?? null,
      buyer: rfq.buyerText ?? null, country: rfq.country ?? null,
      date: String(item.createdAt ?? "").slice(0, 10),
      status: quote.status,
      statusLabel: quote.status === "conditional_quote" ? "条件报价 · 未发送"
        : quote.status === "quoted" && outcome !== "submitted" ? "规则报价 · 未发送"
        : outcome === "submitted" ? "已提交" : "需要人工复核",
      summary: rfq.summary ?? "",
      quotes: modelQuote,
      costNotes: [],
      sources: [{ id: "draft-" + digest(String(file)), kind: "local_json",
        path: path.relative(ROOT, file), name: path.basename(file), role: "agent_record", status: "readable_json" }],
      analysis: {
        fields: analysis.fields ?? {}, confidence: analysis.confidence ?? null,
        missingRequired: analysis.missingRequired ?? [], riskFlags: analysis.riskFlags ?? [],
        buyerQuestions: analysis.buyerQuestions ?? [], recommendation: analysis.recommendation ?? null,
        imageReadStatus: analysis.imageReadStatus ?? null,
        quoteReason: quote.reason ?? null, quoteMissingFields: quote.missingFields ?? [],
        submissionStatus: outcome,
      },
      rationale: key in rationales ? { kind: "auditable_decision", ...rationales[key] }
        : { kind: "rule_and_agent_summary", summary: quote.reason || "按版本化规则生成条件报价。", evidence: analysis.riskFlags ?? [] },
      rfq: { quantity: rfq.quantity ?? null, quantityText: rfq.quantityText ?? null,
        detailText: rfq.detailText ?? null, detailUrl: rfq.detailUrl ?? null,
        collectedAt: rfq.collectedAt ?? null, remainingQuotes: rfq.remainingQuotes ?? null },
      images: imagePaths,
    });
  }
  return cases;
}

function main() {
  const [manual, htmlCount] = manualCases();
  const agent = agentCases();
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const cases = [...manual, ...agent].sort((a, b) => -cmp(a.date ?? "", b.date ?? "") || -cmp(a.id, b.id));
  const counter = {};
  for (const item of cases) counter[item.status] = (counter[item.status] ?? 0) + 1;
  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    archivePath: path.relative(ROOT, ARCHIVE),
    counts: {
      cases: cases.length, agentCases: agent.length, manualCases: manual.length,
      manualQuoteCases: manual.filter((c) => c.quotes.length).length,
      manualQuoteLines: manual.reduce((sum, c) => sum + c.quotes.length, 0),
      agentRationaleCases: agent.filter((c) => c.rationale.kind === "auditable_decision").length,
      htmlNamedXlsx: htmlCount,
      statuses: counter,
    },
    cases,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(`${OUTPUT}.tmp`, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.renameSync(`${OUTPUT}.tmp`, OUTPUT);
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), ...catalog.counts }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export { findQuotes, findCostNotes };
