import fs from "node:fs";
import path from "node:path";
import { projectDir } from "./config.js";
import { extractImageText } from "./ocr.js";

const ALLOWED_IMAGE_HOSTS = [
  "alibaba.com",
  "alicdn.com",
  "aliimg.com",
  "alibabausercontent.com"
];

function hostAllowed(hostname) {
  return ALLOWED_IMAGE_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function normalizeImageUrls(candidates, pageUrl) {
  const urls = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("data:") || candidate.startsWith("blob:")) continue;
    try {
      const url = new URL(candidate, pageUrl);
      if (!["http:", "https:"].includes(url.protocol) || !hostAllowed(url.hostname)) continue;
      url.hash = "";
      urls.push(url.toString());
    } catch {
      // Ignore malformed URLs from untrusted RFQ markup.
    }
  }
  return [...new Set(urls)];
}

function extensionFor(contentType, url) {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };
  if (byType[type]) return byType[type];
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension) ? extension : ".img";
}

async function discoverImageUrls(page) {
  const selector = [
    ".rfq-detail-info-body img",
    ".brh-at-item img",
    ".brh-at-item a[href]",
    "[class*='attachment'] img",
    "[class*='attachment'] a[href]"
  ].join(",");
  const candidates = await page.locator(selector).evaluateAll((nodes) => nodes.flatMap((node) => [
    node.currentSrc,
    node.getAttribute("src"),
    node.getAttribute("data-src"),
    node.getAttribute("data-lazy-src"),
    node.getAttribute("href")
  ].filter(Boolean))).catch(() => []);
  return normalizeImageUrls(candidates, page.url());
}

export async function captureRfqImages(page, rfqId, config) {
  const imageDir = path.join(projectDir, "data/rfqs", String(rfqId), "images");
  fs.mkdirSync(imageDir, { recursive: true });
  const urls = await discoverImageUrls(page);
  const assets = [];

  for (const url of urls.slice(0, config.maxRfqImages)) {
    try {
      const response = await page.context().request.get(url, { timeout: 20000, failOnStatusCode: false });
      if (!response.ok()) continue;
      const contentType = response.headers()["content-type"] || "";
      if (!contentType.toLowerCase().startsWith("image/")) continue;
      const announcedSize = Number(response.headers()["content-length"] || 0);
      if (announcedSize > config.maxImageBytes) continue;
      const body = await response.body();
      if (!body.length || body.length > config.maxImageBytes) continue;
      const filePath = path.join(imageDir, `product-${assets.length + 1}${extensionFor(contentType, url)}`);
      fs.writeFileSync(filePath, body);
      assets.push({ sourceUrl: url, filePath, bytes: body.length, contentType, capture: "download" });
    } catch {
      // One broken attachment must not abort the RFQ pipeline.
    }
  }

  if (assets.length < config.maxRfqImages) {
    const attachmentItems = page.locator(".brh-at-item");
    const count = Math.min(await attachmentItems.count().catch(() => 0), config.maxRfqImages - assets.length);
    for (let index = 0; index < count; index += 1) {
      const filePath = path.join(imageDir, `attachment-${assets.length + 1}.png`);
      try {
        await attachmentItems.nth(index).screenshot({ path: filePath });
        const bytes = fs.statSync(filePath).size;
        if (bytes > 0 && bytes <= config.maxImageBytes) {
          assets.push({ sourceUrl: "", filePath, bytes, contentType: "image/png", capture: "element-screenshot" });
        }
      } catch {
        // Attachment might be off-screen, hidden or unsupported.
      }
    }
  }
  for (const asset of assets) {
    const ocr = await extractImageText(asset.filePath);
    asset.ocrStatus = ocr.status;
    asset.ocrText = ocr.text;
    if (ocr.error) asset.ocrError = ocr.error;
  }
  return assets;
}
