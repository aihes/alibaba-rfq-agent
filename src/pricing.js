import { roundUp } from "./utils.js";

const closeTo = (actual, expected, tolerance) => actual != null && Math.abs(actual - expected) <= tolerance;

function needsReview(categoryId, reason, analysis, rule) {
  return {
    status: "needs_review",
    categoryId,
    reason,
    missingFields: (rule?.requiredFields || []).filter((field) => analysis.fields?.[field] == null)
  };
}

export function priceRfq(rfq, analysis, pricing) {
  const categoryId = analysis.categoryId;
  const rule = pricing.rules[categoryId];
  if (!rule) return needsReview(categoryId, "This category has no normalized deterministic pricing rule yet", analysis, rule);
  const quantity = Number(analysis.fields?.quantity || rfq.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return needsReview(categoryId, "Quantity is missing or invalid", analysis, rule);

  if (categoryId === "kraft_food_bag") {
    const fields = analysis.fields || {};
    const specMatch = closeTo(fields.widthMm, 110, 10)
      && closeTo(fields.heightMm, 110, 10)
      && closeTo(fields.bottomMm, 50, 10)
      && closeTo(fields.gsm, 80, 10)
      && /kraft/i.test(fields.material || "")
      && fields.greaseproof === true;
    if (!specMatch) return needsReview(categoryId, "RFQ is in-category but outside the validated food-bag scenario or lacks explicit dimensions", analysis, rule);
    if (quantity !== rule.baseQty) return needsReview(categoryId, `Only the validated quantity of ${rule.baseQty} pcs may be auto-priced`, analysis, rule);
    const unitPriceUsd = rule.unitPriceUsd;
    const setupUsd = rule.setupUsd;
    return makeQuote(categoryId, quantity, unitPriceUsd, setupUsd, pricing, false, rule.validatedScenario);
  }

  if (categoryId === "tumbler_40oz") {
    const fields = analysis.fields || {};
    const specMatch = closeTo(fields.capacityOz, 40, 1)
      && /304|18\/8/i.test(fields.material || "")
      && /360|full wrap|heat transfer/i.test(fields.printing || "");
    if (!specMatch) return needsReview(categoryId, "RFQ is in-category but does not explicitly match the validated 40oz/304/full-wrap scenario", analysis, rule);
    if (quantity !== rule.baseQty) return needsReview(categoryId, `Only the validated quantity of ${rule.baseQty} pcs may be auto-priced`, analysis, rule);
    return makeQuote(categoryId, quantity, rule.unitPriceUsd, rule.setupUsd, pricing, false, rule.validatedScenario);
  }

  if (categoryId === "corrugated_rsc") {
    const fields = analysis.fields || {};
    const dimensionsMatch = closeTo(fields.lengthMm, 310, 8)
      && closeTo(fields.widthMm, 235, 8)
      && closeTo(fields.heightMm, 165, 8);
    const fluteMatch = fields.flute == null || fields.flute === "B";
    const printMatch = fields.printing == null || /none|no print/i.test(fields.printing);
    const tier = rule.exactTiers[String(quantity)];
    if (!dimensionsMatch || !fluteMatch || !printMatch || !tier) {
      return needsReview(categoryId, "Only the validated 310x235x165mm, B-flute, unprinted 500/1000-piece scenario is currently normalized", analysis, rule);
    }
    return makeQuote(categoryId, quantity, tier.unitPriceUsd, tier.setupUsd, pricing, tier.conditional, rule.validatedScenario);
  }

  return needsReview(categoryId, "No executable pricing adapter", analysis, rule);
}

function makeQuote(categoryId, quantity, unitPriceUsd, setupUsd, pricing, conditional, basis) {
  const totalUsd = roundUp(quantity * unitPriceUsd + setupUsd, 2);
  return {
    status: conditional ? "conditional_quote" : "quoted",
    categoryId,
    quantity,
    currency: pricing.currency,
    tradeTerm: pricing.tradeTerm,
    unitPriceUsd,
    setupUsd,
    totalUsd,
    freightIncluded: false,
    taxIncluded: false,
    validityDays: 7,
    rulesVersion: pricing.rulesVersion,
    basis,
    warning: "Indicative model quote. Supplier cost, freight, tax, certification and artwork must be confirmed before submission."
  };
}
