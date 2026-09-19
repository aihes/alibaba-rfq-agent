import { assertAlibabaReady } from "./browser.js";
import { captureRfqImages } from "./images.js";
import { parseNumber, sanitizeRfqText, sleep, stableRfqId } from "./utils.js";

export function buildSearchUrl(baseUrl, searchTerm) {
  const url = new URL(baseUrl);
  url.searchParams.set("SearchText", searchTerm);
  return url.toString();
}

export async function collectSearchPage(page, config, searchTerm) {
  const url = buildSearchUrl(config.searchBaseUrl, searchTerm);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator(".alife-bc-brh-rfq-list__item").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await assertAlibabaReady(page);

  const cards = await page.locator(".alife-bc-brh-rfq-list__item").evaluateAll((items, maxCards) => items.slice(0, maxCards).map((item) => {
    const text = (selector) => item.querySelector(selector)?.textContent?.trim() || "";
    const subjectLink = item.querySelector("a.brh-rfq-item__subject-link[href*='rfq_detail']");
    const quoteLink = [...item.querySelectorAll("a")].find((a) => a.href.includes("rfq_quotation_post"));
    return {
      title: text(".brh-rfq-item__subject-link"),
      summary: text(".brh-rfq-item__detail"),
      quantityText: text(".brh-rfq-item__quantity"),
      countryText: text(".brh-rfq-item__country"),
      remainingQuotesText: text(".brh-rfq-item__quote-left"),
      publishedText: text(".brh-rfq-item__publishtime"),
      buyerText: text(".brh-rfq-item__other-info .avatar .text"),
      cardImageUrl: item.querySelector(".brh-rfq-item__image-link img")?.currentSrc || item.querySelector(".brh-rfq-item__image-link img")?.src || "",
      detailUrl: subjectLink?.href || "",
      quoteUrl: quoteLink?.href || ""
    };
  }), config.maxCardsPerSearch);

  return cards.map((card) => ({
    ...card,
    id: stableRfqId(card),
    searchTerm,
    quantity: parseNumber(card.quantityText),
    country: card.countryText.replace(/^\s*发布地点\s*[:：]?\s*/i, "").trim(),
    remainingQuotes: parseNumber(card.remainingQuotesText),
    collectedAt: new Date().toISOString()
  })).filter((card) => card.id && card.detailUrl);
}

export function keywordPrefilter(rfq, supportedCategories) {
  const haystack = `${rfq.title}\n${rfq.summary}`.toLowerCase();
  const matches = [];
  for (const [categoryId, category] of Object.entries(supportedCategories)) {
    const score = category.keywords.reduce((total, keyword) => total + (haystack.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    if (score > 0) matches.push({ categoryId, score });
  }
  return matches.sort((a, b) => b.score - a.score);
}

export async function hydrateDetail(page, rfq, config) {
  await sleep(config.navigationDelayMs);
  await page.goto(rfq.detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator(".rfq-detail-info-body, .brh-rfq-detail").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await assertAlibabaReady(page);
  const detail = await page.locator(".rfq-detail-info-body").first().innerText({ timeout: 15000 }).catch(async () => {
    return page.locator(".brh-rfq-detail").first().innerText({ timeout: 15000 });
  });
  const imageAssets = await captureRfqImages(page, rfq.id, config);
  return {
    ...rfq,
    detailText: sanitizeRfqText(detail),
    imagePaths: imageAssets.map((asset) => asset.filePath),
    imageAssets
  };
}
