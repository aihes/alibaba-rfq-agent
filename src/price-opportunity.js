import fs from "node:fs";
import path from "node:path";
import { projectDir } from "./paths.js";

const familyPatterns = {
  kraft_food_bag: /\b(?:food|bakery|bread|greaseproof|sandwich|burger|fries)\b.{0,40}\bbags?\b|\bbags?\b.{0,40}\b(?:food|bakery|bread|greaseproof|sandwich|burger|fries)\b/i,
  tumbler_40oz: /\b(?:40\s*oz|tumbler|car cup|travel mug)\b/i,
  corrugated_rsc: /\b(?:corrugated|carton|cardboard|shipping box|rsc|0201)\b/i,
  paper_shopping_bag: /\b(?:paper|kraft|cardstock|cardboard)\b.{0,45}\b(?:bag|handbag)\b|\b(?:bag|handbag)\b.{0,45}\b(?:paper|kraft|cardstock|cardboard)\b/i,
  cloth_bag: /\b(?:cotton|canvas|cloth|non.?woven|polyester|jute)\b.{0,45}\bbag\b|\bbag\b.{0,45}\b(?:cotton|canvas|cloth|non.?woven|polyester|jute)\b/i,
  folding_carton: /\b(?:folding|paper|gift|drawer|tuck|pillow)\b.{0,35}\bbox\b|\bbox\b.{0,35}\b(?:folding|paper|gift|drawer|tuck|pillow)\b/i
};

function materialKind(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:304|18\/8)\b/.test(value)) return "stainless_304";
  if (/\bstainless/.test(value)) return "stainless";
  if (/\b(?:non.?woven)\b/.test(value)) return "nonwoven";
  if (/\b(?:canvas|cotton|polyester|jute)\b/.test(value)) return "fabric";
  if (/\b(?:corrugated)\b/.test(value)) return "corrugated";
  if (/\b(?:kraft|cowhide|cow paper|yellow cow)\b/.test(value)) return "kraft";
  if (/\b(?:white card|cardstock|card board)\b/.test(value)) return "cardstock";
  if (/\b(?:paper)\b/.test(value)) return "paper";
  return null;
}

function comparableMaterial(a, b) {
  if (a === b) return true;
  return new Set(["kraft", "cardstock", "paper"]).has(a) && b === "paper"
    || new Set(["kraft", "cardstock", "paper"]).has(b) && a === "paper"
    || (a === "stainless" && b === "stainless_304") || (b === "stainless" && a === "stainless_304");
}

function dimensionsMm(text) {
  const value = String(text || "");
  const labelled = value.match(/\bheight\)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[x×*]\s*\(?width\)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[x×*]\s*\(?depth\)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(mm|cm)\b/i);
  const match = labelled || value.match(/(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm|cm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm)\b/i);
  if (!match) return null;
  const scale = match[4].toLowerCase() === "cm" ? 10 : 1;
  return match.slice(1, 4).map((part) => Number(part) * scale).sort((a, b) => a - b);
}

function buyerDimensions(analysis) {
  const fields = analysis.fields || {};
  const values = [fields.lengthMm ?? fields.bottomMm, fields.widthMm, fields.heightMm].map(Number);
  return values.every((value) => Number.isFinite(value) && value > 0) ? values.sort((a, b) => a - b) : null;
}

function gramsPerSquareMeter(text) {
  const value = String(text || "");
  const match = value.match(/\b(\d{2,3})\s*(?:gsm|g\/m2|g\s*(?=\b|[,;\n]))/i);
  return match ? Number(match[1]) : null;
}

function referenceFamily(categoryId, text, productName, buyerText) {
  if (categoryId === "unsupported" || !familyPatterns[categoryId]?.test(text)) return false;
  if (categoryId === "kraft_food_bag" && !/\bbags?\b/i.test(productName)) return false;
  if (categoryId === "paper_shopping_bag" &&
    (!/\b(?:paper bag|handbag)\b/i.test(productName) || /\b(?:cotton|canvas|polyester|non.?woven|jute|plastic)\b/i.test(text))) return false;
  if (categoryId === "folding_carton" &&
    (!/\b(?:box|carton)\b/i.test(productName) || /\bbags?\b/i.test(buyerText) || /\b(?:corrugated|rsc|0201)\b/i.test(text))) return false;
  return true;
}

/** A broader research view for RFQs without a comparable quotation. These
 * examples may differ substantially in size, quantity or Incoterms. They are
 * never fed to priceRfq or draftLocally and cannot produce a quote amount. */
function historicalBenchmarks(rfq, analysis, references, now) {
  const categoryId = analysis.categoryId;
  const buyerText = `${rfq.title || ""} ${rfq.summary || ""}`;
  if (!familyPatterns[categoryId]?.test(buyerText)) return [];
  const quantity = Number(analysis.fields?.quantity || rfq.quantity);
  const buyerMaterial = materialKind(analysis.fields?.material || buyerText);
  const buyerSize = buyerDimensions(analysis);
  const buyerGsm = Number(analysis.fields?.gsm);
  const buyerCapacity = Number(analysis.fields?.capacityOz);
  return references.flatMap((ref) => {
    const ageDays = (now.getTime() - Date.parse(ref.date)) / 86_400_000;
    if (ageDays < -1 || ageDays > 180 || !Number.isFinite(quantity) || quantity <= 0 ||
      !referenceFamily(categoryId, `${ref.title || ""} ${ref.description || ""}`, ref.productName, buyerText)) return [];
    const material = materialKind(ref.description);
    if (["kraft_food_bag", "paper_shopping_bag", "tumbler_40oz"].includes(categoryId) && !material) return [];
    if (buyerMaterial && material && !comparableMaterial(buyerMaterial, material)) return [];
    const text = `${ref.title || ""} ${ref.description || ""}`;
    const capacity = Number(text.match(/\b(\d+(?:\.\d+)?)\s*oz\b/i)?.[1]);
    if (categoryId === "tumbler_40oz" && (!Number.isFinite(buyerCapacity) || buyerCapacity < 39 || buyerCapacity > 41 ||
      !Number.isFinite(capacity) || Math.abs(capacity - buyerCapacity) > 1)) return [];
    const ratio = Math.max(quantity, ref.quantity) / Math.min(quantity, ref.quantity);
    if (ratio > 100) return [];
    const size = dimensionsMm(ref.description);
    const gsm = gramsPerSquareMeter(ref.description);
    const differences = [];
    let score = 0;
    if (buyerMaterial && material) {
      if (buyerMaterial === material) score += 3;
      else { score += 1; differences.push(`材料不同或记录不够精确：历史 ${material}，本次 ${buyerMaterial}`); }
    }
    if (quantity === ref.quantity) score += 4;
    else {
      differences.push(`数量不同：历史 ${ref.quantity} 件，本次 ${quantity} 件`);
      score += ratio <= 2 ? 3 : ratio <= 5 ? 2 : ratio <= 20 ? 1 : 0;
    }
    if (buyerSize && size) {
      const gap = Math.max(...buyerSize.map((value, index) => Math.abs(value - size[index]) / Math.max(value, size[index])));
      if (gap <= 0.15) score += 4;
      else differences.push(`尺寸不同：历史 ${size.join("×")} mm，本次 ${buyerSize.join("×")} mm`);
    } else differences.push("尺寸未能双向核对");
    if (buyerGsm > 0 && gsm > 0) {
      if (Math.abs(buyerGsm - gsm) / Math.max(buyerGsm, gsm) <= 0.15) score += 2;
      else differences.push(`克重不同：历史 ${gsm} gsm，本次 ${buyerGsm} gsm`);
    }
    if (ref.tradeTerm === "EXW") score += 2;
    else differences.push(`历史条款为 ${ref.tradeTerm}，不能直接用作 EXW 价格`);
    differences.push("工艺、配件及现价未逐项核实");
    return [{ ...ref, score, differences }];
  }).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, 3);
}

/** Read only the locally generated catalog. Customer PI lines are historical
 * evidence, not approved current sell prices, so this never changes quote.status. */
export function loadHistoricalCaseQuotes(root = projectDir) {
  try {
    const file = path.join(root, "data/case-catalog/cases.json");
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    return (catalog.cases || []).filter((item) => item.sourceType === "manual_workbooks" && item.status === "customer_quote_document")
      .flatMap((item) => (item.quotes || []).flatMap((quote) => {
        const date = Date.parse(item.date || "");
        if (!Number.isFinite(date) || quote.currency !== "USD" || quote.arithmeticCheck !== "matches" ||
          !Number.isFinite(quote.quantity) || quote.quantity <= 0 ||
          !Number.isFinite(quote.unitPrice) || quote.unitPrice <= 0 ||
          !["EXW", "FOB", "DDP", "CIF"].includes(quote.tradeTerm) || !quote.sourceId) return [];
        return [{ caseId: item.id, title: item.title, category: item.category, date: item.date,
          productName: String(quote.productName || "").slice(0, 200),
          description: String(quote.description || "").slice(0, 1000), quantity: quote.quantity,
          unitPriceUsd: quote.unitPrice, tradeTerm: quote.tradeTerm,
          sourceId: quote.sourceId, sheet: quote.sheet || "", cell: quote.cells?.unitPrice || "" }];
      }));
  } catch { return []; }
}

export function assessPriceOpportunity(rfq, analysis, quote, references, now = new Date()) {
  if (quote.status === "quoted") return { status: "confirmed_price", references: [] };
  if (quote.status === "conditional_quote") return { status: "conditional_price", references: [] };
  const categoryId = analysis.categoryId;
  const buyerText = `${rfq.title || ""} ${rfq.summary || ""}`;
  const buyerMaterial = materialKind(analysis.fields?.material || buyerText);
  const dimensions = buyerDimensions(analysis);
  const quantity = Number(analysis.fields?.quantity || rfq.quantity);
  const capacity = Number(analysis.fields?.capacityOz);
  const candidates = [];
  if (categoryId !== "unsupported" && familyPatterns[categoryId]?.test(buyerText)) {
    for (const ref of references) {
      const ageDays = (now.getTime() - Date.parse(ref.date)) / 86_400_000;
      if (ageDays < -1 || ageDays > 180) continue;
      const text = `${ref.title || ""} ${ref.description || ""}`;
      if (!referenceFamily(categoryId, text, ref.productName, buyerText)) continue;
      const ratio = quantity > 0 ? Math.max(quantity, ref.quantity) / Math.min(quantity, ref.quantity) : Infinity;
      if (ratio > 5) continue;
      const refMaterial = materialKind(ref.description);
      if (buyerMaterial && refMaterial && !comparableMaterial(buyerMaterial, refMaterial)) continue;
      const refCapacity = Number(text.match(/\b(\d+(?:\.\d+)?)\s*oz\b/i)?.[1]);
      if (categoryId === "tumbler_40oz" && Number.isFinite(capacity) && capacity > 0 &&
        Number.isFinite(refCapacity) && refCapacity > 0 && Math.abs(capacity - refCapacity) > 1) continue;
      const refDimensions = dimensionsMm(ref.description);
      if (dimensions && refDimensions && dimensions.some((value, index) => Math.abs(value - refDimensions[index]) / Math.max(value, refDimensions[index]) > 0.15)) continue;
      const buyerGsm = Number(analysis.fields?.gsm);
      const refGsm = gramsPerSquareMeter(ref.description);
      if (buyerGsm > 0 && refGsm > 0 && Math.abs(buyerGsm - refGsm) / Math.max(buyerGsm, refGsm) > 0.15) continue;
      const signals = [];
      let score = 2;
      if (buyerMaterial && refMaterial) { signals.push("材料相近"); score += 2; }
      if (dimensions && refDimensions) { signals.push("尺寸相近"); score += 3; }
      if (buyerGsm > 0 && refGsm > 0) { signals.push("克重相近"); score += 2; }
      if (categoryId === "tumbler_40oz" && capacity > 0 && refCapacity > 0) { signals.push("容量相近"); score += 2; }
      if (quantity === ref.quantity) { signals.push("数量相同"); score += 2; }
      else if (ratio <= 2) { signals.push("数量接近，单价不可直接套用"); score += 1; }
      if (!signals.some((value) => /材料|尺寸|容量/.test(value))) continue;
      const differences = [];
      if (quantity !== ref.quantity) differences.push(`历史数量 ${ref.quantity}，本次 ${Number.isFinite(quantity) ? quantity : "未知"}`);
      if (ref.tradeTerm !== "EXW") differences.push(`历史条款 ${ref.tradeTerm}，不能直接当作 EXW 价格`);
      if (!dimensions || !refDimensions) differences.push("尺寸未能双向核对");
      differences.push("供应商现价与有效期未核实");
      candidates.push({ ...ref, score, signals, differences });
    }
  }
  candidates.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  const specificationReady = analysis.recommendation === "quote" && !(analysis.missingRequired || []).length;
  return { status: candidates.length ? "historical_reference" : "no_comparable_price",
    references: candidates.slice(0, 3),
    benchmarks: candidates.length ? [] : historicalBenchmarks(rfq, analysis, references, now),
    nextAction: candidates.length ? "核对买家规格并向供应商确认当前价格、数量阶梯和交货条款"
      : specificationReady ? "买家关键规格已提取；核实当前供应商售价、适用数量和贸易条款"
        : "补齐关键规格并取得当前供应商价格" };
}
