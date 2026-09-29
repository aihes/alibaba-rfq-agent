import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { EmbeddedBrowser, alibabaNavigationAllowed, shareableBrowserUrl, RFQ_PARTITION, RFQ_HOME } from "../src/desktop/embedded-browser.js";

test("copyable tab URLs include RFQ IDs but never login tickets or arbitrary sites", () => {
  assert.equal(shareableBrowserUrl("https://sourcing.alibaba.com/rfq_detail.htm?p=fixture"), "https://sourcing.alibaba.com/rfq_detail.htm?p=fixture");
  assert.equal(shareableBrowserUrl("https://sourcing.alibaba.com/rfq_detail.htm?p=fixture#access_token=private"), "https://sourcing.alibaba.com/rfq_detail.htm?p=fixture");
  for (const url of ["https://passport.alibaba.com/login.htm?ticket=private", "https://sourcing.alibaba.com/rfq_detail.htm?auth_token=private",
    "https://sourcing.alibaba.com/rfq_detail.htm?session_id=private", "https://alibaba.com.attacker.test/rfq_detail.htm?p=fixture"])
    assert.equal(shareableBrowserUrl(url), null);
});
import { createCaseServer } from "../src/desktop/server.js";
import { connectElectronBrowser } from "../src/electron-browser.js";
import { connectBrowser, assertAlibabaReady, alibabaLoginStatus } from "../src/browser.js";
import { parseAlibabaLoginFile } from "../src/desktop/browser-import.js";

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.visible = false; this.destroyed = false;
    const wc = new EventEmitter(); this.webContents = wc;
    Object.assign(wc, { id: 7, url: "", getURL: () => wc.url, getTitle: () => "RFQ", isDestroyed: () => this.destroyed,
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }, stop() {}, isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: (handler) => { wc.popup = handler; },
      loadURL: async (url) => { wc.url = url; queueMicrotask(() => wc.emit("dom-ready")); } });
    wc.debugger = { attached: false, calls: [], isAttached: () => wc.debugger.attached,
      attach: () => { wc.debugger.attached = true; }, detach: () => { wc.debugger.attached = false; },
      sendCommand: async (method, params) => { wc.debugger.calls.push({ method, params }); return { result: { value: "fixture" } }; } };
  }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}
test("owned browser uses isolated persistent session, does not automate login sites or arbitrary URLs", async () => {
  assert.ok(alibabaNavigationAllowed("https://passport.alibaba.com/login.htm"));
  for (const u of ["https://alibaba.com.attacker.test", "https://a@alibaba.com", "http://sourcing.alibaba.com", "file:///tmp/test", "https://sourcing.alibaba.com:9000"]) assert.equal(alibabaNavigationAllowed(u), false);
  const permission = { browser: false, quote: false };
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => permission });
  try {
    assert.equal(b.info().opened, false); assert.equal(b.info().inspection, null);
    await assert.rejects(b.command({ action: "connect" }), /控制已关闭/);
    assert.equal(b.window, null);
    await b.open(); assert.equal(permission.browser, false);
    assert.equal(b.window.options.webPreferences.partition, RFQ_PARTITION);
    assert.equal(b.window.options.webPreferences.nodeIntegration, false);
    permission.browser = true;
    const c = await b.command({ action: "connect" });
    await assert.rejects(b.command({ action: "goto", lease: c.lease, url: "https://passport.alibaba.com/login.htm" }), /RFQ 页面/);
    const p = { action: "evaluate", lease: c.lease, expectedUrl: RFQ_HOME, expression: "document.title", mutation: false };
    assert.equal((await b.command(p)).value, "fixture");
    await assert.rejects(b.command({ ...p, mutation: true }), /逐单报价/);
    permission.quote = true; await b.command({ ...p, mutation: true });
    b.window.webContents.url = `${RFQ_HOME}?manually=changed`;
    await assert.rejects(b.command(p), /页面已变化/);
    b.invalidate(); await assert.rejects(b.command(p), /失效/);
  } finally { b.close(); }
});
test("embedded RFQ browser can capture a visible attachment element without quote permission", async () => {
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => ({ browser: true, quote: false }) });
  try {
    const { lease } = await b.command({ action: "connect" });
    const wc = b.window.webContents;
    wc.debugger.sendCommand = async (method, params) => {
      if (method === "Runtime.evaluate") {
        assert.match(params.expression, /scrollIntoView/);
        assert.match(params.expression, /\.brh-at-item/);
        return { result: { value: { x: 12, y: 34, width: 80, height: 60 } } };
      }
      assert.equal(method, "Page.captureScreenshot");
      assert.deepEqual(params.clip, { x: 12, y: 34, width: 80, height: 60, scale: 1 });
      assert.equal(params.captureBeyondViewport, false);
      return { data: "cG5n" };
    };
    const shot = { action: "elementScreenshot", lease, expectedUrl: RFQ_HOME, selector: ".brh-at-item", index: 0 };
    assert.equal((await b.command(shot)).data, "cG5n");
    await assert.rejects(b.command({ ...shot, index: -1 }), /参数无效/);
    wc.url = `${RFQ_HOME}?changed=1`;
    await assert.rejects(b.command(shot), /页面已变化/);
  } finally { b.close(); }
});
test("manual login inspection works with Agent disabled, exposes no auth query, and never grants a worker lease", async () => {
  const permission = { browser: false, quote: false, busy: false };
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => permission });
  try {
    await b.open(`${RFQ_HOME}?session=private-value`);
    const wc = b.window.webContents;
    wc.debugger.sendCommand = async (_method, params) => {
      assert.match(params.expression, /document\.body\?\.innerText/);
      assert.match(params.expression, /logoutEntry/);
      return { result: { value: "Sign In | My Alibaba | Quote Now" } };
    };
    const inspected = await b.inspect();
    assert.equal(inspected.inspection.status, "login_required");
    assert.equal(inspected.browserEnabled, false); assert.equal(b.lease, null);
    assert.equal(inspected.cdpAttached, false);
    assert.ok(!JSON.stringify(inspected).includes("private-value"));
    await assert.rejects(b.command({ action: "connect" }), /控制已关闭/);
    permission.busy = true;
    await assert.rejects(b.inspect(), /正在使用/);
    await assert.rejects(b.manual({ action: "navigate", url: RFQ_HOME }), /停止任务/);
    await b.manual({ action: "hide" }); assert.equal(b.info().visible, false);
    permission.busy = false;
    wc.url = "https://passport.alibaba.com/login?token=secret-value";
    wc.debugger.sendCommand = () => assert.fail("Login pages must not execute scripts");
    assert.equal((await b.inspect()).inspection.status, "login_required");
    assert.ok(!JSON.stringify(b.info()).includes("secret-value"));
    wc.url = `${RFQ_HOME}?new-page=1`; assert.equal(b.info().inspection, null);
  } finally { b.close(); }
});
test("automatic status is bounded, invalidates on navigation and never interrupts a task", async () => {
  const permission = { browser: false, quote: false, busy: false };
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => permission });
  let reads = 0;
  try {
    assert.equal((await b.status()).opened, false); assert.equal(b.window, null);
    await b.open(); const wc = b.window.webContents;
    wc.debugger.sendCommand = async () => { reads++; return { result: { value: "My Alibaba\n退出\n立即报价" } }; };
    assert.equal((await b.status()).inspection.status, "logged_in");
    await b.status(); assert.equal(reads, 1); assert.equal(b.lease, null);
    assert.equal(b.info().cdpAttached, false); assert.equal(permission.browser, false);
    // 同一 URL 的刷新也会开始新导航，不能沿用先前账号状态。
    wc.emit("did-start-navigation", {}, RFQ_HOME, false, true);
    wc.isLoading = () => true;
    assert.equal((await b.status(true)).inspection, null); assert.equal(reads, 1);
    wc.isLoading = () => false;
    await b.status(); assert.equal(reads, 2);
    permission.browser = true;
    const connection = await b.command({ action: "connect" });
    await b.command({ action: "evaluate", lease: connection.lease, expectedUrl: RFQ_HOME, expression: "document.title", mutation: false });
    permission.busy = true;
    await b.status(true);
    assert.equal(reads, 3); assert.equal(b.lease, connection.lease); assert.equal(wc.debugger.isAttached(), true);
    permission.busy = false; b.invalidate(); permission.browser = false;
    wc.url = `${RFQ_HOME}?changed=1`;
    wc.debugger.sendCommand = async () => { reads++; throw new Error("fixture failure"); };
    const failure = await b.status();
    assert.equal(failure.inspection, null); assert.match(failure.inspectionError, /暂时无法确认/);
    await b.status(); assert.equal(reads, 4);
    wc.debugger.sendCommand = async () => { reads++; return { result: { value: "Sign In | My Alibaba" } }; };
    assert.equal((await b.status(true)).inspection.status, "login_required");
    assert.equal(b.info().inspectionError, null); assert.equal(reads, 5);
  } finally { b.close(); }
});
test("public RFQ navigation is not treated as proof of login and quit flushes the owned session", async () => {
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => ({ browser: false }) });
  try {
    await b.open();
    const wc = b.window.webContents, flushed = [];
    wc.debugger.sendCommand = async () => ({ result: { value: "My Alibaba\nQuote Now\nFavorites" } });
    assert.equal((await b.inspect()).inspection.status, "unknown");
    // 账号菜单收起时 innerText 没有 Log out，DOM 中的菜单项仍可证明已登录。
    wc.debugger.sendCommand = async () => ({ result: { value: { body: "My Alibaba\nQuote Now\nFavorites", logoutEntry: true } } });
    assert.equal((await b.inspect()).inspection.status, "logged_in");
    wc.debugger.sendCommand = async () => ({ result: { value: { body: "My Alibaba\nQuote Now\nFavorites", accountHeader: true, loginEntry: false } } });
    assert.equal((await b.inspect()).inspection.status, "logged_in");
    wc.debugger.sendCommand = async () => ({ result: { value: { body: "My Alibaba\nQuote Now\nFavorites", accountHeader: true, loginEntry: true } } });
    assert.equal((await b.inspect()).inspection.status, "login_required");
    wc.debugger.sendCommand = async () => ({ result: { value: "My Alibaba\n退出\n立即报价" } });
    assert.equal((await b.inspect()).inspection.status, "logged_in");
    wc.session.cookies = { flushStore: async () => flushed.push("cookies") };
    wc.session.flushStorageData = () => flushed.push("storage");
    await b.flushSession();
    assert.deepEqual(flushed, ["cookies", "storage"]);
  } finally { b.close(); }
});
test("inspection reads a collapsed account menu without exposing account text", async () => {
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => ({ browser: false }) });
  try {
    await b.open();
    const link = (text, href) => ({ textContent: text, href, getBoundingClientRect: () => ({ top: 100, bottom: 120, width: 80, height: 20 }), getClientRects: () => [{}] });
    const account = link("My Alibaba 0", "https://i.alibaba.com/");
    const logout = link("Log out", "https://login.alibaba.com/logout.htm");
    b.window.webContents.debugger.sendCommand = async (_method, params) => {
      const document = { body: { innerText: "My Alibaba\nOrder\nFavorites" }, querySelectorAll: () => [account, logout] };
      const value = vm.runInNewContext(params.expression, { document, URL, getComputedStyle: () => ({ display: "block", visibility: "visible" }) });
      assert.equal(value.body.includes("Log out"), false);
      assert.equal(value.logoutEntry, true);
      assert.equal(value.accountHeader, true);
      assert.equal(value.loginEntry, false);
      return { result: { value } };
    };
    assert.equal((await b.inspect()).inspection.status, "logged_in");
  } finally { b.close(); }
});
test("login migration rejects busy browsers, invalidates stale login inspection and never enables automation", async () => {
  const permission = { browser: false, quote: false, busy: true };
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => permission });
  const prepared = parseAlibabaLoginFile(JSON.stringify([{ domain: ".alibaba.com", name: "fixture", value: "synthetic-only" }]));
  try {
    await assert.rejects(b.importLogin(prepared), /停止任务/); assert.equal(b.window, null);
    permission.busy = false; await b.open();
    const wc = b.window.webContents; wc.isLoading = () => true;
    await assert.rejects(b.importLogin(prepared), /加载/); wc.isLoading = () => false;
    b.inspection = { url: RFQ_HOME, result: { status: "logged_in" } };
    let release;
    wc.session.cookies = { get: async () => [], set: async () => new Promise(resolve => { release = resolve; }), flushStore: async () => {} };
    wc.session.clearStorageData = async () => {};
    const pending = b.importLogin(prepared);
    for (let i = 0; !release && i < 5; i++) await Promise.resolve();
    assert.equal(b.info().busy, true); assert.equal(b.info().inspection, null);
    await assert.rejects(b.importLogin(prepared), /等待检查/);
    release(); assert.equal((await pending).imported, 1);
    assert.equal(b.info().busy, false); assert.equal(b.lease, null); assert.equal(permission.browser, false);
    assert.ok(!JSON.stringify(b.info()).includes("synthetic-only"));
  } finally { b.close(); }
});
test("workbench environment and browser endpoints show login with default browser capability, without a worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-status-test-"));
  fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{"cases":0}}');
  let service;
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => ({ browser: service?.console.settings.browserEnabled, busy: Boolean(service?.console.current) }) });
  try {
    service = await createCaseServer({ resources: path.resolve("."), workspace: root, desktop: true, embeddedBrowser: b,
      spawnProcess: () => assert.fail("read-only status must not launch a worker") });
    const get = async (route) => (await fetch(service.url + route)).json();
    const empty = await get("api/env/check");
    assert.equal(empty.checks.find((x) => x.key === "bridge").state, "尚未打开"); assert.equal(b.window, null);
    await b.open();
    b.window.webContents.debugger.sendCommand = async () => ({ result: { value: "My Alibaba\n退出\n立即报价" } });
    const browser = await get("api/desktop/browser");
    assert.equal(browser.checks.find((x) => x.key === "login").state, "已登录");
    const environment = await get("api/env/check?force=1");
    assert.equal(environment.ok, true); assert.equal(environment.status, "checked");
    assert.equal(environment.browser.browserEnabled, true); assert.equal(b.lease, null);
    assert.equal(b.info().cdpAttached, false);
    service.console.searchTerms = ["fixture"];
    assert.throws(() => service.console.start({ kind: "once", term: "fixture", limit: 1 }), /API Key/);
    service.console.current = { status: "running" };
    b.window.webContents.debugger.sendCommand = () => assert.fail("busy task must not be inspected");
    assert.equal((await get("api/env/check?force=1")).browser.busy, true);
    service.console.current = null;
  } finally { if (service) await service.close(); b.close(); fs.rmSync(root, { recursive: true }); }
});
test("revocation rejects requests already queued and releasing a stale connection cannot revoke a newer one", async () => {
  const permission = { browser: true, quote: true };
  const b = new EmbeddedBrowser({ BrowserWindow: FakeWindow, authorize: () => permission });
  try {
    const a = await b.command({ action: "connect" });
    const newer = await b.command({ action: "connect" });
    await b.command({ action: "release", lease: a.lease }); assert.equal(b.lease, newer.lease);
    const queued = b.command({ action: "evaluate", lease: newer.lease, expectedUrl: RFQ_HOME, expression: "1", mutation: true });
    permission.browser = false; b.invalidate();
    await assert.rejects(queued, /失效/);
    assert.equal(b.window.webContents.debugger.calls.length, 0);
    // 即使用户随后再次打开总开关，先前排队的 connect 也不能复活。
    permission.browser = true;
    const oldConnect = b.command({ action: "connect" }); b.invalidate();
    await assert.rejects(oldConnect, /失效/);
  } finally { b.close(); }
});
test("CDP broker cannot be invoked by a renderer or a notification token, and its token has no settings privilege", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-broker-test-"));
  fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{"cases":0}}');
  let calls = 0;
  const browserToken = "b".repeat(64);
  const service = await createCaseServer({ resources: path.resolve("."), workspace: root, browserToken, notifyToken: "n".repeat(64),
    embeddedBrowser: { info: () => ({ provider: "electron-cdp" }), command: () => { calls++; return { ok: true }; } } });
  try {
    const post = (route, headers) => fetch(service.url + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: '{"action":"connect"}' });
    assert.equal((await post("api/desktop/browser/command", { Origin: new URL(service.url).origin, "X-Case-Console": "1" })).status, 403);
    assert.equal((await post("api/desktop/browser/command", { "X-RFQ-Notify": "n".repeat(64) })).status, 403);
    assert.equal((await post("api/desktop/browser/command", { "X-RFQ-Browser": browserToken })).status, 200);
    assert.equal(calls, 1);
    assert.equal((await post("api/ops/settings", { "X-RFQ-Browser": browserToken })).status, 403);
    assert.equal((await fetch(service.url + "api/desktop/info").then((r) => r.json())).browserProvider, "electron-cdp");
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("desktop connection failures never fall back to personal Chrome or forward credentials to remote endpoints", async () => {
  await assert.rejects(connectBrowser({ browserProvider: "electron-cdp" }), /从 RFQ 助手启动/);
  for (const url of ["https://attacker.test/api/desktop/browser/command", "http://127.0.0.1:8888/api/ops/settings", "http://user:pass@127.0.0.1:8888/api/desktop/browser/command"]) {
    await assert.rejects(connectElectronBrowser({ electronBrowserUrl: url, electronBrowserToken: "b".repeat(64) }, { request: () => assert.fail("credential must not leave process") }), /连接参数无效/);
  }
});
test("public My Alibaba navigation never overrides an explicit signed-out or CAPTCHA state", async () => {
  const page = (body, url = RFQ_HOME) => ({ url: () => url, locator: () => ({ innerText: async () => body }) });
  await assert.rejects(assertAlibabaReady(page("Sign In | My Alibaba | Quote Now")), /login is required/);
  await assert.rejects(assertAlibabaReady(page("My Alibaba\nQuote Now\nYou have not signed in. Please sign in to obtain quoting rights.")), /login is required/);
  await assert.rejects(assertAlibabaReady(page("My Alibaba 安全验证 滑块")), /verification challenge/);
  await assertAlibabaReady(page("My Alibaba\n退出\n立即报价"));
});
test("task and workbench use the same account-nav evidence on an RFQ detail page", async () => {
  const evidence = { body: "Sign In for more services\nMy Alibaba\nRFQ detail", accountHeader: true, loginEntry: false, logoutEntry: false };
  assert.equal(alibabaLoginStatus(evidence, "https://sourcing.alibaba.com/rfq_detail.htm"), "logged_in");
  const page = { url: () => "https://sourcing.alibaba.com/rfq_detail.htm", evaluateJson: async () => evidence };
  await assertAlibabaReady(page);
  evidence.loginEntry = true;
  assert.equal(alibabaLoginStatus(evidence, page.url()), "login_required");
  await assert.rejects(assertAlibabaReady(page), /login is required/);
  evidence.loginEntry = false; evidence.body += "\nYou have not signed in. Please sign in to obtain quoting rights.";
  await assert.rejects(assertAlibabaReady(page), /login is required/);
  evidence.body = "My Alibaba\nRFQ detail"; evidence.accountHeader = false;
  await assert.rejects(assertAlibabaReady(page), /could not be verified/);
});
test("RFQ detail waits for the account navigation to settle after page load", async () => {
  let reads = 0;
  const page = { url: () => "https://sourcing.alibaba.com/rfq_detail.htm?event=login",
    evaluateJson: async () => {
      reads++;
      return reads < 3
        ? { body: "My Alibaba\nRFQ detail", accountHeader: true, loginEntry: true, logoutEntry: false }
        : { body: "My Alibaba\nRFQ detail", accountHeader: true, loginEntry: false, logoutEntry: true };
    } };
  await assertAlibabaReady(page, { waitMs: 150, intervalMs: 1 });
  assert.equal(reads, 3);
  assert.equal(alibabaLoginStatus({ body: "RFQ detail", accountHeader: true, loginEntry: false, logoutEntry: false }, page.url()), "logged_in");
  assert.equal(alibabaLoginStatus({ body: "You have not signed in", accountHeader: true, loginEntry: false, logoutEntry: true }, page.url()), "logged_in");
});
