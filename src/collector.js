import { assertAlibabaReady } from "./browser.js";
import { captureRfqImages } from "./images.js";
import { parseNumber, sanitizeRfqText, sleep, stableRfqId } from "./utils.js";
import { parsePublishedAt } from "./rfq-time.js";

export function buildSearchUrl(baseUrl, searchTerm) {
  const url = new URL(baseUrl);
  url.searchParams.set("SearchText", searchTerm);
  return url.toString();
}

export async function collectSearchPage(page, config, searchTerm) {
  let url = buildSearchUrl(config.searchBaseUrl, searchTerm);
  const visited = new Set();
  const cards = [];
  while (url) {
    if (visited.has(url)) throw new Error(`RFQ 搜索分页重复：${searchTerm}`);
    visited.add(url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator(".alife-bc-brh-rfq-list__item").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await assertAlibabaReady(page, { waitMs: 5000 });
    const observedAt = new Date();
    const pageCards = await page.locator(".alife-bc-brh-rfq-list__item").evaluateAll((items) => items.map((item) => {
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
    }));
    cards.push(...pageCards.map((card) => ({ ...card, publishedAt: parsePublishedAt(card.publishedText, observedAt),
      collectedAt: observedAt.toISOString() })));
    url = await nextSearchPageUrl(page, url, searchTerm);
    if (url) await sleep(config.navigationDelayMs || 0);
  }

  return cards.map((card) => ({
    ...card,
    id: stableRfqId(card),
    searchTerm,
    quantity: parseNumber(card.quantityText),
    country: card.countryText.replace(/^\s*发布地点\s*[:：]?\s*/i, "").trim(),
    remainingQuotes: parseNumber(card.remainingQuotesText),
    // Alibaba 的发布时间与采集时间分别保留；相对时间以读取卡片时为基准。
    publishedAt: card.publishedAt,
    collectedAt: card.collectedAt
  })).filter((card) => card.id && card.detailUrl);
}

/** Follow only list links for the same search and origin. Numeric pagination
 * is allowed when the site marks its current page. A button without a usable
 * link is an incomplete scan, never a successful one. */
export async function nextSearchPageUrl(page, currentUrl, searchTerm) {
  const pagination = await page.evaluateJson(`(() => {
    const elements = Array.from(document.querySelectorAll('a, button, [aria-current="page"], [class*="active"], [class*="current"]'));
    const items = elements.map((element) => {
      const text = (element.textContent || '').trim().replace(/\\s+/g, ' ');
      const pagination = element.closest('[class*="pagination"], [class*="pager"], nav[aria-label*="page"]') !== null;
      const className = typeof element.className === 'string' ? element.className : '';
      const parentClass = typeof element.parentElement?.className === 'string' ? element.parentElement.className : '';
      return { href: element.getAttribute('href') || '', text, pagination,
        label: element.getAttribute('aria-label') || '', rel: element.getAttribute('rel') || '',
        disabled: element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('.disabled, [aria-disabled="true"]') !== null,
        active: element.getAttribute('aria-current') === 'page' || /\\b(active|current|selected)\\b/i.test(className + ' ' + parentClass),
        className, parentClass };
    });
    return {
      next: items.filter((item) => !item.disabled && ((item.pagination && /^(next|next page|下一页|下页|›|»|>)$/i.test(item.text))
        || (item.pagination && /^(next|next page|下一页)$/i.test(item.label)) || /\\bnext\\b/i.test(item.rel)
        || /(?:pagination|pager)[-_ ]?next|next[-_ ]?(?:page|pagination)/i.test(item.className + ' ' + item.parentClass))),
      numeric: items.filter((item) => item.pagination && /^\\d+$/.test(item.text)).map(({ href, text, active, disabled }) => ({ href, number: Number(text), active, disabled }))
    };
  })()`);
  const current = new URL(currentUrl);
  const activePage = pagination.numeric.find((item) => item.active)?.number;
  const numericNext = Number.isInteger(activePage)
    ? pagination.numeric.filter((item) => !item.disabled && item.number === activePage + 1) : [];
  const controls = [...pagination.next, ...numericNext];
  for (const control of controls) {
    if (!control.href || /^javascript:/i.test(control.href)) continue;
    let next;
    try { next = new URL(control.href, current); } catch { continue; }
    if (next.protocol !== current.protocol) continue;
    if (next.origin !== current.origin || next.pathname !== current.pathname) continue;
    const term = next.searchParams.get("SearchText");
    if (term && term !== searchTerm) continue;
    if (!term) next.searchParams.set("SearchText", searchTerm);
    if (next.href !== current.href) return next.href;
  }
  if (controls.length || (pagination.numeric.length && !Number.isInteger(activePage))) {
    throw new Error("RFQ 列表存在未读取的分页，但下一页链接无法安全定位；本轮未完成全部扫描");
  }
  return null;
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
  await assertAlibabaReady(page, { waitMs: 5000 });
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
