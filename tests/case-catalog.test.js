import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { findQuotes } from "../scripts/build_case_catalog.mjs";

function bookFromRows(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "PI");
  return book;
}

test("keeps trade terms and continuation tiers separate", () => {
  const book = bookFromRows([
    ["PICTURE OF PRODUCT", "DESCRIPTION OF GOODS", "Quantity (PCS)", "FOB price (USD)", "DDP price (USD)", "FOB TOTAL PRICE (USD)", "DDP TOTAL PRICE (USD)"],
    [null, "Product Name: Handbag\nSize: 38 x 33 cm", 10000, 0.59, 0.87, 5900, 8700],
    [null, null, 20000, 0.54, 0.83, 10800, 16600],
  ]);

  const quotes = findQuotes(book, "fixture");

  assert.equal(quotes.length, 4);
  assert.deepEqual(quotes.map((quote) => [quote.quantity, quote.tradeTerm, quote.totalPrice]),
    [[10000, "FOB", 5900], [10000, "DDP", 8700], [20000, "FOB", 10800], [20000, "DDP", 16600]]);
  assert.ok(quotes.every((quote) => quote.arithmeticCheck === "matches"));
  assert.equal(quotes[quotes.length - 1].cells.description, "B2");
});
