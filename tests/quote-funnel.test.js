import assert from "node:assert/strict";
import test from "node:test";
import { summarizeQuoteFunnel } from "../src/quote-funnel.js";

test("quote funnel counts unique latest RFQs and keeps price need separate from definite quotes", () => {
  const rows = [
    { rfqId: "rfq-a", updatedAt: "2026-09-28T08:00:00Z", categoryId: "corrugated_rsc",
      recommendation: "quote", missingRequired: [], buyerQuantity: 500, riskFlags: ["needs artwork check"] },
    { rfqId: "rfq-a", updatedAt: "2026-09-29T08:00:00Z", categoryId: "corrugated_rsc",
      recommendation: "quote", missingRequired: ["flute"], buyerQuantity: 500, riskFlags: [] },
    { rfqId: "rfq-b", updatedAt: "2026-09-29T08:00:00Z", categoryId: "paper_shopping_bag",
      recommendation: "quote", missingRequired: [], buyerQuantity: 10000, riskFlags: ["review handle"] },
    { rfqId: "rfq-c", updatedAt: "2026-09-29T08:00:00Z", categoryId: "tumbler_40oz",
      recommendation: "review", missingRequired: [], buyerQuantity: 100, definiteQuote: true, submissionStatus: "submitted" },
    { rfqId: "rfq-d", updatedAt: "2026-09-29T08:00:00Z", categoryId: "unsupported", recommendation: "skip" },
    { rfqId: "rfq-e", updatedAt: "2026-09-29T08:00:00Z", categoryId: "kraft_food_bag",
      recommendation: "quote", buyerQuantity: 25000, archivedAt: "2026-09-29T09:00:00Z" }
  ];
  assert.deepEqual(summarizeQuoteFunnel(rows), {
    analyzed: 4, supported: 3, recommended: 3, buyerDetailsNeeded: 1,
    priority: 2, needsPrice: 1, riskReview: 1, priced: 1, submitted: 1
  });
});
