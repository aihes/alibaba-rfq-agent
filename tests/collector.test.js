import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, collectSearchPage, keywordPrefilter, nextSearchPageUrl } from "../src/collector.js";
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

test("collects every valid card across linked search pages without an order cap", async () => {
  const baseUrl = "https://sourcing.alibaba.com/rfq_search_list.htm";
  const firstUrl = buildSearchUrl(baseUrl, "kraft paper bag");
  const secondUrl = `${firstUrl}&page=2`;
  const makeCards = (start, count) => Array.from({ length: count }, (_unused, index) => {
    const number = start + index;
    return { title: `Kraft paper bag ${number}`, summary: "kraft paper bag", publishedText: "15 minutes ago", countryText: "United States",
      detailUrl: `https://sourcing.alibaba.com/rfq_detail.htm?id=${number}`, quantityText: `${number} pieces` };
  });
  const source = new Map([[firstUrl, makeCards(1, 13)], [secondUrl, makeCards(14, 7)]]);
  let currentUrl;
  const visited = [];
  const page = {
    async goto(url) { currentUrl = url; visited.push(url); },
    url() { return currentUrl; },
    locator() { return { first: () => ({ waitFor: async () => {} }), evaluateAll: async () => source.get(currentUrl) }; },
    async evaluateJson(expression) {
      if (expression.includes("const elements = Array.from(document.querySelectorAll")) {
        return { next: currentUrl === firstUrl ? [{ href: secondUrl }] : [], numeric: [] };
      }
      return { body: "", logoutEntry: true, loginEntry: false };
    }
  };
  const cards = await collectSearchPage(page, { searchBaseUrl: baseUrl, navigationDelayMs: 0 }, "kraft paper bag");
  assert.deepEqual(visited, [firstUrl, secondUrl]);
  assert.equal(cards.length, 20);
  assert.equal(new Set(cards.map(({ id }) => id)).size, 20);
  assert.equal(cards[19].title, "Kraft paper bag 20");
  assert.equal(cards[19].publishedText, "15 minutes ago");
  assert.ok(Number.isFinite(Date.parse(cards[19].publishedAt)));
  assert.ok(Number.isFinite(Date.parse(cards[19].collectedAt)));
});

test("numeric pagination uses the marked current page and rejects an unreadable next page", async () => {
  const url = buildSearchUrl("https://sourcing.alibaba.com/rfq_search_list.htm", "bag");
  const page = { evaluateJson: async () => ({ next: [], numeric: [
    { number: 1, active: true, href: "", disabled: false },
    { number: 2, active: false, href: `${url}&page=2`, disabled: false }
  ] }) };
  assert.equal(await nextSearchPageUrl(page, url, "bag"), `${url}&page=2`);
  page.evaluateJson = async () => ({ next: [{ href: "javascript:nextPage()" }], numeric: [] });
  await assert.rejects(nextSearchPageUrl(page, url, "bag"), /未完成全部扫描/);
});

test("follows Alibaba's actual pagination route and lowercase searchText", async () => {
  const first = buildSearchUrl("https://sourcing.alibaba.com/rfq_search_list.htm", "kraft paper food bag");
  const second = "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700&searchText=kraft+paper+food+bag&page=2";
  const page = { evaluateJson: async () => ({ next: [{ href: second }], numeric: [] }) };
  assert.equal(await nextSearchPageUrl(page, first, "kraft paper food bag"), second);
  page.evaluateJson = async () => ({ next: [{ href: second.replace("kraft+paper+food+bag", "unrelated+product") }], numeric: [] });
  await assert.rejects(nextSearchPageUrl(page, first, "kraft paper food bag"), /未完成全部扫描/);
});

test("stops on Alibaba's final page even when disabled next controls have no link", async () => {
  const last = "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?searchText=kraft+paper+food+bag&page=13";
  const page = { evaluateJson: async () => ({ next: [{ href: "" }], numeric: [], pageStatuses: [{ current: 13, total: 13 }] }) };
  assert.equal(await nextSearchPageUrl(page, last, "kraft paper food bag"), null);
});
