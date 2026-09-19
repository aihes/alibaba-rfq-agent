import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, keywordPrefilter } from "../src/collector.js";
import { stableRfqId } from "../src/utils.js";

test("builds Alibaba search URL with SearchText", () => {
  const url = new URL(buildSearchUrl("https://sourcing.alibaba.com/rfq_search_list.htm", "kraft paper bag"));
  assert.equal(url.searchParams.get("SearchText"), "kraft paper bag");
});

test("prefilters a 40oz tumbler RFQ", () => {
  const supported = {
    tumbler_40oz: { keywords: ["40oz", "tumbler"] },
    corrugated_rsc: { keywords: ["corrugated", "carton"] }
  };
  const matches = keywordPrefilter({ title: "Custom 40oz stainless steel tumbler", summary: "304 steel full wrap" }, supported);
  assert.equal(matches[0].categoryId, "tumbler_40oz");
  assert.equal(matches[0].score, 2);
});

test("builds a stable RFQ id when Alibaba rotates opaque URL tokens", () => {
  const card = {
    title: "40oz tumbler",
    summary: "304 steel",
    quantityText: "100 pieces",
    countryText: "United States",
    buyerText: "Buyer A",
    cardImageUrl: "https://sc04.alicdn.com/kf/product.jpg"
  };
  const first = stableRfqId({ ...card, detailUrl: "https://sourcing.alibaba.com/rfq_detail.htm?p=opaque-first&uuid=repeated" });
  const second = stableRfqId({ ...card, detailUrl: "https://sourcing.alibaba.com/rfq_detail.htm?p=opaque-second&uuid=also-rotated" });
  const different = stableRfqId({ ...card, quantityText: "200 pieces" });
  assert.equal(first, second);
  assert.notEqual(first, different);
});
