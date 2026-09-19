import path from "node:path";
import { connectBrowser, assertAlibabaReady } from "./browser.js";
import { projectDir } from "./config.js";

export function submissionToken(record) {
  return `${record.rfq.id}:${record.quote.unitPriceUsd}:SUBMIT`;
}

export function assertSubmitAllowed(config, record, confirmation) {
  if (!config.allowLiveSubmit) throw new Error("Live submission is disabled. Set ALLOW_LIVE_SUBMIT=true only for an approved run.");
  const expected = submissionToken(record);
  if (confirmation !== expected) throw new Error(`Exact confirmation required: ${expected}`);
}

export async function fillQuotePage(page, config, record, { submit = false, confirmation = "" } = {}) {
  if (!record?.rfq?.quoteUrl) throw new Error("Draft record has no Alibaba quoteUrl");
  if (!record?.draft || !record?.quote) throw new Error("Draft record is incomplete");
  const verifiedPort = record.draft.port || config.quotePort;
  if (!verifiedPort) throw new Error("QUOTE_PORT is required before form filling. Use the verified EXW location or FOB loading port.");
  if (submit) assertSubmitAllowed(config, record, confirmation);

  await page.goto(record.rfq.quoteUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("#form-submit").waitFor({ state: "visible", timeout: 15000 });
  await assertAlibabaReady(page);

  await page.locator("input.ui2-form-col12").first().fill(record.draft.productName);
  await page.locator("textarea[placeholder*='材料']").fill(record.draft.productDetails);

  const termSelect = page.locator("select.quo-form-validator-item").nth(0);
  await termSelect.selectOption(record.quote.tradeTerm);
  await page.locator("input.ui2-form-col8").nth(1).fill(verifiedPort);
  const validUntil = new Date(Date.now() + (record.quote.validityDays || 7) * 86400000).toISOString().slice(0, 10);
  await page.locator("input.ui2-form-col6").fill(validUntil);

  await page.locator("select.quo-form-validator-item").nth(1).selectOption(record.quote.currency);
  await page.locator("select.quo-form-validator-item").nth(2).selectOption("Pieces");
  await page.locator("select.quo-form-validator-item").nth(3).selectOption("T/T");
  await page.locator("input.quo-ladder-price-input").nth(0).fill(String(record.quote.quantity));
  await page.locator("input.quo-ladder-price-input").nth(1).fill(String(record.quote.unitPriceUsd));
  await page.locator("textarea.textarea-other").fill(record.draft.buyerMessage);

  const sampleValue = record.draft.sampleAvailable ? "Y" : "N";
  await page.locator(`input.ui2-radio-customize-val[value='${sampleValue}']`).first().check();

  const filledValues = {
    productName: await page.locator("input.ui2-form-col12").first().inputValue(),
    tradeTerm: await termSelect.inputValue(),
    port: await page.locator("input.ui2-form-col8").nth(1).inputValue(),
    validUntil: await page.locator("input.ui2-form-col6").inputValue(),
    quantity: await page.locator("input.quo-ladder-price-input").nth(0).inputValue(),
    unitPrice: await page.locator("input.quo-ladder-price-input").nth(1).inputValue(),
    buyerMessage: await page.locator("textarea.textarea-other").inputValue()
  };

  const screenshotPath = path.join(projectDir, "data/drafts", `${record.rfq.id}-filled.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  if (!submit) {
    return { status: "filled_not_submitted", screenshotPath, submitToken: submissionToken(record), filledValues };
  }

  await page.locator("#form-submit").click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/报价成功|submitted|quotation.*success/i.test(body)) {
    throw new Error("Submit was clicked, but success could not be verified. Inspect the browser before retrying.");
  }
  const submittedScreenshotPath = path.join(projectDir, "data/drafts", `${record.rfq.id}-submitted.png`);
  await page.screenshot({ path: submittedScreenshotPath, fullPage: true });
  return { status: "submitted", screenshotPath, submittedScreenshotPath, filledValues };
}

export async function fillQuoteForm(config, record, options = {}) {
  const { browser, page } = await connectBrowser(config);
  try {
    return await fillQuotePage(page, config, record, options);
  } finally {
    await browser.close().catch(() => {});
  }
}
