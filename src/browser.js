// 主进程的只读登录检测与任务进程使用同一组 DOM 信号。账号菜单常在
// hover 后才可见，不能把页面正文里的通用 “Sign In” 营销链接当成退出
// 登录的证据；也不能仅凭公开页上的 “My Alibaba” 认定已经登录。
export const ALIBABA_LOGIN_EVIDENCE_EXPRESSION = String.raw`(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
      style.display !== 'none' && style.visibility === 'visible';
  };
  return ({
  body: document.body?.innerText?.slice(0, 30000) || '',
  logoutEntry: Array.from(document.querySelectorAll('a, button, [role="menuitem"]')).some((element) =>
    visible(element) && /^(?:log\s*out|sign\s*out|退出|登出)$/i.test((element.textContent || '').trim().replace(/\s+/g, ' '))),
  accountHeader: Array.from(document.querySelectorAll('a[href]')).some((element) =>
    /my\s*alibaba/i.test((element.textContent || '').trim()) && new URL(element.href).hostname === 'i.alibaba.com'),
  loginEntry: Array.from(document.querySelectorAll('a[href], button')).some((element) => {
    const rect = element.getBoundingClientRect();
    return visible(element) && rect.top < 280 &&
      /^(?:sign\s*in|log\s*in|登录)$/i.test((element.textContent || '').trim());
  })
  });
})()`;

export function alibabaLoginStatus(evidence, url) {
  const structured = evidence !== null && typeof evidence === "object";
  const body = String(structured ? evidence.body || "" : evidence || "");
  if (/captcha|滑块|安全验证|verify you are human/i.test(body)) return "captcha";
  let pagePath = "";
  try { const parsed = new URL(url); pagePath = parsed.hostname + parsed.pathname; } catch {}
  if (/\b(?:login|signin|passport)\b/i.test(pagePath)) return "login_required";
  if (structured) {
    // RFQ 详情页可能先渲染登录占位文字，再异步更新账号导航。
    // 先看当前可见的账号入口；正文中的通用提示不能覆盖明确的退出入口。
    if (evidence.logoutEntry === true) return "logged_in";
    if (evidence.loginEntry === true) return "login_required";
    if (/you have not signed in|please sign in to (?:obtain|quote)|未登录|尚未登录/i.test(body)) return "login_required";
    if (evidence.accountHeader === true && evidence.loginEntry === false) return "logged_in";
    return "unknown";
  }
  if (/you have not signed in|please sign in to (?:obtain|quote)|未登录|尚未登录/i.test(body)) return "login_required";
  // 旧适配器/测试只有页面文本时保守处理；真实任务总会读取上面的
  // 固定 DOM 信号，不会再根据正文中的 Sign In 字样误报退出登录。
  if (/\b(?:sign\s*in|log\s*in)\b|请(?:先)?登录|(?:^|\s)登录(?:\s|$)/im.test(body.slice(0, 1000))) return "login_required";
  return /退出|\b(?:sign\s*out|log\s*out)\b/i.test(body) ? "logged_in" : "unknown";
}

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

export async function assertAlibabaReady(page, { waitMs = 0, intervalMs = 250 } = {}) {
  const deadline = Date.now() + waitMs;
  let status;
  do {
    const url = page.url();
    const evidence = typeof page.evaluateJson === "function"
      ? await page.evaluateJson(ALIBABA_LOGIN_EVIDENCE_EXPRESSION)
      : await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
    status = alibabaLoginStatus(evidence, url);
    if (status === "logged_in") return;
    if (status === "captcha") throw new Error("Alibaba presented a CAPTCHA or verification challenge. Stop automation and complete it manually.");
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  } while (true);
  if (status === "login_required") throw new Error("Alibaba login is required in the selected browser session.");
  throw new Error("Alibaba login could not be verified on this RFQ page.");
}
