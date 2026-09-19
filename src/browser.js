import { connectChromeBridge } from "./chrome-bridge.js";

export async function connectBrowser(config) {
  return connectChromeBridge({ timeoutMs: config.chromeBridgeTimeoutMs });
}

export async function assertAlibabaReady(page) {
  const url = page.url();
  const body = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
  if (/captcha|滑块|安全验证|verify you are human/i.test(body)) {
    throw new Error("Alibaba presented a CAPTCHA or verification challenge. Stop automation and complete it manually.");
  }
  const authenticatedPageSignals = /退出|My Alibaba|立即报价|RFQ 详情|Order\b|Favorites\b|form-submit/i.test(body.slice(0, 5000));
  if (/\b(?:login|signin|passport)\b/i.test(url) || (!authenticatedPageSignals && /登录|Sign In/i.test(body.slice(0, 2000)))) {
    throw new Error("Alibaba login is required in the selected browser session.");
  }
}
