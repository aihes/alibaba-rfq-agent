export async function connectBrowser(config) {
  // 桌面任务必须使用应用拥有的窗口。连接失败时不能偷偷改接用户 Chrome。
  const provider = process.env.RFQ_DESKTOP === "1" ? "electron-cdp" : (config.browserProvider || "chrome-bridge");
  if (provider === "electron-cdp") {
    const { connectElectronBrowser } = await import("./electron-browser.js");
    return connectElectronBrowser(config);
  }
  if (provider !== "chrome-bridge") throw new Error("Unsupported browser provider");
  const { connectChromeBridge } = await import("./chrome-bridge.js");
  return connectChromeBridge({ timeoutMs: config.chromeBridgeTimeoutMs });
}

export async function assertAlibabaReady(page) {
  const url = page.url();
  const body = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
  if (/captcha|滑块|安全验证|verify you are human/i.test(body)) {
    throw new Error("Alibaba presented a CAPTCHA or verification challenge. Stop automation and complete it manually.");
  }
  // 公开 RFQ 列表同样展示 My Alibaba 和 Quote Now，不能用它们覆盖
  // 明确的未登录提示。内置空白会话的实测页同时显示这两种内容。
  const signedOut = /you have not signed in|please sign in to (?:obtain|quote)|未登录|尚未登录/i.test(body)
    || /\b(?:sign\s*in|log\s*in)\b|请(?:先)?登录|(?:^|\s)登录(?:\s|$)/im.test(body.slice(0, 1000));
  if (/\b(?:login|signin|passport)\b/i.test(url) || signedOut) {
    throw new Error("Alibaba login is required in the selected browser session.");
  }
}
