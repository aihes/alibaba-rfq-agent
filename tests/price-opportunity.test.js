import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessPriceOpportunity, loadHistoricalCaseQuotes } from "../src/price-opportunity.js";

test("historical customer quote stays a sourced review lead, never a sendable price", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-price-lead-"));
  try {
    fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), JSON.stringify({ cases: [
      { id: "past-1", title: "Paper Bag", date: "2026-09-22", sourceType: "manual_workbooks", status: "customer_quote_document", quotes: [
        { productName: "Paper Bag", description: "Product Name: Paper Bag; Material: 120g Kraft Paper", quantity: 5000, unitPrice: 0.22,
          currency: "USD", tradeTerm: "DDP", arithmeticCheck: "matches", sourceId: "source-1", sheet: "Sheet1", cells: { unitPrice: "D11" } },
        { productName: "Paper Bag", description: "Paper Bag", quantity: 5000, unitPrice: 0.08,
          currency: "USD", tradeTerm: "EXW", arithmeticCheck: "mismatch", sourceId: "bad-math" }
      ] },
      { id: "old", title: "Paper Bag", date: "2025-01-01", sourceType: "manual_workbooks", status: "customer_quote_document", quotes: [
        { productName: "Paper Bag", description: "Paper Bag Kraft Paper", quantity: 5000, unitPrice: 0.01,
          currency: "USD", tradeTerm: "EXW", arithmeticCheck: "matches", sourceId: "old-source" }
      ] }
    ] }));
    const refs = loadHistoricalCaseQuotes(root);
    assert.equal(refs.length, 2);
    const rfq = { title: "Custom kraft paper shopping bag", summary: "5000 pcs" };
    const analysis = { categoryId: "paper_shopping_bag", fields: { quantity: 5000, material: "kraft paper" } };
    const quote = { status: "needs_review", reason: "No current approved price" };
    const result = assessPriceOpportunity(rfq, analysis, quote, refs, new Date("2026-09-29T00:00:00Z"));
    assert.equal(result.status, "historical_reference");
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].unitPriceUsd, 0.22);
    assert.equal(result.references[0].sourceId, "source-1");
    assert.match(result.references[0].differences.join(" "), /DDP/);
    assert.equal(quote.status, "needs_review");
    assert.equal(quote.unitPriceUsd, undefined);
    const broader = assessPriceOpportunity(rfq,
      { ...analysis, fields: { ...analysis.fields, widthMm: 133, bottomMm: 95, heightMm: 203, gsm: 150 } },
      quote, [{ ...refs[0], description: "Product Name: Paper Bag; Size: (Height) 24.5 x (Width) 22 x (Depth) 11 cm; Material: 120g Kraft Paper" }],
      new Date("2026-09-29T00:00:00Z"));
    assert.equal(broader.status, "no_comparable_price");
    assert.equal(broader.references.length, 0);
    assert.equal(broader.benchmarks.length, 1);
    assert.match(broader.benchmarks[0].differences.join(" "), /尺寸不同/);
    assert.equal(quote.unitPriceUsd, undefined);
    assert.equal(assessPriceOpportunity({ title: "Food packaging bag" }, { categoryId: "kraft_food_bag", fields: { quantity: 5000, material: "kraft" } },
      quote, [{ ...refs[0], productName: "Sandwich Paper", description: "Kraft sandwich paper" }], new Date("2026-09-29T00:00:00Z")).status, "no_comparable_price");
    assert.match(assessPriceOpportunity(rfq, { ...analysis, recommendation: "quote", missingRequired: [] }, quote, [],
      new Date("2026-09-29T00:00:00Z")).nextAction, /核实当前供应商售价/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
