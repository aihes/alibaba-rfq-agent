/** 在真正 Electron Chromium 上运行本地 fixture。此入口不读取生产
 * 用户目录，不访问 Alibaba，不发送模型请求。测试站点白名单仅在此注入。
 * npm run desktop:test:browser；--preview 保留工作台供桌面/移动端 UI 审查。
 */
import { app, BrowserWindow, WebContentsView, ipcMain, clipboard } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { EmbeddedBrowser } from "../desktop/embedded-browser.js";
import { connectElectronBrowser } from "../src/electron-browser.js";
import { DesktopSettings } from "../desktop/settings.js";
import { parseAlibabaLoginFile } from "../desktop/browser-import.js";
const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-electron-smoke-"));
app.setPath("userData", path.join(root, "electron-data"));
process.env.RFQ_WORKSPACE_DIR = root;
app.on("window-all-closed", () => {});
let b, service, fixture, ui;
const cleanup = async () => { await service?.close(); b?.close(); ui?.destroy(); fixture?.close(); };
// Chromium 退出前可能仍写入缓存，临时数据由测试启动器在子进程结束后清理。
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().then(() => app.exit(0)); });
app.whenReady().then(async () => {
  try {
    const { createCaseServer } = await import("../desktop/server.js");
    const { fillQuotePage, submissionToken } = await import("../src/form.js");
    const { collectSearchPage, hydrateDetail } = await import("../src/collector.js");
    let html = fs.readFileSync(path.join(resources, "tests/fixtures/quote-form.html"), "utf8").replace("<main>", `<main><p>My Alibaba</p>
      <article class="alife-bc-brh-rfq-list__item">
        <a class="brh-rfq-item__subject-link" href="/rfq_detail.htm?p=fixture">Fixture corrugated carton box</a>
        <p class="brh-rfq-item__detail">500 B flute cartons</p><p class="brh-rfq-item__quantity">500 Pieces</p>
        <p class="brh-rfq-item__country">Ukraine</p><p class="brh-rfq-item__quote-left">6</p>
        <a href="/rfq_quotation_post.htm">Quote</a>
      </article><div class="rfq-detail-info-body">Fixture B flute carton, 310x235x165mm</div>`);
    fixture = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const home = `http://127.0.0.1:${fixture.address().port}/quote`;
    const allowed = (value) => { try { return new URL(value).origin === new URL(home).origin; } catch { return false; } };
    fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    for (const name of ["default.json", "pricing-rules.json"]) fs.copyFileSync(path.join(resources, "config", name), path.join(root, "config", name));
    fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), JSON.stringify({ cases: [], categories: [], counts: { cases: 0, manualQuoteCases: 0, manualQuoteLines: 0, agentRationaleCases: 0 }, generatedAt: new Date().toISOString() }));
    const permission = { browser: true, quote: true };
    let copiedUrl = null;
    b = new EmbeddedBrowser({ BrowserWindow, WebContentsView, ipcMain, clipboard: { writeText: value => { copiedUrl = value; } },
      authorize: () => permission, home, navigationAllowed: allowed, automationAllowed: allowed, shareableUrl: value => allowed(value) ? value : null });
    assert.equal(b.info().opened, false); assert.equal(b.info().inspection, null);
    const token = crypto.randomBytes(32).toString("hex");
    const settings = new DesktopSettings(root, { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() }, {
      localEnvironment: { variables: { GLM_API_KEY: "synthetic-ui-key", GLM_MODEL: "glm-fixture" }, source: "测试本机环境变量" },
      reloadEnvironment: async () => ({ variables: { GLM_API_KEY: "synthetic-ui-key", GLM_MODEL: "glm-fixture" }, source: "测试本机环境变量" })
    });
    service = await createCaseServer({ resources, workspace: root, desktop: true, embeddedBrowser: b, browserToken: token,
      desktopSettings: settings, importBrowserLogin: async () => ({ canceled: true }),
      environment: () => ({ ...settings.environment(), RFQ_BROWSER_URL: `${service.url}api/desktop/browser/command`, RFQ_BROWSER_TOKEN: token }), revokeBrowser: () => b.invalidate() });
    const config = { electronBrowserUrl: `${service.url}api/desktop/browser/command`, electronBrowserToken: token, allowLiveSubmit: true, quotePort: "Shanghai" };
    const c = await connectElectronBrowser(config);
    const cards = await collectSearchPage(c.page, { searchBaseUrl: home, maxCardsPerSearch: 1 }, "carton");
    assert.equal(cards.length, 1); assert.equal(cards[0].quantity, 500); assert.equal(cards[0].remainingQuotes, 6);
    const detail = await hydrateDetail(c.page, cards[0], { navigationDelayMs: 0, maxRfqImages: 0 });
    assert.match(detail.detailText, /310x235x165mm/);
    const record = { rfq: { id: "electron-fixture", quoteUrl: home }, draft: { port: "Shanghai", productName: "Fixture carton", productDetails: "B flute", buyerMessage: "Local fixture quote only", sampleAvailable: false }, quote: { tradeTerm: "EXW", currency: "USD", quantity: 500, unitPriceUsd: 0.75, validityDays: 7 } };
    const filled = await fillQuotePage(c.page, config, record);
    assert.equal(filled.status, "filled_not_submitted"); assert.equal(filled.filledValues.unitPrice, "0.75");
    assert.equal(await c.page.evaluateJson("Number(document.body.dataset.submitCount || 0)"), 0);
    assert.equal(await c.page.evaluateJson("document.querySelector('input[value=N]').checked"), true);
    const png = await c.page.screenshot({ fullPage: true }); assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    await assert.rejects(fillQuotePage(c.page, config, record, { submit: true, confirmation: "wrong" }), /Exact confirmation/);
    const submitted = await fillQuotePage(c.page, config, record, { submit: true, confirmation: submissionToken(record) });
    assert.equal(submitted.status, "submitted"); assert.equal(await c.page.evaluateJson("document.body.dataset.submitCount"), "1");
    // 写入 switch 必须由主进程再次校验，而不是相信 worker 的旧授权。
    permission.quote = false;
    await assert.rejects(c.page.locator("input.ui2-form-col12").fill("denied"), /逐单报价/);
    b.window.hide(); await c.page.evaluateJson("document.title"); assert.equal(b.window.isVisible(), false);
    const wcId = b.pageContents().id;
    await c.browser.close(); await b.open(); assert.equal(b.pageContents().id, wcId);
    // 登录会话只需检查是否 persistent，不读取 cookie 或认证存储。
    assert.equal(b.pageContents().session.isPersistent(), true);
    assert.equal(b.pageContents().getLastWebPreferences().nodeIntegration, false);
    assert.notEqual(b.window.webContents.session, b.pageContents().session);
    assert.notEqual(b.window.webContents.getLastWebPreferences().partition, "persist:rfq-alibaba");
    // 标签栏是本地 webContents；复制动作由主进程校验后执行。
    const toolbar = await b.window.webContents.executeJavaScript("({ title: document.querySelector('#tab-title')?.textContent, address: document.querySelector('#address')?.value, canCopy: !document.querySelector('#copy')?.disabled })");
    assert.equal(toolbar.address, b.pageContents().getURL()); assert.equal(toolbar.canCopy, true);
    await b.window.webContents.executeJavaScript("document.querySelector('#copy').click()");
    for (let i = 0; !copiedUrl && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(copiedUrl, b.pageContents().getURL());
    // 手动检测不需要 Agent 开关，且不会建立任务控制 lease。
    permission.browser = false;
    const manual = await b.inspect();
    assert.equal(manual.inspection.status, "logged_in");
    assert.equal(manual.browserEnabled, false); assert.equal(b.lease, null); assert.equal(manual.cdpAttached, false);
    await b.manual({ action: "navigate", url: `${home}?manual=1` });
    assert.equal(b.info().canGoBack, true);
    const forwardUrl = b.pageContents().getURL();
    const navState = () => b.window.webContents.executeJavaScript("({ backDisabled: document.querySelector('#back').disabled, forwardDisabled: document.querySelector('#forward').disabled })");
    for (let i = 0; (await navState()).backDisabled && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await navState()).backDisabled, false);
    const backReady = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Manual back timeout")), 10000); b.pageContents().once("did-stop-loading", () => { clearTimeout(timer); resolve(); }); });
    await b.window.webContents.executeJavaScript("document.querySelector('#back').click()"); await backReady;
    assert.equal(b.info().canGoForward, true);
    assert.equal(b.info().inspection, null);
    for (let i = 0; (await navState()).forwardDisabled && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await navState()).forwardDisabled, false);
    const forwardReady = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Manual forward timeout")), 10000); b.pageContents().once("did-stop-loading", () => { clearTimeout(timer); resolve(); }); });
    await b.window.webContents.executeJavaScript("document.querySelector('#forward').click()"); await forwardReady;
    assert.equal(b.pageContents().getURL(), forwardUrl);
    permission.busy = true; b.updateToolbar();
    assert.equal((await navState()).backDisabled, true);
    assert.match((await b.window.webContents.executeJavaScript("window.rfqTab.navigate('back')")).error, /任务或检测/);
    permission.busy = false; b.updateToolbar();
    // 真实 Electron 上检查登录不需要打开 Agent 总开关，也不启动 worker。
    const environment = await service.console.envCheck(true);
    assert.equal(environment.ok, true, JSON.stringify(environment.checks));
    assert.equal(environment.checks[2].label, "阿里巴巴浏览器");
    assert.equal(environment.checks[3].state, "已登录");
    assert.equal(service.console.settings.browserEnabled, false);
    assert.equal(b.lease, null); assert.equal(b.info().cdpAttached, false);
    // 仅在隔离 fixture 会话写入人工构造的 Cookie。这里不访问原 Chrome
    // 或生产用户目录，也不连接 Alibaba。验证 Chromium 确实接受迁移属性。
    const prepared = parseAlibabaLoginFile(JSON.stringify({ cookies: [
      { domain: ".alibaba.com", name: "rfq-synthetic", value: "synthetic-only", path: "/", secure: true, httpOnly: true, sameSite: "None", expirationDate: Date.now() / 1000 + 3600 },
      { domain: "passport.alibaba.com", name: "__Host-rfq-fixture", value: "synthetic-host-only", path: "/", secure: true, hostOnly: true, session: true }
    ] }));
    const imported = await b.importLogin(prepared);
    assert.equal(imported.imported, 2); assert.ok(!JSON.stringify(imported).includes("synthetic-only"));
    const synthetic = await b.pageContents().session.cookies.get({});
    assert.equal(synthetic.length, 2); assert.equal(synthetic.find(x => x.name === "__Host-rfq-fixture").hostOnly, true);
    assert.equal(b.info().inspection, null); assert.equal(b.lease, null); assert.equal(b.info().cdpAttached, false);
    assert.equal(permission.browser, false);
    permission.browser = false;
    console.log(JSON.stringify({ ok: true, chromium: process.versions.chrome, assertions: ["HTTP private broker", "native CDP DOM read/write", "RFQ scan and detail extraction", "fill without submit", "exact submit confirmation", "verified fixture submit", "PNG evidence", "quote switch revocation", "hidden window reuse", "persistent isolated session", "local tab and copy-link UI", "read-only inspection with Agent disabled", "manual navigation and history", "workbench login status with Agent disabled", "synthetic Alibaba Cookie migration in isolated Chromium"], workspace: root, previewUrl: service.url }));
    if (process.argv.includes("--preview")) {
      ui = new BrowserWindow({ width: 1440, height: 940, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await ui.loadURL(`${service.url}?view=console`);
    } else { await cleanup(); app.exit(0); }
  } catch (error) { console.error(error.stack); await cleanup(); app.exit(1); }
});
