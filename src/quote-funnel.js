/** Summarize the latest saved draft for each RFQ. The workbench may retain
 * earlier analyses of the same buyer request, so counting draft files would
 * overstate both the opportunity pool and the quote conversion rate. */
export function summarizeQuoteFunnel(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    if (!row?.rfqId) continue;
    const previous = latest.get(row.rfqId);
    if (!previous || Date.parse(row.updatedAt || "") > Date.parse(previous.updatedAt || ""))
      latest.set(row.rfqId, row);
  }
  const active = [...latest.values()].filter((row) => !row.archivedAt);
  const supported = active.filter((row) => row.categoryId && row.categoryId !== "unsupported");
  const recommended = supported.filter((row) => row.recommendation === "quote" || row.definiteQuote === true);
  const priority = recommended.filter((row) => row.definiteQuote === true ||
    (!(row.missingRequired || []).length && Number.isSafeInteger(Number(row.buyerQuantity)) && Number(row.buyerQuantity) > 0));
  const priced = active.filter((row) => row.definiteQuote === true);
  const submitted = priced.filter((row) => row.submissionStatus === "submitted");
  const needsPrice = priority.filter((row) => row.definiteQuote !== true);
  return {
    analyzed: active.length,
    supported: supported.length,
    recommended: recommended.length,
    buyerDetailsNeeded: recommended.length - priority.length,
    priority: priority.length,
    needsPrice: needsPrice.length,
    riskReview: needsPrice.filter((row) => (row.riskFlags || []).length > 0).length,
    priced: priced.length,
    submitted: submitted.length
  };
}
