import assert from "node:assert/strict";
import test from "node:test";
import { hasDefiniteQuote } from "../src/quote-visibility.js";

const record = () => ({
  quote: { status: "quoted", currency: "USD", quantity: 500, unitPriceUsd: 0.75,
    setupUsd: 0, totalUsd: 375, tradeTerm: "EXW" },
  draft: { productName: "Carton", productDetails: "B flute, 500 pcs",
    buyerMessage: "Quoted USD 0.75 per piece, 500 pieces." }
});

test("only a confirmed rule price with complete buyer-facing content enters the quote list", () => {
  assert.equal(hasDefiniteQuote(record()), true);
  for (const status of ["needs_review", "conditional_quote"]) {
    const item = record(); item.quote.status = status;
    assert.equal(hasDefiniteQuote(item), false);
  }
  const noDraft = record(); delete noDraft.draft;
  assert.equal(hasDefiniteQuote(noDraft), false);
  const blankMessage = record(); blankMessage.draft.buyerMessage = "   ";
  assert.equal(hasDefiniteQuote(blankMessage), false);
  const inconsistent = record(); inconsistent.quote.totalUsd = 300;
  assert.equal(hasDefiniteQuote(inconsistent), false);
  const unresolved = record(); unresolved.analysis = { missingRequired: ["gsm"] };
  assert.equal(hasDefiniteQuote(unresolved), false);
});
