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
import { EmbeddedBrowser } from "../src/desktop/embedded-browser.js";
import { connectElectronBrowser } from "../src/electron-browser.js";
import { DesktopSettings } from "../src/desktop/settings.js";
import { parseAlibabaLoginFile } from "../src/desktop/browser-import.js";
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
    const { createCaseServer } = await import("../src/desktop/server.js");
    const { fillQuotePage, submissionToken } = await import("../src/form.js");
    const { collectSearchPage, hydrateDetail } = await import("../src/collector.js");
    // 公开页也会显示 My Alibaba；fixture 明确提供退出入口，才代表
    // 已登录。这与内置浏览器的账号导航检测规则保持一致。
    const html = fs.readFileSync(path.join(resources, "tests/fixtures/quote-form.html"), "utf8").replace("<main>", `<main><p>My Alibaba</p><a href="/logout">Log out</a>
      <article class="alife-bc-brh-rfq-list__item">
        <a class="brh-rfq-item__subject-link" href="/rfq_detail.htm?p=fixture">Fixture corrugated carton box</a>
        <p class="brh-rfq-item__detail">500 B flute cartons</p><p class="brh-rfq-item__quantity">500 Pieces</p>
        <p class="brh-rfq-item__country">Ukraine</p><p class="brh-rfq-item__quote-left">6</p><p class="brh-rfq-item__publishtime">15 minutes ago</p>
        <a href="/rfq_quotation_post.htm">Quote</a>
      </article><nav class="pagination"><a href="/rfq/rfq_search_list.htm?searchText=carton&page=2">Next</a></nav>
      <div class="rfq-detail-info-body">Fixture B flute carton, 310x235x165mm</div>`);
    const secondPage = html.replace("Fixture corrugated carton box", "Fixture second page carton box")
      .replace("p=fixture", "p=fixture-second").replace(/<nav class="pagination">.*?<\/nav>/, "");
    fixture = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" });
      res.end(new URL(req.url, "http://localhost").searchParams.get("page") === "2" ? secondPage : html); });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    // Exercise the two list routes Alibaba actually uses: the initial search
    // path and the /rfq/ path reached through pagination.
    const home = `http://127.0.0.1:${fixture.address().port}/rfq_search_list.htm`;
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
      notify: async () => ({ status: "accepted", detail: "fixture system accepted; banner unverified" }),
      environment: () => ({ ...settings.environment(), RFQ_BROWSER_URL: `${service.url}api/desktop/browser/command`, RFQ_BROWSER_TOKEN: token }), revokeBrowser: () => b.invalidate() });
    const config = { electronBrowserUrl: `${service.url}api/desktop/browser/command`, electronBrowserToken: token, allowLiveSubmit: true, quotePort: "Shanghai" };
    const c = await connectElectronBrowser(config);
    const cards = await collectSearchPage(c.page, { searchBaseUrl: home }, "carton");
    assert.equal(cards.length, 2); assert.equal(cards[0].quantity, 500); assert.equal(cards[0].remainingQuotes, 6);
    assert.equal(cards[0].publishedText, "15 minutes ago");
    assert.ok(Number.isFinite(Date.parse(cards[0].publishedAt)));
    assert.equal(cards[1].title, "Fixture second page carton box");
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
    // 默认浏览器能力不会自行启动任务；只读检查仍不建立控制 lease。
    const environment = await service.console.envCheck(true);
    assert.equal(environment.ok, true, JSON.stringify(environment.checks));
    assert.equal(environment.checks[2].label, "阿里巴巴浏览器");
    assert.equal(environment.checks[3].state, "已登录");
    assert.equal(service.console.settings.browserEnabled, true);
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
    // 旧任务失败只应作为历史记录展示；阶段卡片应说明停在哪一步，
    // 原始调用栈默认折叠。这些记录仅存在隔离 fixture 工作区。
    const runId = "fixture-progress";
    const opsDir = path.join(root, "data/case-catalog/ops");
    fs.mkdirSync(opsDir, { recursive: true });
    service.console.last = { id: runId, kind: "once", status: "attention", alert: "任务在 RFQ 页面遇到登录提示，已停止分析",
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 1, term: "carton", limit: 1 };
    fs.writeFileSync(path.join(opsDir, `${runId}.progress.json`), JSON.stringify({ stage: "detail", message: "正在读取 RFQ 详情与附件", itemIndex: 1, itemTotal: 1, at: new Date().toISOString() }));
    const eventFile = path.join(opsDir, `${runId}.progress.json.events.jsonl`);
    const eventAt = new Date().toISOString();
    fs.writeFileSync(eventFile, [
      { stage: "connect", message: "正在连接应用内浏览器", at: eventAt },
      { eventId: "fixture-search", stage: "search", message: "正在搜索 fixture", at: eventAt,
        input: { searchTerm: "fixture", maxCards: 10 } },
      { phase: "result", eventId: "fixture-search", stage: "result", at: eventAt, output: { count: 1, cards: [{ title: "Fixture amount" }] } },
      { stage: "detail", message: "正在读取 RFQ 详情与附件", at: eventAt }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    fs.writeFileSync(path.join(opsDir, `${runId}.log`), "Error: Alibaba login is required\n    at fixture stack\n");
    const draftDirectory = path.join(root, "data/drafts");
    fs.mkdirSync(draftDirectory, { recursive: true });
    const draftAt = "2026-09-28T08:10:00.000Z";
    const draftFile = path.join(draftDirectory, "rfq-ui-draft.json");
    const imageDirectory = path.join(root, "data/rfqs/rfq-ui-draft/images");
    fs.mkdirSync(imageDirectory, { recursive: true });
    const buyerImage = path.join(imageDirectory, "product-1.png");
    fs.writeFileSync(buyerImage, png);
    fs.writeFileSync(draftFile, JSON.stringify({ createdAt: draftAt, rfq: { id: "rfq-ui-draft", title: "Fixture amount", remainingQuotes: 2,
      summary: "Buyer requests B flute carton", detailText: "Buyer needs 500 B flute cartons for export.", quantityText: "500 Pieces", country: "Ukraine",
      detailUrl: "https://sourcing.alibaba.com/rfq_detail.htm?fixture=1", imageAssets: [{ filePath: buyerImage, capture: "download" }] },
      analysis: { categoryId: "corrugated_box", recommendation: "quote", confidence: 0.9, missingRequired: [], riskFlags: [] },
      quote: { status: "quoted", currency: "USD", quantity: 500, unitPriceUsd: 0.75, totalUsd: 375, setupUsd: 0, tradeTerm: "EXW" },
      draft: { port: "Shanghai", productName: "Fixture carton", productDetails: "B flute", buyerMessage: "Fixture only" },
      submission: { status: "skipped" } }));
    fs.writeFileSync(path.join(draftDirectory, "rfq-conditional.json"), JSON.stringify({ createdAt: draftAt,
      rfq: { id: "rfq-conditional", title: "Fixture conditional amount" },
      analysis: { categoryId: "corrugated_box" },
      quote: { status: "conditional_quote", currency: "USD", quantity: 500, unitPriceUsd: 0.75,
        totalUsd: 375, setupUsd: 0, tradeTerm: "EXW" },
      draft: { productName: "Carton", productDetails: "B flute", buyerMessage: "Conditional only" },
      submission: { status: "skipped" } }));
    fs.writeFileSync(path.join(draftDirectory, "rfq-no-price.json"), JSON.stringify({ createdAt: draftAt,
      rfq: { id: "rfq-no-price", title: "Fixture needs review" },
      analysis: { categoryId: "corrugated_box" }, quote: { status: "needs_review" },
      submission: { status: "skipped" } }));
    // 用真实 Chromium 检查用户点击后的应用内提醒；系统通知适配器
    // 在 fixture 中注入，不向当前电脑发送真实通知或访问 Alibaba。
    ui = new BrowserWindow({ width: 1440, height: 940, show: process.argv.includes("--preview"), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await ui.loadURL(`${service.url}?view=console`);
    const until = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await ui.webContents.executeJavaScript(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Workbench notification UI did not reach: ${expression}`);
    };
    await until("document.querySelector('#ops-term').options.length > 0");
    await until("document.querySelector('#run-progress-stage').textContent.includes('上次停在：读取 RFQ 详情')");
    await until("document.querySelectorAll('#run-history li').length === 4");
    const stageText = await ui.webContents.executeJavaScript("document.querySelector('#run-history').textContent");
    assert.match(stageText, /正在连接应用内浏览器/);
    assert.match(stageText, /正在搜索 fixture/);
    await ui.webContents.executeJavaScript("document.querySelector('[data-stage-index=\"1\"]').open = true");
    await until("document.querySelector('[data-stage-index=\"1\"] .stage-evidence').textContent.includes('Fixture amount')");
    await until("document.querySelector('#priced-quote-list').textContent.includes('Fixture amount')");
    assert.match(await ui.webContents.executeJavaScript("document.querySelector('#priced-quote-list').textContent"), /\$375/);
    assert.doesNotMatch(await ui.webContents.executeJavaScript("document.querySelector('#quote-list').textContent"), /Fixture conditional amount|Fixture needs review/);
    assert.doesNotMatch(await ui.webContents.executeJavaScript("document.querySelector('#priced-quote-list').textContent"), /Fixture conditional amount|Fixture needs review/);
    assert.match(await ui.webContents.executeJavaScript("document.querySelector('.quote-status-help').textContent"), /需要人工复核 \/ 条件报价/);
    assert.match(await ui.webContents.executeJavaScript("document.querySelector('#quote-list').textContent"), /生成于 2026/);
    await until("document.querySelector('#quote-detail').textContent.includes('Buyer needs 500 B flute cartons for export')");
    assert.match(await ui.webContents.executeJavaScript("document.querySelector('#quote-detail').textContent"), /Buyer needs 500 B flute cartons for export/);
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('.quote-source-actions a')?.href"), "https://sourcing.alibaba.com/rfq_detail.htm?fixture=1");
    await until("!document.querySelector('#console-workspace').hidden");
    await ui.webContents.executeJavaScript("document.querySelector('[data-quote-image]').scrollIntoView({ block: 'center' })");
    await until("document.querySelector('[data-quote-image] img')?.naturalWidth > 0");
    await ui.webContents.executeJavaScript("document.querySelector('[data-quote-image]').click()");
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('.quote-image-dialog').open"), true);
    await ui.webContents.executeJavaScript("document.querySelector('.quote-image-close').click()");
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('.quote-image-dialog').open"), false);
    assert.match(await ui.webContents.executeJavaScript("document.querySelector('#submitted-quote-list').textContent"), /没有已验证提交/);
    await ui.webContents.executeJavaScript("document.querySelector('#quote-search').value = 'B flute'; document.querySelector('#quote-search').dispatchEvent(new Event('input', { bubbles: true }))");
    await until("document.querySelector('#quote-filter-count').textContent.includes('1 / 1')");
    await ui.webContents.executeJavaScript("document.querySelector('#quote-status-filter').value = 'submitted'; document.querySelector('#quote-status-filter').dispatchEvent(new Event('change', { bubbles: true }))");
    await until("document.querySelector('#quote-filter-count').textContent.includes('0 / 1')");
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('#quote-workbench-grid').classList.contains('is-empty') && document.querySelector('#priced-quotes-section').hidden"), true);
    await ui.webContents.executeJavaScript("document.querySelector('#quote-status-filter').value = 'all'; document.querySelector('#quote-status-filter').dispatchEvent(new Event('change', { bubbles: true }))");
    await until("document.querySelector('#quote-filter-count').textContent.includes('1 / 1')");
    await until("document.querySelector('#quote-detail [data-quote-archive=prompt]')?.disabled === false");
    await ui.webContents.executeJavaScript("document.querySelector('#quote-detail [data-quote-archive=prompt]').click()");
    await ui.webContents.executeJavaScript("document.querySelector('#quote-detail [data-quote-archive=confirm]').click()");
    await until("document.querySelector('#quote-show-archived').textContent.includes('（1）')");
    assert.ok(fs.existsSync(draftFile));
    await ui.webContents.executeJavaScript("document.querySelector('#quote-show-archived').click()");
    await until("document.querySelector('#quote-detail [data-quote-archive=restore]')?.disabled === false");
    await ui.webContents.executeJavaScript("document.querySelector('#quote-detail [data-quote-archive=restore]').click()");
    await until("document.querySelector('#quote-show-archived').textContent.includes('（0）')");
    assert.ok(fs.existsSync(draftFile));
    if (process.argv.includes("--screenshot")) {
      await ui.webContents.executeJavaScript("window.scrollTo({ top: document.querySelector('#run-history').getBoundingClientRect().top + window.scrollY - 120, behavior: 'instant' })");
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(os.tmpdir(), "rfq-stage-ui-smoke.png"), (await ui.capturePage()).toPNG());
      await ui.webContents.executeJavaScript("window.scrollTo({ top: document.querySelector('#priced-quotes-title').getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' })");
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(os.tmpdir(), "rfq-quote-ui-smoke.png"), (await ui.capturePage()).toPNG());
      ui.setSize(390, 844);
      await ui.webContents.executeJavaScript("window.scrollTo({ top: document.querySelector('#quote-detail').getBoundingClientRect().top + window.scrollY - 60, behavior: 'instant' })");
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(path.join(os.tmpdir(), "rfq-quote-mobile-smoke.png"), (await ui.capturePage()).toPNG());
      ui.setSize(1440, 940);
    }
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('.run-log-details').open"), false);
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('#ops-alert').textContent.includes('上次运行')"), true);
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('#ops-alert').classList.contains('is-history')"), true);
    service.console.last = { ...service.console.last, status: "running", finishedAt: null, alert: null };
    fs.writeFileSync(path.join(opsDir, `${runId}.progress.json`), JSON.stringify({ stage: "analysis", message: "正在调用模型分析需求", itemIndex: 1, itemTotal: 2, at: new Date().toISOString() }));
    await until("document.querySelector('#scan-action-help').textContent.includes('正在调用模型分析需求')");
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('#scan-action-help').textContent.includes('需求 1/2')"), true);
    service.console.last = { ...service.console.last, status: "attention", finishedAt: new Date().toISOString(), alert: "任务在 RFQ 页面遇到登录提示，已停止分析" };
    await ui.webContents.executeJavaScript("document.querySelector('#notifications-enabled').click()");
    await until("!document.querySelector('#notification-test').disabled");
    await ui.webContents.executeJavaScript("document.querySelector('#notification-test').click()");
    await until("!document.querySelector('#notification-toast').hidden && document.querySelector('#notification-toast-title').textContent.includes('测试')");
    const { notifyOpportunity } = await import("../src/notifications.js");
    const alertRecord = { rfq: { id: "rfq-ui-alert", title: "Fixture carton", remainingQuotes: 2, quoteUrl: "https://sourcing.alibaba.com/rfq/quote" },
      analysis: { recommendation: "quote", confidence: 0.99, missingRequired: [], riskFlags: [] },
      quote: { status: "quoted", currency: "USD", quantity: 500, unitPriceUsd: 1, totalUsd: 500, setupUsd: 0 },
      draft: { port: "Shanghai", productName: "Carton", productDetails: "B flute", buyerMessage: "Please review" }, submission: { status: "skipped" } };
    assert.equal((await notifyOpportunity(alertRecord, {}, { file: service.console.settingsFile, send: async () => ({ status: "accepted" }) })).status, "accepted");
    await until("document.querySelector('#notification-toast-title').textContent.includes('可报价机会')");
    assert.equal(await ui.webContents.executeJavaScript("document.querySelector('#notification-history-list').textContent.includes('Fixture carton')"), true);
    console.log(JSON.stringify({ ok: true, chromium: process.versions.chrome, assertions: ["HTTP private broker", "native CDP DOM read/write", "RFQ scan and detail extraction", "fill without submit", "exact submit confirmation", "verified fixture submit", "PNG evidence", "quote switch revocation", "hidden window reuse", "persistent isolated session", "local tab and copy-link UI", "read-only inspection without task lease", "manual navigation and history", "workbench login status with browser capability on", "synthetic Alibaba Cookie migration in isolated Chromium", "stage history and collapsed technical log", "RFQ original link and local image preview", "priced draft, timestamp, reversible archive", "inline scan progress and item count", "in-app test and opportunity popups with history"], workspace: root, previewUrl: service.url,
      ...(process.argv.includes("--screenshot") ? { screenshots: ["rfq-stage-ui-smoke.png", "rfq-quote-ui-smoke.png", "rfq-quote-mobile-smoke.png"].map((name) => path.join(os.tmpdir(), name)) } : {}) }));
    if (!process.argv.includes("--preview")) { await cleanup(); app.exit(0); }
  } catch (error) { console.error(error.stack); await cleanup(); app.exit(1); }
});
