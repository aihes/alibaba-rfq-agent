import fs from "node:fs";
import path from "node:path";
import { DomLocator } from "./dom-locator.js";

/** 工作进程只接触主进程分发的临时能力令牌，不接触 Electron、用户
 * Chrome 或登录存储。HTTP 不是 Chromium 调试端口，只提供本应用页面接口。
 */
export async function connectElectronBrowser(config, { request = fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(config.electronBrowserUrl); } catch { throw new Error("内置浏览器连接不可用，请从 RFQ 助手启动任务"); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/api/desktop/browser/command" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[a-f0-9]{64}$/.test(config.electronBrowserToken || "")) {
    throw new Error("内置浏览器连接参数无效");
  }
  let lease;
  const call = async (action, args = {}) => {
    const body = JSON.stringify({ action, ...(lease ? { lease } : {}), ...args });
    const response = await request(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(35000),
      headers: { "Content-Type": "application/json", "X-RFQ-Browser": config.electronBrowserToken }, body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "内置浏览器操作失败");
    return result;
  };
  const selectedTab = await call("connect"); lease = selectedTab.lease;
  const page = new ElectronPage(call, selectedTab.url);
  return { provider: "electron-cdp", browserMode: "embedded-chromium", selectedTab: { id: selectedTab.id, title: selectedTab.title, url: selectedTab.url },
    createdPage: false, page, context: page.context(), browser: { close: () => call("release") } };
}

class ElectronPage {
  constructor(call, url) { this.call = call; this.currentUrl = url; }
  locator(selector) { return new DomLocator(this, selector); }
  url() { return this.currentUrl; }
  async goto(url) { const result = await this.call("goto", { url }); this.currentUrl = result.url; }
  async evaluateJson(expression, { mutation = false } = {}) {
    return (await this.call("evaluate", { expression, mutation, expectedUrl: this.currentUrl })).value;
  }
  async waitForLoadState(_state, { timeout = 15000 } = {}) {
    const start = Date.now();
    while (Date.now() - start <= timeout) {
      // 点击提交可能发生重定向；先读应用窗口的新 URL，再等待文档就绪。
      this.currentUrl = (await this.call("state")).url;
      const ready = await this.evaluateJson("document.readyState");
      if (["interactive", "complete"].includes(ready)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("内置浏览器页面加载超时");
  }
  async screenshot({ path: output, fullPage = false } = {}) {
    const { data } = await this.call("screenshot", { fullPage, expectedUrl: this.currentUrl });
    const bytes = Buffer.from(data, "base64");
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes); }
    return bytes;
  }
  context() {
    // 图片下载沿用原有无登录凭据 HTTP 路径，来源和大小由 images.js 校验。
    return { request: { get: async (url, { timeout = 20000 } = {}) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { referer: this.currentUrl } });
      const body = Buffer.from(await response.arrayBuffer());
      return { ok: () => response.ok, headers: () => Object.fromEntries(response.headers), body: async () => body };
    } } };
  }
  async close() {}
}
