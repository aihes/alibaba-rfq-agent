import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALIBABA_LOGIN_EVIDENCE_EXPRESSION, alibabaLoginStatus } from "../browser.js";
import { importAlibabaCookies } from "./browser-import.js";

export const RFQ_HOME = "https://sourcing.alibaba.com/rfq_search_list.htm";
export const RFQ_PARTITION = "persist:rfq-alibaba";
export function alibabaNavigationAllowed(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && (u.hostname === "alibaba.com" || u.hostname.endsWith(".alibaba.com"));
  } catch { return false; }
}
const rfqAllowed = (value) => alibabaNavigationAllowed(value) && ["sourcing.alibaba.com", "rfqposting.alibaba.com"].includes(new URL(value).hostname);
const toolbarFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-toolbar.html");
const BAR_HEIGHT = 76;
const sensitiveQuery = /(?:^|_)(?:token|auth|code|session|key|password|secret|jwt|ticket)(?:$|_)/i;
// 登录跳转中的 ticket/code 不能显示在工具栏或进入剪贴板。RFQ 链接
// 保留商品、搜索等普通查询参数，以便用户完整复制给同事核对。
export function shareableBrowserUrl(value) {
  if (!alibabaNavigationAllowed(value)) return null;
  const url = new URL(value);
  if (/login|signin|passport|account/i.test(url.hostname + url.pathname)) return null;
  if ([...url.searchParams.keys()].some((key) => sensitiveQuery.test(key))) return null;
  // 页面片段可能携带 OAuth 回调令牌；复制链接只需要稳定的页面地址。
  url.hash = "";
  return url.href;
}

/** 应用自有、可见的浏览器窗口。持久分区只由 Chromium 保存登录会话，
 * 不复制/读取用户 Chrome 身份。依赖注入便于在真实 Electron 和 Node 测试复用。
 * 没有 remote-debugging-port：CDP 只附着这个 webContents，不能控制工作台。
 */
export class EmbeddedBrowser {
  constructor({ BrowserWindow, WebContentsView, ipcMain, clipboard, authorize, sessionPersistence = () => null, beforeNavigate = async () => {}, navigationAllowed = alibabaNavigationAllowed, automationAllowed = rfqAllowed,
    shareableUrl = shareableBrowserUrl, home = RFQ_HOME }) {
    Object.assign(this, { BrowserWindow, WebContentsView, ipcMain, clipboard, authorize, sessionPersistence, beforeNavigate, navigationAllowed, automationAllowed, shareableUrl, home });
    this.window = null; this.pageView = null; this.lease = null; this.closed = false; this.error = null; this.queue = Promise.resolve(); this.generation = 0;
    this.inspection = null; this.inspecting = false; this.inspectionAttempt = null; this.inspectionError = null;
  }
  pageContents() { return this.pageView?.webContents || (this.window && !this.window.isDestroyed() ? this.window.webContents : null); }
  updateToolbar() {
    if (!this.pageView || !this.window || this.window.isDestroyed()) return;
    const wc = this.pageContents(), current = wc.getURL(), safe = this.shareableUrl(current);
    let displayUrl = "";
    try { displayUrl = safe || (alibabaNavigationAllowed(current) ? new URL(current).origin + new URL(current).pathname : ""); } catch {}
    if (!this.window.webContents.isDestroyed()) this.window.webContents.send("rfq-tab-state", {
      title: wc.getTitle()?.slice(0, 120) || "Alibaba", url: displayUrl, canCopy: Boolean(safe), loading: wc.isLoading(),
      canGoBack: Boolean(wc.navigationHistory?.canGoBack()), canGoForward: Boolean(wc.navigationHistory?.canGoForward()),
      busy: this.authorize().busy === true || this.inspecting
    });
  }
  info() {
    const wc = this.pageContents();
    // 登录页 URL 可能带认证参数，公共状态只返回 origin，不回显查询串。
    let origin = "", page = "", pageKind = "blank";
    try {
      const url = new URL(wc?.getURL()); origin = url.origin;
      // 不把登录链接中的认证查询参数暴露给工作台。
      page = origin + url.pathname;
      pageKind = /login|signin|passport/i.test(page) ? "login" : this.automationAllowed(url.href) ? "rfq" : "alibaba";
    } catch {}
    // 尚未创建窗口时两边的 URL 都是 undefined，不能据此读取空结果。
    const inspection = this.inspection && this.inspection.url === wc?.getURL() ? this.inspection.result : null;
    return { provider: "electron-cdp", opened: Boolean(wc), visible: Boolean(wc && this.window.isVisible()), origin, page, pageKind,
      loading: Boolean(wc?.isLoading?.()), title: wc?.getTitle()?.slice(0, 200) || "", partition: RFQ_PARTITION,
      chromium: process.versions.chrome || null, cdpAttached: Boolean(wc?.debugger.isAttached()),
      sessionPersistence: this.sessionPersistence(),
      browserEnabled: this.authorize().browser === true, busy: this.authorize().busy === true || this.inspecting, checking: this.inspecting,
      canGoBack: Boolean(wc?.navigationHistory?.canGoBack()), canGoForward: Boolean(wc?.navigationHistory?.canGoForward()),
      inspection, inspectionError: this.inspectionAttempt?.url === wc?.getURL() ? this.inspectionError : null, error: this.error };
  }
  ensure() {
    if (this.closed) throw new Error("应用正在退出");
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new this.BrowserWindow({ width: 1280, height: 900, minWidth: 800, minHeight: 600, show: false,
      title: "阿里巴巴 · RFQ 助手", backgroundColor: "#ffffff",
      webPreferences: { ...(this.WebContentsView ? { preload: path.join(path.dirname(toolbarFile), "browser-toolbar-preload.cjs") } : { partition: RFQ_PARTITION }),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        webSecurity: true, backgroundThrottling: false } });
    this.window = win;
    if (this.WebContentsView) {
      // 本地工具栏和远程 Alibaba 分为两个 webContents。网页仍只在
      // persist:rfq-alibaba 会话里，原来的 CDP/登录/报价权限只作用于它。
      this.pageView = new this.WebContentsView({ webPreferences: { partition: RFQ_PARTITION,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
      win.contentView.addChildView(this.pageView);
      const layout = () => { const [width, height] = win.getContentSize(); this.pageView?.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(1, height - BAR_HEIGHT) }); };
      win.on("resize", layout); layout();
      win.webContents.on("did-finish-load", () => this.updateToolbar());
      void win.loadFile(toolbarFile).catch(() => { this.error = "浏览器标签栏加载失败，请重启应用"; });
      if (this.ipcMain && this.clipboard) {
        this.copyHandler = (event) => {
          if (event.sender !== win.webContents) throw new Error("浏览器标签栏来源无效");
          const url = this.shareableUrl(this.pageContents()?.getURL());
          if (!url) return { ok: false };
          this.clipboard.writeText(url); return { ok: true };
        };
        this.ipcMain.handle("rfq-tab-copy", this.copyHandler);
        // 导航请求只来自应用自己的工具栏。复用 manual() 的任务互斥、
        // 历史可用性和授权检查；网页无 preload，不能发送此 IPC。
        this.navigateHandler = async (event, action) => {
          if (event.sender !== win.webContents) throw new Error("浏览器标签栏来源无效");
          if (!["back", "forward"].includes(action)) return { ok: false, error: "浏览器导航操作无效" };
          try { await this.manual({ action }); this.updateToolbar(); return { ok: true }; }
          catch (error) { this.updateToolbar(); return { ok: false, error: error.message }; }
        };
        this.ipcMain.handle("rfq-tab-navigate", this.navigateHandler);
      }
    }
    const wc = this.pageContents();
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    // 外部站点和协议不能进入这份登录会话。Alibaba 登录跳转可以手动完成。
    const guard = (event, url) => { if (!this.navigationAllowed(url)) { event.preventDefault(); this.error = "已阻止非 Alibaba 页面，请在个人浏览器打开外部链接"; } };
    wc.on("will-navigate", guard); wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url }) => {
      if (this.navigationAllowed(url)) {
        // 使用同一窗口，避免扫描器误选弹出的页面。运行任务期间不切走页面。
        if (!this.authorize().busy) void this.open(url).catch(() => {});
        else this.error = "任务正在使用页面，请先停止任务再打开链接";
      }
      return { action: "deny" };
    });
    wc.on("render-process-gone", () => { this.invalidate(); this.error = "内置浏览器已中断，请重新打开并检测"; });
    wc.on("did-start-navigation", (_event, _url, _sameDocument, mainFrame) => {
      if (mainFrame) { this.inspection = null; this.inspectionAttempt = null; this.inspectionError = null; this.updateToolbar(); }
    });
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading", "did-finish-load"]) wc.on(event, () => this.updateToolbar());
    wc.on("did-fail-load", (_e, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.error = "Alibaba 页面加载失败，请检查网络后重新打开";
    });
    win.on("close", (event) => { if (!this.closed) { event.preventDefault(); win.hide(); } });
    win.on("closed", () => {
      this.invalidate();
      if (this.pageView && !this.pageView.webContents.isDestroyed()) this.pageView.webContents.close();
      this.pageView = null; this.window = null;
      if (this.copyHandler) { this.ipcMain.removeHandler("rfq-tab-copy"); this.copyHandler = null; }
      if (this.navigateHandler) { this.ipcMain.removeHandler("rfq-tab-navigate"); this.navigateHandler = null; }
    });
    return win;
  }
  async navigate(url) {
    if (!this.navigationAllowed(url)) throw new Error("仅允许打开 HTTPS Alibaba 页面");
    this.ensure(); const wc = this.pageContents();
    this.error = null;
    // loadURL 等全部资源可能很慢；采集只需 DOM ready。必须先安装监听，
    // 并清理所有终态，避免导航失败留下永远 pending 的请求。
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); wc.removeListener("dom-ready", ready); wc.removeListener("did-fail-load", failed); error ? reject(error) : resolve(); };
      const ready = () => done();
      const failed = (_e, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) done(new Error("内置浏览器页面加载失败，请检查网络或登录")); };
      const timer = setTimeout(() => { wc.stop(); done(new Error("内置浏览器页面加载超时")); }, 30000);
      wc.once("dom-ready", ready); wc.on("did-fail-load", failed);
      wc.loadURL(url).catch(() => done(new Error("内置浏览器导航中断，请人工检查页面")));
    });
    return { url: wc.getURL() };
  }
  async open(url) {
    const win = this.ensure(); win.show(); win.focus();
    if (url || !this.pageContents().getURL()) {
      if (this.authorize().busy || this.inspecting) throw new Error("请先停止任务或等待检测完成，再切换内置浏览器页面");
      // 首次启动时若持久分区的 Cookie 服务超时，可见浏览器创建后再试
      // 一次会话恢复；必须发生在首次 Alibaba 导航之前。
      await this.beforeNavigate();
      this.invalidate(); await this.navigate(url || this.home); this.pageContents().focus?.();
    }
    return this.info();
  }
  async manual({ action, url } = {}) {
    if (!["back", "forward", "reload", "hide", "navigate"].includes(action)) throw new Error("浏览器导航操作无效");
    if (action === "navigate") {
      if (typeof url !== "string") throw new Error("请填写 Alibaba 网址");
      return this.open(url);
    }
    if (!this.window || this.window.isDestroyed()) throw new Error("请先打开浏览器");
    if (action === "hide") { this.window.hide(); return this.info(); }
    if (this.authorize().busy || this.inspecting) throw new Error("任务或检测正在使用浏览器，请结束后再导航");
    const wc = this.pageContents(), history = wc.navigationHistory;
    if (action === "back" && !history.canGoBack()) throw new Error("没有可以后退的页面");
    if (action === "forward" && !history.canGoForward()) throw new Error("没有可以前进的页面");
    this.invalidate(false); this.inspection = null; this.error = null;
    if (action === "reload") wc.reload();
    else if (action === "back") history.goBack();
    else history.goForward();
    return this.info();
  }
  async inspect() {
    // 工作台的只读检测与 Agent 总开关分开：固定读取当前页面文字，
    // 不接收调用者脚本、不创建 lease、不导航，也不访问身份存储。
    if (this.closed || this.authorize().busy || this.inspecting) throw new Error("任务或检测正在使用浏览器，请稍后检测");
    const wc = this.pageContents();
    if (!wc) throw new Error("请先打开浏览器并登录");
    const url = wc.getURL();
    this.inspectionAttempt = { url, at: Date.now() }; this.inspectionError = null;
    if (!this.automationAllowed(url)) {
      const login = /login|signin|passport/i.test(url);
      this.inspection = { url, result: { status: login ? "login_required" : "unsupported_page", detail: login ? "当前在登录页面，请手动完成登录后打开 RFQ 列表" : "请打开 RFQ 列表后检测登录与页面状态", checkedAt: new Date().toISOString() } };
      return this.info();
    }
    if (wc.isLoading?.()) throw new Error("页面正在加载，请稍后检测");
    this.inspecting = true; this.invalidate(false);
    const generation = this.generation;
    try {
      wc.debugger.attach("1.3");
      const read = await wc.debugger.sendCommand("Runtime.evaluate", { expression: ALIBABA_LOGIN_EVIDENCE_EXPRESSION, returnByValue: true, timeout: 5000 });
      if (read.exceptionDetails) throw new Error("页面文字读取失败");
      if (wc.getURL() !== url || generation !== this.generation) throw new Error("页面或授权已变化，请重新检测");
      const evidence = read.result?.value;
      const status = alibabaLoginStatus(evidence, url);
      const detail = {
        logged_in: "当前页面账号导航显示已登录；运行任务时仍会再次检查",
        login_required: "当前页面显示登录入口或未登录提示，请在浏览器手动登录",
        captcha: "检测到验证码或安全验证，请在浏览器手动处理",
        unknown: "页面未显示明确的登录标记，请确认账号后再运行 Agent"
      }[status];
      this.inspection = { url, result: { status, detail, checkedAt: new Date().toISOString() } };
    } finally { this.inspecting = false; if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); }
    return this.info();
  }
  async status(force = false) {
    // 查看状态不会创建窗口、跳转页面或授权 Agent。登录检查复用固定的
    // 只读 inspect；窗口加载中或任务占用时只返回快照，避免抢占任务 CDP。
    const state = this.info();
    if (this.closed || !state.opened || state.loading || state.busy) return state;
    const url = this.pageContents().getURL();
    // 界面每 2 秒取状态，但同页最多每 10 秒读取一次。失败也限频，页面
    // 导航立即使缓存失效；主动“刷新状态”可跳过限频。
    if (!force && this.inspectionAttempt?.url === url && Date.now() - this.inspectionAttempt.at < 10000) return state;
    this.inspectionAttempt = { url, at: Date.now() }; this.inspectionError = null;
    try { await this.inspect(); }
    catch { this.inspectionError = "暂时无法确认登录状态，请检查页面后刷新状态"; }
    return this.info();
  }
  async importLogin(prepared) {
    if (this.closed || this.authorize().busy || this.inspecting) throw new Error("请先停止任务或等待检查完成，再导入登录数据");
    this.ensure(); const wc = this.pageContents();
    if (wc.isLoading?.()) throw new Error("浏览器正在加载，请稍后导入");
    // 复用检查互斥槽位，阻止自动状态检查/任务启动抢占导入；不授予 Agent。
    this.inspecting = true; this.invalidate();
    this.inspection = null; this.inspectionAttempt = null; this.inspectionError = null;
    try {
      const result = await importAlibabaCookies(wc.session, prepared);
      return result;
    } finally { this.inspecting = false; }
  }
  async flushSession() {
    const wc = this.pageContents();
    if (!wc || wc.isDestroyed()) return;
    // Chromium 会延迟写入持久 Cookie 和 DOM Storage。正常退出时主动
    // 落盘，避免用户刚登录就退出时丢失尚未写入的数据。网站签发的会话
    // Cookie 或服务端主动失效仍可能要求再次登录，不能在这里改写有效期。
    await wc.session.cookies.flushStore();
    await wc.session.flushStorageData();
  }
  invalidate(stop = true) {
    this.generation++;
    this.lease = null;
    const wc = this.pageContents();
    if (wc && !wc.isDestroyed()) { if (stop) wc.stop(); if (wc.debugger.isAttached()) wc.debugger.detach(); }
  }
  command(payload) {
    // 任务请求串行执行。开关关闭会立刻撤销 lease；队列中尚未执行的操作
    // 必须重新检查授权，不能因为请求进入队列时获准就继续点击或填写。
    const generation = this.generation;
    const result = this.queue.then(() => this.execute(payload, generation));
    this.queue = result.catch(() => {}); return result;
  }
  async execute(p, generation) {
    const shapes = { connect: ["action"], release: ["action", "lease"], state: ["action", "lease"],
      goto: ["action", "lease", "url"], evaluate: ["action", "lease", "expression", "mutation", "expectedUrl"],
      screenshot: ["action", "lease", "fullPage", "expectedUrl"],
      elementScreenshot: ["action", "lease", "selector", "index", "expectedUrl"] };
    if (!p || typeof p.action !== "string" || !Object.hasOwn(shapes, p.action) || Object.keys(p).some((key) => !shapes[p.action].includes(key))) throw new Error("内置浏览器操作参数无效");
    if (p.action === "release") { if (p.lease === this.lease) this.invalidate(false); return { released: true }; }
    if (generation !== this.generation) throw new Error("内置浏览器连接已失效，请重新检测");
    const permission = this.authorize();
    if (this.closed || !permission.browser || permission.stopping || this.inspecting) throw new Error("内置浏览器控制已关闭、检测中或任务正在停止");
    if (p.action === "connect") {
      const win = this.ensure();
      // 首次连接创建可见窗口；后续轮询保持原显示状态，不反复抢焦点。
      if (!this.pageContents().getURL()) { win.show(); await this.navigate(this.home); }
      if (generation !== this.generation || !this.authorize().browser || this.authorize().stopping) throw new Error("内置浏览器授权已变化");
      this.invalidate(false); this.lease = crypto.randomBytes(24).toString("hex");
      const wc = this.pageContents();
      return { lease: this.lease, id: wc.id, url: wc.getURL(), title: wc.getTitle() };
    }
    if (!this.lease || p.lease !== this.lease || !this.window || this.window.isDestroyed()) throw new Error("内置浏览器连接已失效，请重新检测");
    const wc = this.pageContents();
    if (p.action === "state") return { url: wc.getURL() };
    if (p.action === "goto") {
      if (typeof p.url !== "string" || !this.automationAllowed(p.url)) throw new Error("自动任务只允许打开 Alibaba RFQ 页面");
      const result = await this.navigate(p.url);
      if (p.lease !== this.lease || !this.authorize().browser || this.authorize().stopping) throw new Error("内置浏览器连接已失效，请重新检测");
      return result;
    }
    if (!this.automationAllowed(wc.getURL()) || p.expectedUrl !== wc.getURL()) throw new Error("内置浏览器页面已变化或需要登录，请停止任务并人工检查");
    if (p.action === "evaluate" && (typeof p.expression !== "string" || p.expression.length > 12000 || typeof p.mutation !== "boolean")) throw new Error("页面操作参数无效");
    if (p.mutation && !permission.quote) throw new Error("逐单报价授权已关闭，禁止填写或点击");
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    if (p.action === "elementScreenshot") {
      if (typeof p.selector !== "string" || !p.selector || p.selector.length > 512 ||
          !Number.isInteger(p.index) || p.index < 0 || p.index >= 32) throw new Error("附件截图参数无效");
      // 截图只覆盖 Alibaba RFQ 页面中的目标元素。先滚到可见位置，
      // 再用 CSS 像素裁剪当前视口，避免把整页或登录信息写进附件目录。
      const expression = `(() => {
        const element = document.querySelectorAll(${JSON.stringify(p.selector)})[${p.index}];
        if (!element) return null;
        element.scrollIntoView({ block: "center", inline: "center" });
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
        return { x, y, width: Math.min(rect.right, innerWidth) - x,
          height: Math.min(rect.bottom, innerHeight) - y };
      })()`;
      const measured = await wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false, timeout: 10000 });
      if (measured.exceptionDetails) throw new Error("附件区域无法定位");
      const box = measured.result?.value;
      if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
          box.width < 1 || box.height < 1 || box.width > 2560 || box.height > 2560) throw new Error("附件区域不可见或尺寸异常");
      const result = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
      return { data: result.data };
    }
    if (p.action === "screenshot") {
      if (typeof p.fullPage !== "boolean") throw new Error("截图参数无效");
      let clip;
      if (p.fullPage) {
        const metrics = await wc.debugger.sendCommand("Page.getLayoutMetrics");
        const size = metrics.cssContentSize || metrics.contentSize;
        // 保留全页证据，限制异常长页面造成的内存占用。
        clip = { x: 0, y: 0, width: Math.min(size.width, 2560), height: Math.min(size.height, 12000), scale: 1 };
      }
      const result = await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: p.fullPage, ...(clip ? { clip } : {}) });
      return { data: result.data };
    }
    const result = await wc.debugger.sendCommand("Runtime.evaluate", { expression: p.expression, returnByValue: true, awaitPromise: false, timeout: 10000 });
    if (result.exceptionDetails) throw new Error("页面操作失败，请检查 Alibaba 页面字段");
    return { value: result.result?.value };
  }
  close() { this.closed = true; this.invalidate(); if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}
