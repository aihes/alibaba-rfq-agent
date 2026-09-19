import assert from "node:assert/strict";
import test from "node:test";
import { buildQuoteRationaleRequest } from "../src/claude.js";

test("quote rationale request preserves deterministic price and policy boundary", () => {
  const config = {
    pricing: {
      currency: "USD",
      tradeTerm: "EXW",
      rulesVersion: "test-v1",
      rules: {
        corrugated_rsc: {
          validatedScenario: "test scenario",
          exactTiers: { "500": { unitPriceUsd: 0.99, setupUsd: 0, conditional: true } }
        }
      }
    }
  };
  const rfq = { title: "Box", summary: "500 boxes", detailText: "500 boxes", quantity: 500, country: "UA", imageAssets: [] };
  const analysis = { categoryId: "corrugated_rsc", fields: { quantity: 500 } };
  const quote = { status: "conditional_quote", quantity: 500, unitPriceUsd: 0.99, setupUsd: 0, totalUsd: 495 };

  const request = buildQuoteRationaleRequest(config, rfq, analysis, quote);

  assert.deepEqual(request.payload.deterministicQuote, quote);
  assert.equal(request.payload.pricingPolicy.rulesVersion, "test-v1");
  assert.equal(request.payload.pricingPolicy.categoryRule.validatedScenario, "test scenario");
  assert.match(request.prompt, /must not change it/);
  assert.match(request.prompt, /do not propose any numeric price/);
  assert.equal(request.maxTurns, 1);
});
