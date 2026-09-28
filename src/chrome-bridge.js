import { DomLocator } from "./dom-locator.js";
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
    return new DomLocator(this, selector);
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
    return { browser, context: page.context(), page, createdPage: false, selectedTab: selected, provider: "chrome-bridge", browserMode: "existing-chrome" };
  } catch (error) {
    await withBridgeLogsOnStderr(() => agent.destroy(false)).catch(() => {});
    throw new Error(`Cannot attach to the existing Chrome session through Chrome Bridge. Cause: ${error.message}`);
  }
}
