import fs from "node:fs";
import path from "node:path";

// Price approval records are scoped to one RFQ. Reuse them only as a lead for
// another human price check; they must never enter priceRfq or auto-contact.
const requiredByCategory = {
  kraft_food_bag: ["widthMm", "heightMm", "bottomMm", "gsm", "material", "greaseproof"],
  tumbler_40oz: ["capacityOz", "material", "printing"],
  corrugated_rsc: ["lengthMm", "widthMm", "heightMm", "flute", "printing"],
  paper_shopping_bag: ["widthMm", "heightMm", "bottomMm", "gsm", "material", "printing"],
  cloth_bag: ["widthMm", "heightMm", "material", "printing"],
  folding_carton: ["lengthMm", "widthMm", "heightMm", "material", "printing"]
};

function normalized(value) {
  if (typeof value === "string") return value.trim().toLowerCase().replace(/\s+/g, " ");
  return value;
}

function sameFields(current, previous, keys) {
  return keys.every((key) => current[key] != null && previous[key] != null &&
    normalized(current[key]) === normalized(previous[key]));
}

function completeFields(fields, keys) {
  return keys.every((key) => fields[key] != null && fields[key] !== "");
}

/** Read only operator-approved prices from the user's own workspace. A prior
 * approval is never treated as a new approval, even when all extracted fields
 * match, because handles, artwork, packaging and supplier terms can differ. */
export function loadVerifiedPriceLeads(root, now = new Date()) {
  const directory = path.join(root, "data/drafts");
  if (!fs.existsSync(directory)) return [];
  const base = fs.realpathSync(directory);
  return fs.readdirSync(directory).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(name)).flatMap((name) => {
    try {
      const file = fs.realpathSync(path.join(directory, name));
      if (!file.startsWith(`${base}${path.sep}`)) return [];
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const evidence = record.quote?.priceEvidence;
      const expiry = Date.parse(`${evidence?.validThrough}T23:59:59.999Z`);
      const approvedAt = Date.parse(evidence?.approvedAt || "");
      if (evidence?.kind !== "operator_verified_sell_price" || evidence.rfqId !== record.rfq?.id ||
        record.quote?.status !== "quoted" || record.quote.currency !== "USD" || record.quote.tradeTerm !== "EXW" ||
        !Number.isFinite(record.quote.unitPriceUsd) || record.quote.unitPriceUsd <= 0 || record.quote.unitPriceUsd > 10000 ||
        record.quote.setupUsd !== 0 || !Number.isFinite(record.quote.totalUsd) ||
        !Number.isFinite(expiry) || expiry < now.getTime() || !Number.isFinite(approvedAt) || approvedAt > now.getTime() ||
        approvedAt < now.getTime() - 180 * 86_400_000 || !requiredByCategory[record.analysis?.categoryId]) return [];
      const fields = record.analysis.fields || {};
      const quantity = Number(fields.quantity || record.rfq.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 ||
        record.quote.quantity !== quantity || Math.abs(quantity * record.quote.unitPriceUsd - record.quote.totalUsd) > 0.011 ||
        String(evidence.sourceNote || "").trim().length < 15 || String(record.quote.basis || "").trim().length < 20 ||
        !completeFields(fields, requiredByCategory[record.analysis.categoryId])) return [];
      return [{ rfqId: record.rfq.id, title: String(record.rfq.title || "").slice(0, 200),
        categoryId: record.analysis.categoryId, fields, quantity,
        unitPriceUsd: record.quote.unitPriceUsd, currency: "USD", tradeTerm: "EXW",
        specification: String(record.quote.basis || "").slice(0, 1000),
        sourceNote: String(evidence.sourceNote || "").slice(0, 500),
        approvedAt: evidence.approvedAt, validThrough: evidence.validThrough }];
    } catch { return []; }
  });
}

export function findVerifiedPriceLeads(rfq, analysis, leads, now = new Date()) {
  const keys = requiredByCategory[analysis?.categoryId];
  if (!keys) return [];
  const fields = analysis.fields || {};
  const quantity = Number(fields.quantity || rfq.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !completeFields(fields, keys)) return [];
  return leads.filter((lead) => lead.rfqId !== rfq.id && lead.categoryId === analysis.categoryId &&
    lead.quantity === quantity && Date.parse(`${lead.validThrough}T23:59:59.999Z`) >= now.getTime() &&
    sameFields(fields, lead.fields || {}, keys))
    .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt)).slice(0, 3);
}
