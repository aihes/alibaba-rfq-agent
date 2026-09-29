import { draftWithClaude } from "./claude.js";

const names = {
  kraft_food_bag: "Custom Greaseproof Kraft Paper Food Bag",
  tumbler_40oz: "Custom 40oz 304 Stainless Steel Tumbler",
  corrugated_rsc: "Custom 0201 Corrugated Shipping Carton"
};

export function draftLocally(rfq, analysis, quote) {
  const feeLine = quote.setupUsd > 0 ? `One-time setup/testing charge: USD ${quote.setupUsd.toFixed(2)}. ` : "";
  const unitPrice = Number(quote.unitPriceUsd).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const exclusions = quote.priceEvidence?.kind === "operator_verified_sell_price"
    ? "Freight and import tax are excluded. Samples and certification must be confirmed against the agreed specification."
    : "International freight, tax and certification are excluded.";
  const validThrough = quote.priceEvidence?.validThrough
    ? `This offer is valid through ${quote.priceEvidence.validThrough}.`
    : Number.isFinite(quote.validityDays) ? `This offer is valid for ${quote.validityDays} days.` : "";
  const questions = (analysis.buyerQuestions || []).slice(0, 3);
  const questionText = questions.length ? `\n\nPlease confirm:\n- ${questions.join("\n- ")}` : "";
  const reviewedSpecs = quote.priceEvidence?.specReview?.entries || [];
  const confirmed = reviewedSpecs.filter((entry) => entry.source === "buyer_confirmed")
    .map((entry) => `${entry.field}: ${entry.value}`);
  const proposed = reviewedSpecs.filter((entry) => entry.source === "supplier_proposal")
    .map((entry) => `${entry.field}: ${entry.value}`);
  const specText = [
    confirmed.length ? `Buyer-confirmed specifications for this offer: ${confirmed.join("; ")}.` : "",
    proposed.length ? `Our proposed specifications for this offer, subject to your acceptance: ${proposed.join("; ")}.` : ""
  ].filter(Boolean).join(" ");
  return {
    productName: names[quote.categoryId] || rfq.title.slice(0, 120),
    productDetails: `${quote.basis}. ${specText} Quantity: ${quote.quantity} pcs. Indicative ${quote.tradeTerm} price: USD ${unitPrice}/pc. ${feeLine}${validThrough} ${exclusions}`,
    buyerMessage: `Hello,\n\nThank you for your RFQ. Based on the specification below and quantity, our indicative ${quote.tradeTerm} offer is USD ${unitPrice} per piece for ${quote.quantity} pieces. ${specText} ${feeLine}The indicative total is USD ${quote.totalUsd.toFixed(2)}. ${validThrough} ${exclusions} Final production pricing is subject to artwork and specification confirmation.${questionText}\n\nBest regards,`,
    port: "",
    validityDays: quote.validityDays,
    sampleAvailable: false
  };
}

function containsNumber(text, expected) {
  return (String(text).match(/\d+(?:\.\d+)?/g) || []).some((token) => Math.abs(Number(token) - expected) < 0.0001);
}

export function normalizeGeneratedDraft(generated, fallback, config, quote) {
  const productName = typeof generated?.productName === "string" ? generated.productName.trim().slice(0, 120) : "";
  const productDetails = typeof generated?.productDetails === "string" ? generated.productDetails.trim().slice(0, 3000) : "";
  const buyerMessage = typeof generated?.buyerMessage === "string" ? generated.buyerMessage.trim().slice(0, 5000) : "";
  const combined = `${productDetails}\n${buyerMessage}`;
  const preservesQuote = productName
    && productDetails
    && buyerMessage
    && combined.toUpperCase().includes(quote.tradeTerm)
    && containsNumber(combined, quote.quantity)
    && containsNumber(combined, quote.unitPriceUsd);
  const wording = preservesQuote
    ? { ...generated, productName, productDetails, buyerMessage }
    : fallback;
  return {
    ...wording,
    port: config.quotePort || "",
    validityDays: quote.validityDays,
    sampleAvailable: false
  };
}

export async function createDraft(config, rfq, analysis, quote) {
  if (quote.status !== "quoted" && quote.status !== "conditional_quote") return null;
  const fallback = draftLocally(rfq, analysis, quote);
  let draft;
  if (config.useClaudeDraft && config.agentProvider !== "local-rules") {
    try {
      draft = normalizeGeneratedDraft(await draftWithClaude(config, rfq, analysis, quote), fallback, config, quote);
    } catch (error) {
      draft = fallback;
      draft.agentFallback = error.message;
    }
  } else {
    draft = fallback;
  }
  draft.port = config.quotePort || "";
  draft.validityDays = quote.validityDays;
  draft.sampleAvailable = false;
  return draft;
}
