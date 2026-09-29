import test from "node:test";
import assert from "node:assert/strict";
import { screenPriceCandidate, screenPriceCandidates } from "../src/price-gate.js";

const pricing = { rules: {
  bag: { baseQty: 25000, unitPriceUsd: 0.019 },
  carton: { exactTiers: {
    500: { unitPriceUsd: 0.99, conditional: true },
    1000: { unitPriceUsd: 0.60, conditional: false }
  } }
} };
const entry = (id, quantity, categories) => ({ rfq: { id, quantity },
  prefilter: categories.map((categoryId) => ({ categoryId, score: 1 })) });

test("price screen rejects unmatched, unknown and conditional tiers before paid detail work", () => {
  const entries = [entry("no-rule", 25000, ["unknown"]), entry("unknown-quantity", null, ["bag"]),
    entry("wrong-quantity", 100, ["bag"]), entry("conditional", 500, ["carton"]),
    entry("bag", 25000, ["bag"]), entry("carton", 1000, ["carton"])];
  const result = screenPriceCandidates(entries, pricing);
  assert.deepEqual(result.eligible.map(({ rfq }) => rfq.id), ["bag", "carton"]);
  assert.deepEqual(result.reasons, { no_price_rule: 1, unknown_quantity: 1, no_definite_price_tier: 2 });
  assert.equal(screenPriceCandidate({ quantity: 1000 }, [{ categoryId: "unknown" }, { categoryId: "carton" }], pricing).eligible, true);
});
