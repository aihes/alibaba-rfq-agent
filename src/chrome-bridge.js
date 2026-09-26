import fs from "node:fs";
import path from "node:path";
import { AgentOverChromeBridge } from "@midscene/web/bridge-mode";

function unwrapBridgeValue(response) {
  if (response?.result && Object.hasOwn(response.result, "value")) return response.result.value;
  if (response?.result?.type === "undefined") return undefined;
  return response;
}

async function withBridgeLogsOnStderr(operation) {
  const original = console.log;
  console.log = (...args) => console.error("[chrome-bridge]", ...args);
  try {
    return await operation();
  } finally {
    console.log = original;
  }
}

function selectorExpression(selector, index, body) {
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = nodes[${index}];
    ${body}
  })()`;
}

class BridgeLocator {
  constructor(page, selector, index = 0) {
    this.page = page;
    this.selector = selector;
    this.index = index;
  }

  first() {
    return new BridgeLocator(this.page, this.selector, 0);
  }

  nth(index) {
    return new BridgeLocator(this.page, this.selector, index);
  }

  async waitFor({ state = "visible", timeout = 15000 } = {}) {
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const matches = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
        if (!element) return false;
        if (${JSON.stringify(state)} === "attached") return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      `));
      if (matches) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${this.selector} (${state})`);
  }

  async evaluateAll(callback, argument) {
    const expression = `(${callback.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(this.selector)})), ${JSON.stringify(argument)})`;
    return this.page.evaluateJson(expression);
  }

  async innerText({ timeout = 15000 } = {}) {
    await this.waitFor({ state: "attached", timeout });
    return this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      return element.innerText || element.textContent || "";
    `));
  }

  async fill(value) {
    const serialized = JSON.stringify(String(value));
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) return { ok: false, error: "element not found" };
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, ${serialized}); else element.value = ${serialized};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: element.value === ${serialized}, value: element.value };
    `));
    if (!result?.ok) throw new Error(`Could not fill ${this.selector}: ${result?.error || "value did not stick"}`);
  }

  async selectOption(value) {
    const serialized = JSON.stringify(String(value));
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: "select not found" };
      const option = Array.from(element.options).find((candidate) => candidate.value === ${serialized} || candidate.text.trim() === ${serialized});
      if (!option) return { ok: false, error: "option not found", options: Array.from(element.options).map((candidate) => ({ value: candidate.value, text: candidate.text.trim() })) };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, option.value); else element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: element.value === option.value, value: element.value };
    `));
    if (!result?.ok) throw new Error(`Could not select ${value} in ${this.selector}: ${result?.error || "value did not stick"}`);
  }

  async inputValue() {
    return this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) throw new Error("element not found");
      return element.value || "";
    `));
  }

  async check() {
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!(element instanceof HTMLInputElement)) return { ok: false, error: "input not found" };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
      if (setter) setter.call(element, true); else element.checked = true;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.click();
      return { ok: element.checked };
    `));
    if (!result?.ok) throw new Error(`Could not check ${this.selector}: ${result?.error || "state did not stick"}`);
  }

  async click() {
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) return { ok: false, error: "element not found" };
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "element is disabled" };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { ok: true };
    `));
    if (!result?.ok) throw new Error(`Could not click ${this.selector}: ${result?.error || "unknown error"}`);
  }

  async count() {
    return this.page.evaluateJson(`document.querySelectorAll(${JSON.stringify(this.selector)}).length`);
  }

  async screenshot() {
    throw new Error("Element screenshots are unavailable through Chrome Bridge");
  }
}

class BridgePage {
  constructor(agent, initialUrl) {
    this.agent = agent;
    this.currentUrl = initialUrl;
  }

  async evaluateJson(expression) {
    const response = await this.agent.evaluateJavaScript(`JSON.stringify(${expression})`);
    const value = unwrapBridgeValue(response);
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async goto(url) {
    await this.agent.page.navigate(url);
    this.currentUrl = await this.agent.page.url().catch(() => url);
  }

  locator(selector) {
    return new BridgeLocator(this, selector);
  }

  url() {
    return this.currentUrl;
  }

  context() {
    return {
      request: {
        get: async (url, { timeout = 20000 } = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetch(url, {
              redirect: "follow",
              signal: controller.signal,
              headers: { referer: this.currentUrl }
            });
            const body = Buffer.from(await response.arrayBuffer());
            return {
              ok: () => response.ok,
              headers: () => Object.fromEntries(response.headers.entries()),
              body: async () => body
            };
          } finally {
            clearTimeout(timer);
          }
        }
      }
    };
  }

  async screenshot({ path: outputPath } = {}) {
    const base64 = await this.agent.page.screenshotBase64();
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
    }
    return Buffer.from(base64, "base64");
  }

  async waitForLoadState(_state, { timeout = 15000 } = {}) {
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const readyState = await this.evaluateJson("document.readyState").catch(() => "loading");
      if (readyState === "interactive" || readyState === "complete") {
        this.currentUrl = await this.agent.page.url().catch(() => this.currentUrl);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for the Chrome Bridge page to load");
  }

  async close() {}
}

export async function connectChromeBridge({ timeoutMs = 20000 } = {}) {
  const agent = new AgentOverChromeBridge({
    serverListeningTimeout: timeoutMs,
    closeConflictServer: true,
    closeNewTabsAfterDisconnect: false,
    generateReport: false,
    autoPrintReportMsg: false,
    enableWaterFlowAnimation: false
  });

  try {
    const tabs = await withBridgeLogsOnStderr(() => agent.getBrowserTabList());
    let selected = tabs.find((tab) => /sourcing\.alibaba\.com\/rfq_search_list\.htm/i.test(tab.url))
      || tabs.find((tab) => /(?:sourcing|rfqposting)\.alibaba\.com/i.test(tab.url));
    if (!selected) {
      const fallbackUrl = "https://sourcing.alibaba.com/rfq_search_list.htm";
      await withBridgeLogsOnStderr(() => agent.connectNewTabWithUrl(fallbackUrl));
      const refreshed = await withBridgeLogsOnStderr(() => agent.getBrowserTabList());
      selected = refreshed.find((tab) => /(?:sourcing|rfqposting)\.alibaba\.com/i.test(tab.url))
        || refreshed.find((tab) => tab.currentActiveTab);
    }
    if (!selected) throw new Error("No Alibaba RFQ tab is open in the existing Chrome session");
    await agent.setActiveTabId(selected.id);
    const page = new BridgePage(agent, selected.url);
    const browser = { close: () => withBridgeLogsOnStderr(() => agent.destroy(false)) };
    return { browser, context: page.context(), page, createdPage: false, selectedTab: selected };
  } catch (error) {
    await withBridgeLogsOnStderr(() => agent.destroy(false)).catch(() => {});
    throw new Error(`Cannot attach to the existing Chrome session through Chrome Bridge. Cause: ${error.message}`);
  }
}
