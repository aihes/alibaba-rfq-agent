import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectDir } from "./config.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ensureDataDirs() {
  for (const dir of ["data", "data/rfqs", "data/drafts"]) {
    fs.mkdirSync(path.join(projectDir, dir), { recursive: true });
  }
}

export function loadState() {
  ensureDataDirs();
  const statePath = path.join(projectDir, "data/state.json");
  if (!fs.existsSync(statePath)) return { seen: {} };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function saveState(state) {
  ensureDataDirs();
  const statePath = path.join(projectDir, "data/state.json");
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function appendJsonl(relativePath, value) {
  ensureDataDirs();
  fs.appendFileSync(path.join(projectDir, relativePath), `${JSON.stringify(value)}\n`);
}

export function writeJson(relativePath, value) {
  ensureDataDirs();
  const outputPath = path.join(projectDir, relativePath);
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
  return outputPath;
}

export function roundUp(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.ceil((value - Number.EPSILON) * factor) / factor;
}

export function parseUuid(url = "") {
  try {
    return new URL(url).searchParams.get("uuid") || "";
  } catch {
    return "";
  }
}

export function parseRfqId(...urls) {
  const parsed = urls.flatMap((value) => {
    try {
      return [new URL(value)];
    } catch {
      return [];
    }
  });
  for (const key of ["p", "enc_r_id", "uuid"]) {
    const value = parsed.map((url) => url.searchParams.get(key)).find(Boolean);
    if (value) return value;
  }
  return "";
}

export function stableRfqId(rfq = {}) {
  const normalized = [
    rfq.title,
    rfq.summary,
    rfq.quantityText,
    rfq.countryText,
    rfq.buyerText,
    rfq.cardImageUrl
  ].map((value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase());
  if (!normalized.some(Boolean)) return "";
  return `rfq-${createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24)}`;
}

export function parseNumber(text = "") {
  const match = String(text).replaceAll(",", "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function sanitizeRfqText(text = "") {
  return String(text)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email removed]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, "[phone removed]")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(contact|联系人|company name|公司名称)\s*[:：]/i.test(line))
    .join("\n")
    .slice(0, 10000);
}

export function extractJson(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude did not return a JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}
