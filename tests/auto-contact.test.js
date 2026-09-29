import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_CONTACT_ACK, evaluateAutoContact } from "../src/auto-contact.js";
import { quoteRiskFingerprint } from "../src/quote-visibility.js";

function eligibleFixture() {
  return {
    rfq: {
      id: "rfq-eligible",
      quoteUrl: "https://sourcing.alibaba.com/rfq_quotation_post.htm?uuid=rfq-eligible",
      remainingQuotes: 4
    },
    analysis: {
      categoryId: "tumbler_40oz",
      confidence: 0.96,
      recommendation: "quote",
      missingRequired: [],
      riskFlags: []
    },
    quote: { status: "quoted", totalUsd: 1295 },
    draft: { buyerMessage: "Guarded quote", port: "Verified Factory City" }
  };
}

function submitConfig() {
  return {
    autoContactMode: "submit",
    autoContactCategories: ["tumbler_40oz"],
    autoContactMinConfidence: 0.92,
    autoContactDailyLimit: 3,
    autoContactMaxTotalUsd: 2500,
    autoContactAck: AUTO_CONTACT_ACK,
    allowLiveSubmit: true,
    autoContactAllowFixtureUrls: false,
    quotePort: "Verified Factory City"
  };
}

test("allows only a complete, allowlisted and explicitly enabled automatic quote", () => {
  const result = evaluateAutoContact(submitConfig(), eligibleFixture(), { attempts: {} }, new Date("2026-09-17T03:00:00Z"));
  assert.equal(result.eligible, true);
  assert.equal(result.mode, "submit");
});

test("rejects conditional quotes and repeat attempts", () => {
  const record = eligibleFixture();
  record.quote.status = "conditional_quote";
  const result = evaluateAutoContact(submitConfig(), record, {
    attempts: { "rfq-eligible": { status: "needs_manual_review", date: "2026-09-17" } }
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("non-conditional")));
  assert.ok(result.reasons.some((reason) => reason.includes("already")));
});

test("requires the explicit automatic-send acknowledgement", () => {
  const config = submitConfig();
  config.autoContactAck = "";
  const result = evaluateAutoContact(config, eligibleFixture(), { attempts: {} });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("AUTO_CONTACT_ACK")));
});

test("documented risks are accepted only for an exact manually confirmed RFQ quote", () => {
  const now = new Date("2026-09-29T09:00:00Z");
  const record = eligibleFixture();
  record.analysis.riskFlags = ["Logo artwork requires confirmation"];
  record.analysis.confidence = 0.85;
  record.quote.priceEvidence = { kind: "operator_verified_sell_price", rfqId: record.rfq.id,
    approvedAt: now.toISOString(), validThrough: "2026-10-05",
    riskReview: { flags: [...record.analysis.riskFlags], reviewedAt: now.toISOString(),
      note: "Buyer confirmed one-color logo; supplier's current EXW price includes that printing." } };
  record.quote.priceEvidence.riskReview.fingerprint = quoteRiskFingerprint(record);
  const automatic = evaluateAutoContact(submitConfig(), record, { attempts: {} }, now);
  assert.equal(automatic.eligible, false);
  assert.ok(automatic.reasons.includes("Risk flags require human review"));
  const manual = { ...submitConfig(), manualOperatorQuote: true };
  assert.equal(evaluateAutoContact(manual, record, { attempts: {} }, now).eligible, true);
  assert.ok(evaluateAutoContact(submitConfig(), record, { attempts: {} }, now).reasons
    .includes("Analysis confidence is below the automatic-contact threshold"));
  assert.equal(evaluateAutoContact(manual, record, { attempts: {} }, now).eligible, true);
  record.analysis.riskFlags.push("New packaging condition was added");
  assert.ok(evaluateAutoContact(manual, record, { attempts: {} }, now).reasons.includes("Risk flags require human review"));
  record.analysis.riskFlags.pop();
  record.analysis.confidence = 0.96;
  record.quote.unitPriceUsd = 8.7;
  assert.ok(evaluateAutoContact(manual, record, { attempts: {} }, now).reasons.includes("Risk flags require human review"));
  record.quote.unitPriceUsd = undefined;
  record.quote.priceEvidence.rfqId = "another-rfq";
  assert.ok(evaluateAutoContact(manual, record, { attempts: {} }, now).reasons.includes("Risk flags require human review"));
  record.quote.priceEvidence.rfqId = record.rfq.id;
  record.analysis.missingRequired = ["Unconfirmed quantity split"];
  assert.ok(evaluateAutoContact(manual, record, { attempts: {} }, now).reasons.includes("Required fields are missing"));
});
