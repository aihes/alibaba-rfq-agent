import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approveRfqPrice } from "../src/price-approval.js";
import { findVerifiedPriceLeads, loadVerifiedPriceLeads } from "../src/price-memory.js";

const now = new Date("2026-09-29T09:00:00Z");
const fields = { quantity: 1000, widthMm: 180, heightMm: 240, bottomMm: 80,
  gsm: 120, material: "kraft paper", printing: "one color" };

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-price-memory-"));
  const directory = path.join(root, "data/drafts");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "original.json");
  const record = { rfq: { id: "old-rfq", title: "Kraft shopping bag", quantity: 1000 },
    analysis: { categoryId: "paper_shopping_bag", confidence: 0.98, fields,
      recommendation: "quote", missingRequired: [], riskFlags: [], buyerQuestions: [] },
    quote: { status: "needs_review", reason: "No current sell price" },
    submission: { status: "skipped" } };
  fs.writeFileSync(file, JSON.stringify(record));
  const reviewHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  approveRfqPrice(root, { id: "original", rfqId: "old-rfq", reviewHash, unitPriceUsd: 0.24,
    validThrough: "2026-10-15", sourceNote: "Current approved supplier selling price, quote 2026-09-29",
    specification: "Kraft paper bag, 180x240x80 mm, 120 gsm, one color, 1000 pcs EXW",
    approved: true }, { now });
  return { root, directory, file };
}

test("current approved price is a same-spec review lead for another RFQ, never an automatic quote", () => {
  const { root } = workspace();
  try {
    const leads = loadVerifiedPriceLeads(root, now);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].rfqId, "old-rfq");
    assert.equal(leads[0].unitPriceUsd, 0.24);
    const analysis = { categoryId: "paper_shopping_bag", fields: { ...fields, material: " Kraft  Paper " } };
    const matched = findVerifiedPriceLeads({ id: "new-rfq", quantity: 1000 }, analysis, leads, now);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].sourceNote.includes("supplier"), true);
    assert.equal(matched[0].status, undefined);
    assert.deepEqual(findVerifiedPriceLeads({ id: "old-rfq", quantity: 1000 }, analysis, leads, now), []);
    assert.deepEqual(findVerifiedPriceLeads({ id: "new-rfq", quantity: 500 },
      { ...analysis, fields: { ...analysis.fields, quantity: 500 } }, leads, now), []);
    assert.deepEqual(findVerifiedPriceLeads({ id: "new-rfq", quantity: 1000 },
      { ...analysis, fields: { ...analysis.fields, gsm: 150 } }, leads, now), []);
    assert.deepEqual(findVerifiedPriceLeads({ id: "new-rfq", quantity: 1000 },
      { ...analysis, fields: { ...analysis.fields, printing: null } }, leads, now), []);
    assert.deepEqual(findVerifiedPriceLeads({ id: "new-rfq", quantity: 1000 },
      { ...analysis, categoryId: "cloth_bag" }, leads, now), []);
    assert.deepEqual(loadVerifiedPriceLeads(root, new Date("2026-10-16T00:00:00Z")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incomplete or altered approvals and symlinked files cannot become price leads", () => {
  const { root, directory, file } = workspace();
  try {
    const approved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const change of [
      (record) => { record.quote.totalUsd = 10; },
      (record) => { record.analysis.fields.printing = null; },
      (record) => { record.quote.priceEvidence.rfqId = "someone-else"; },
      (record) => { record.quote.priceEvidence.kind = "historical_customer_quote"; },
      (record) => { record.quote.priceEvidence.sourceNote = "old PI"; }
    ]) {
      const altered = structuredClone(approved);
      change(altered);
      fs.writeFileSync(file, JSON.stringify(altered));
      assert.deepEqual(loadVerifiedPriceLeads(root, now), []);
    }
    fs.writeFileSync(file, JSON.stringify(approved));
    const external = path.join(root, "external.json");
    fs.writeFileSync(external, JSON.stringify(approved));
    fs.symlinkSync(external, path.join(directory, "linked.json"));
    assert.equal(loadVerifiedPriceLeads(root, now).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
