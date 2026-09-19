import { draftWithClaude } from "./claude.js";

const names = {
  kraft_food_bag: "Custom Greaseproof Kraft Paper Food Bag",
  tumbler_40oz: "Custom 40oz 304 Stainless Steel Tumbler",
  corrugated_rsc: "Custom 0201 Corrugated Shipping Carton"
};

export function draftLocally(rfq, analysis, quote) {
  const feeLine = quote.setupUsd > 0 ? `One-time setup/testing charge: USD ${quote.setupUsd.toFixed(2)}. ` : "";
  const questions = (analysis.buyerQuestions || []).slice(0, 3);
  const questionText = questions.length ? `\n\nPlease confirm:\n- ${questions.join("\n- ")}` : "";
  return {
    productName: names[quote.categoryId] || rfq.title.slice(0, 120),
    productDetails: `${quote.basis}. Quantity: ${quote.quantity} pcs. Indicative ${quote.tradeTerm} price: USD ${quote.unitPriceUsd.toFixed(3)}/pc. ${feeLine}International freight, tax and certification are excluded.`,
    buyerMessage: `Hello,\n\nThank you for your RFQ. Based on the stated specification and quantity, our indicative ${quote.tradeTerm} offer is USD ${quote.unitPriceUsd.toFixed(3)} per piece for ${quote.quantity} pieces. ${feeLine}The indicative total is USD ${quote.totalUsd.toFixed(2)}. Freight, import tax, certification and sample courier costs are not included. Final production pricing is subject to artwork and specification confirmation.${questionText}\n\nBest regards,`,
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
