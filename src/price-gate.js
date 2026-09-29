/**
 * Search cards are free to read, while opening details can trigger paid OCR and
 * the following analysis can call a paid model. Reject impossible price tiers
 * before either operation. This is only a conservative screen: passing it does
 * not make a quote valid; priceRfq still checks the full buyer specification.
 *
 * A missing card quantity stays in the scan results but is not silently sent
 * to a model. The operator can inspect that RFQ in the browser and retry
 * after the source has a usable quantity or a matching price rule is added.
 */
export function screenPriceCandidate(rfq, prefilter, pricing) {
  const categoryIds = (prefilter || []).map((match) => match.categoryId);
  const rules = categoryIds.map((id) => pricing?.rules?.[id]).filter(Boolean);
  if (!rules.length) return { eligible: false, reason: "no_price_rule" };

  const quantity = Number(rfq.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { eligible: false, reason: "unknown_quantity" };

  const matchingTier = rules.some((rule) => {
    if (rule.exactTiers) {
      const tier = rule.exactTiers[String(quantity)];
      return Boolean(tier && tier.conditional !== true && Number(tier.unitPriceUsd) > 0);
    }
    return rule.baseQty === quantity && Number(rule.unitPriceUsd) > 0;
  });
  return matchingTier ? { eligible: true, reason: null } : { eligible: false, reason: "no_definite_price_tier" };
}

export function screenPriceCandidates(entries, pricing) {
  const eligible = [], skipped = [];
  const reasons = { no_price_rule: 0, unknown_quantity: 0, no_definite_price_tier: 0 };
  for (const entry of entries) {
    const result = screenPriceCandidate(entry.rfq, entry.prefilter, pricing);
    if (result.eligible) eligible.push(entry);
    else { skipped.push({ ...entry, reason: result.reason }); reasons[result.reason]++; }
  }
  return { eligible, skipped, reasons };
}
