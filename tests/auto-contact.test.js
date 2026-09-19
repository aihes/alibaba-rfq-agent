import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_CONTACT_ACK, evaluateAutoContact } from "../src/auto-contact.js";

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
