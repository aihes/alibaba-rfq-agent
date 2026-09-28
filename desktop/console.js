import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";

const now = () => new Date().toISOString();
const attention = /CAPTCHA|verification challenge|login is required|Cannot attach to the existing Chrome session|Browser connection or Alibaba requires human attention|Chrome Bridge or Alibaba requires human attention|needs_manual_review|Submit was clicked, but success could not be verified|内置浏览器|页面操作失败/i;
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** 普通用户只需知道窗口和账号是否可用；CDP 附着仅是短暂的内部状态，
 * 不能用“当前未附着”推断浏览器故障，也不能用 Agent 开关推断登录态。
 */
function browserChecks(b) {
  const result = b.loading ? null : b.inspection;
  const loginStates = { logged_in: "已登录", login_required: "需要登录", captcha: "需要验证", unsupported_page: "请打开 RFQ 列表", unknown: "待确认" };
  const loginState = !b.opened ? "请先打开浏览器" : b.loading ? "页面加载中" : b.inspectionError ? "暂时无法确认" : result ? loginStates[result.status] : b.checking ? "正在检查" : b.busy ? "任务运行中" : "正在确认";
  return [
    { key: "bridge", ok: b.opened && !b.error, label: "阿里巴巴浏览器", state: !b.opened ? "尚未打开" : b.error ? "页面加载异常" : b.loading ? "页面加载中" : "已打开",
      detail: b.error || (b.opened ? b.title || "阿里巴巴窗口已打开，关闭窗口会保留在后台" : "打开应用自带的浏览器，使用你的 Alibaba 账号登录"), action: "open_browser", actionLabel: b.opened ? "显示浏览器" : "打开浏览器" },
    { key: "login", ok: result?.status === "logged_in" && !b.inspectionError, label: "Alibaba 账号", state: loginState,
      detail: !b.opened ? "打开浏览器后自动检查登录状态" : b.loading ? "等待页面加载完成后自动检查" : b.inspectionError || result?.detail || (b.busy && !b.checking ? "任务完成后自动更新登录状态" : "正在读取当前页面的登录提示"),
      checkedAt: result?.checkedAt || null,
      ...(b.opened && !b.loading && result?.status !== "logged_in" ? { action: result?.status === "unsupported_page" ? "open_rfq" : "open_browser", actionLabel: result?.status === "unsupported_page" ? "打开 RFQ 列表" : result?.status === "captcha" ? "去处理验证" : "打开浏览器登录" } : {}) }
  ];
}

/** 与 Web 控制台相同的权限边界。每个任务独立进程组，退出只清理本
 * 应用创建的任务，不杀 Chrome。任务日志永远不包含传入的环境密钥。
 */
export class OperatorConsole {
  constructor({ resources, workspace, environment = () => ({}), notify, spawnProcess = spawn, desktop = false, embeddedBrowser, revokeBrowser = () => {} }) {
    Object.assign(this, { resources, workspace, environment, notify, spawnProcess, desktop, embeddedBrowser, revokeBrowser });
    this.opsDir = path.join(workspace, "data/case-catalog/ops");
    this.settingsFile = path.join(this.opsDir, "settings.json");
    this.lastFile = path.join(this.opsDir, "last-run.json");
    this.settings = { browserEnabled: false, quoteEnabled: false, alertsEnabled: true, notificationsEnabled: false };
    const saved = read(this.settingsFile, {});
    for (const key of ["browserEnabled", "alertsEnabled", "notificationsEnabled"]) if (typeof saved[key] === "boolean") this.settings[key] = saved[key];
    this.searchTerms = read(path.join(workspace, "config/default.json"), {}).searchTerms || [];
    this.current = null; this.process = null; this.probe = null; this.generation = 0; this.closed = false;
    this.children = new Set();
    this.last = read(this.lastFile, null);
    if (["running", "stopping", "indexing"].includes(this.last?.status)) {
      this.last = { ...this.last, status: "interrupted", finishedAt: now(), alert: "应用重启，原任务已中断；提交状态需要人工核对" };
      write(this.lastFile, this.last);
    }
  }
  env(extra = {}) {
    return { ...process.env, ...this.environment(), RFQ_WORKSPACE_DIR: this.workspace,
      ...(this.desktop ? { ELECTRON_RUN_AS_NODE: "1", RFQ_DESKTOP: "1" } : {}),
      AUTO_CONTACT_MODE: "off", ALLOW_LIVE_SUBMIT: "false", AUTO_CONTACT_ACK: "",
      RFQ_CONSOLE_SETTINGS_FILE: this.settingsFile, RFQ_CONSOLE_URL: this.url,
      ...extra };
  }
  kill(child, signal = "SIGTERM") {
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else process.kill(-child.pid, signal);
    } catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  spawn(script, args = [], options = {}) {
    if (this.closed) throw new Error("应用正在退出");
    const child = this.spawnProcess(process.execPath, [path.join(this.resources, script), ...args], {
      cwd: this.workspace, env: this.env(), detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return child;
  }
  async runJson(script, args = [], timeout = 12000, onSpawn) {
    const child = this.spawn(script, args);
    onSpawn?.(child);
    return new Promise((resolve, reject) => {
      let out = "", settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { this.kill(child, "SIGKILL"); finish(new Error("操作超时，请查看连接与本机日志")); }, timeout);
      child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 2 * 1024 * 1024) { this.kill(child, "SIGKILL"); finish(new Error("操作输出过大")); } });
      child.stderr.resume();
      child.on("error", () => finish(new Error("无法启动内置任务")));
      child.on("close", (code) => {
        if (code !== 0) return finish(new Error("操作失败，请查看本机日志"));
        try { finish(null, JSON.parse(out.slice(out.indexOf("{")))); } catch { finish(new Error("操作返回格式无效")); }
      });
    });
  }
  tail(run = this.current || this.last) {
    if (!run) return "";
    try {
      const file = path.join(this.opsDir, `${run.id}.log`);
      const fd = fs.openSync(file, "r");
      try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, 24000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString("utf8").slice(-20000); }
      finally { fs.closeSync(fd); }
    } catch { return ""; }
  }
  snapshot() {
    return { settings: this.settings, searchTerms: this.searchTerms, run: this.current || this.last,
      log: this.tail(), serverTime: now(), envChecking: Boolean(this.probe || this.embeddedBrowser?.inspecting || this.browserImporting),
      notifications: { supported: this.desktop || process.platform === "darwin", last: read(path.join(this.opsDir, "notification-status.json"), null) } };
  }
  updateSettings(changes) {
    if (!changes || Array.isArray(changes) || !Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !(key in this.settings) || typeof value !== "boolean")) throw new Error("开关参数无效");
    if (changes.quoteEnabled && !(changes.browserEnabled ?? this.settings.browserEnabled)) throw new Error("请先开启浏览器操作");
    if ("browserEnabled" in changes) { this.cache = null; this.generation++; }
    this.settings = { ...this.settings, ...changes };
    if (changes.browserEnabled === false || changes.quoteEnabled === false) this.revokeBrowser();
    if (!this.settings.browserEnabled) { this.settings.quoteEnabled = false; this.kill(this.probe, "SIGKILL"); }
    write(this.settingsFile, this.settings);
    if (this.current && ((!this.settings.browserEnabled && this.current.kind !== "refresh") || (!this.settings.quoteEnabled && this.current.kind.startsWith("quote_")))) this.stop();
    return this.snapshot();
  }
  assertIdle() { if (this.closed) throw new Error("应用正在退出"); if (this.current || this.quotePreparing) throw new Error("已有任务正在运行，请先停止"); if (this.probe || this.embeddedBrowser?.inspecting || this.browserImporting) throw new Error("环境检测或登录导入正在进行，请稍后再试"); }
  async browserStatus(force = false) {
    // 任务占用时保留已有检查结果，不打断运行。Agent 权限不影响只读状态。
    const browser = this.closed || this.current || this.quotePreparing || this.probe || this.browserImporting
      ? this.embeddedBrowser.info() : await this.embeddedBrowser.status(force);
    return { ...browser, checks: browserChecks(browser) };
  }
  async envCheck(force = false) {
    const embedded = Boolean(this.embeddedBrowser);
    const checks = [
      { key: "node", ok: true, label: this.desktop ? "内置运行环境" : "Node.js 运行环境", detail: this.desktop ? `Node ${process.versions.node} · Electron ${process.versions.electron || "开发测试环境"} · Chromium ${process.versions.chrome || "见浏览器页"}` : process.version, help: "桌面版随应用提供，无需另装开发环境" },
      { key: "plugin", ok: fs.existsSync(path.join(this.resources, embedded ? "src/electron-browser.js" : "plugins/alibaba-rfq-midscene/scripts/cli.mjs")), label: embedded ? "内置 Chromium 适配器" : "Midscene 本地适配脚本", detail: embedded ? "随应用提供，无需安装 Chrome 插件" : "Chrome 扩展仍需按下方引导加载" },
      { key: "bridge", ok: false, label: embedded ? "阿里巴巴浏览器" : "Chrome Bridge 连接", detail: "未检测" },
      { key: "login", ok: false, label: "Alibaba 账号", detail: "未检测" }
    ];
    if (embedded) {
      const state = this.embeddedBrowser.info();
      checks.push({ key: "window", ok: state.opened, required: false, label: "浏览器窗口与当前页面", detail: state.opened ? `${state.visible ? "前台显示" : "后台保留"} · ${state.page || state.origin || "页面加载中"}` : "尚未打开浏览器", help: "在左侧「浏览器」打开、导航或检测页面；关闭窗口会保留会话" });
      checks.push({ key: "session", ok: true, label: "独立登录会话", detail: "Alibaba 专用持久会话 · 与个人 Chrome 分开", help: "升级到内置浏览器后须在这里登录；应用不复制个人浏览器身份数据" });
    }
    if (this.desktop) {
      const env = this.environment();
      const localClaude = env.AGENT_PROVIDER === "local-claude-sdk", modelReady = localClaude ? Boolean(env.LOCAL_CLAUDE_EXECUTABLE) : Boolean(env.MODEL_API_KEY);
      checks.push({ key: "model", ok: modelReady, required: false, label: "需求分析模型",
        detail: modelReady ? localClaude ? `本机 Claude · ${env.LOCAL_CLAUDE_MODEL || "继承用户模型"}` : `${env.MODEL_NAME || "已配置模型"} · ${env.RFQ_MODEL_CONFIG_SOURCE || "已保存配置"}`
          : localClaude ? "未找到本机 Claude；请安装或在设置中选择 GLM HTTP" : "未配置模型 API Key",
        help: "在「设置」测试本机 Claude 或 GLM HTTP；此处只检查配置，不触发模型调用" });
      checks.push({ key: "ocr", ok: env.OCR_PROVIDER === "off" || Boolean(env.GLM_OCR_API_KEY), required: false, label: "图片文字识别", detail: env.OCR_PROVIDER === "off" ? "图片识别已关闭" : env.GLM_OCR_API_KEY ? "GLM OCR · API Key 可用" : "GLM OCR · 尚未配置 API Key", help: "未调用 OCR 服务，不产生 API 用量；在设置页查看密钥来源" });
      checks.push({ key: "port", ok: Boolean(env.QUOTE_PORT), required: false, label: "报价交货地点", detail: env.QUOTE_PORT || "尚未核实交货地点 / 港口", help: "缺失时可浏览或扫描，但报价须先人工核实并在设置页填写" });
    }
    const report = (status, reason) => { if (reason) checks.filter((x) => ["bridge", "login"].includes(x.key)).forEach((x) => { x.detail = reason; }); return { ok: checks.filter((x) => x.required !== false).every((x) => x.ok), checks, status, checkedAt: now() }; };
    if (this.closed) return report("skipped", "应用正在退出");
    if (embedded) {
      // 桌面版读取自有窗口，无需启动需要 Agent 授权的 status worker。
      // Web / CLI 仍走下方授权 Bridge 路径，不能借状态查询连接个人 Chrome。
      const browser = await this.browserStatus(force);
      checks.splice(2, 2, ...browser.checks);
      return { ...report("checked"), browser };
    }
    if (!this.settings.browserEnabled) return report("skipped", "浏览器控制已关闭；开启后才检测连接和登录态");
    if (this.current || this.quotePreparing || this.probe || this.embeddedBrowser?.inspecting) return report("skipped", "任务或检测正在进行；完成后再检测");
    if (!force && this.cache && Date.now() - this.cache.at < 20000) return this.cache.value;
    const generation = this.generation;
    try {
      const result = await this.runJson("plugins/alibaba-rfq-midscene/scripts/cli.mjs", ["status"], 30000, (child) => { this.probe = child; });
      if (generation !== this.generation || !this.settings.browserEnabled) return report("skipped", "授权已变化，本次检测已取消");
      checks[2].ok = result.connected === true; checks[2].detail = result.connected ? `已连接（${embedded ? "应用窗口" : "tab"} ${result.tabId}）` : embedded ? "请打开应用内的阿里巴巴浏览器" : "请在 Chrome 中开启 Midscene Bridge";
      checks[3].ok = result.connected === true && result.loggedIn === true;
      checks[3].detail = checks[3].ok ? "当前 RFQ 页面已检测到登录标记" : /verification challenge/i.test(result.attention) ? "检测到验证码或安全验证，请停止任务并手动处理" : /login is required/i.test(result.attention) ? "尚未登录或登录失效，请在内置浏览器手动登录" : result.attention || (embedded ? "请在应用内的阿里巴巴窗口手动登录" : "请人工在监听 Chrome 中登录 Alibaba");
      checks[2].help = "这是本次实际连接检测；任务会再次连接并检查页面，空闲时 CDP 会断开";
      checks[3].help = "进入浏览器页可单独执行只读登录检测，无需开启 Agent 控制";
    } catch {
      return generation !== this.generation || !this.settings.browserEnabled
        ? report("skipped", "授权已变化，本次检测已取消")
        : report("checked", embedded ? "检测失败或超时，请打开内置浏览器，检查网络与登录状态" : "检测失败或超时，请检查 Chrome、插件和登录状态");
    }
    finally { this.probe = null; }
    const value = report("checked"); this.cache = { at: Date.now(), value }; return value;
  }
  listQuotes() { return this.runJson("scripts/console-quote.mjs", ["list"]); }
  reviewQuote(id) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id || "")) throw new Error("草稿 ID 无效"); return this.runJson("scripts/console-quote.mjs", ["review", id]); }
  async startQuote(request) {
    this.assertIdle();
    if (!["fill", "submit"].includes(request?.kind) || request.approved !== true) throw new Error("请先核对该 RFQ 的报价字段");
    if (!this.settings.browserEnabled || !this.settings.quoteEnabled) throw new Error("请先开启浏览器操作和逐单报价");
    // 审阅是异步读取，必须先占用槽位；关闭权限后也要再次检查。
    this.quotePreparing = true;
    try {
      const review = await this.reviewQuote(request.draftId);
      if (this.closed || !this.settings.browserEnabled || !this.settings.quoteEnabled) throw new Error("浏览器报价授权已关闭");
      if (request.reviewHash !== review.reviewHash || request.confirmation !== review.rfq.id) throw new Error("草稿已变化或 RFQ ID 确认不匹配，请重新核对");
      if (!review[request.kind === "fill" ? "fillEligible" : "submitEligible"]) throw new Error("当前草稿不允许执行该报价动作");
      const extra = request.kind === "submit" ? { AUTO_CONTACT_MODE: "submit", ALLOW_LIVE_SUBMIT: "true", AUTO_CONTACT_ACK: "I_UNDERSTAND_AUTO_QUOTES_ARE_SENT", AUTO_CONTACT_CATEGORIES: review.quote.categoryId, QUOTE_PORT: review.draft.port } : {};
      return this.launch({ kind: `quote_${request.kind}`, draftId: request.draftId, rfqId: review.rfq.id }, "scripts/console-quote.mjs", [request.kind, request.draftId, review.reviewHash, review.rfq.id], extra);
    } finally { this.quotePreparing = false; }
  }
  start(request) {
    this.assertIdle();
    const { kind, term = this.searchTerms[0], limit = 1 } = request || {};
    if (!["refresh", "scan", "once", "watch"].includes(kind) || ![...this.searchTerms, "__all__"].includes(term) || !Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error("任务参数无效");
    if (kind !== "refresh" && !this.settings.browserEnabled) throw new Error("请先开启浏览器操作");
    if (this.desktop && ["once", "watch"].includes(kind)) {
      const env = this.environment();
      if (env.AGENT_PROVIDER === "local-claude-sdk" && !env.LOCAL_CLAUDE_EXECUTABLE) throw new Error("未找到本机 Claude，请安装后重试或在设置中选择 GLM HTTP");
      if (env.AGENT_PROVIDER !== "local-claude-sdk" && !env.MODEL_API_KEY) throw new Error("请先在模型设置中填写 API Key 并保存");
    }
    const script = kind === "refresh" ? "scripts/build_case_catalog.mjs" : kind === "scan" ? (term === "__all__" ? "scripts/scan_all_terms.mjs" : "plugins/alibaba-rfq-midscene/scripts/cli.mjs") : "src/cli.js";
    const args = kind === "scan" && term !== "__all__" ? ["scan", "--term", term, "--max", "10"] : ["once", "watch"].includes(kind) ? [kind] : [];
    return this.launch({ kind, term: kind === "refresh" ? null : term, limit }, script, args,
      { SEARCH_TERMS: term === "__all__" ? this.searchTerms.join(",") : term, MAX_NEW_RFQS_PER_CYCLE: String(limit), MAX_CARDS_PER_SEARCH: "10" });
  }
  launch(fields, script, args, extra) {
    const run = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 12), ...fields, status: "running", startedAt: now(), finishedAt: null, exitCode: null, alert: null };
    fs.mkdirSync(this.opsDir, { recursive: true });
    const fd = fs.openSync(path.join(this.opsDir, `${run.id}.log`), "w");
    let child;
    try { child = this.spawn(script, args, { env: this.env(extra), stdio: ["ignore", fd, fd] }); } finally { fs.closeSync(fd); }
    this.current = run; this.process = child; write(this.lastFile, run);
    let finishing = false;
    const done = async (code) => {
      if (finishing) return;
      finishing = true;
      if (this.process !== child) return;
      const stopped = run.status === "stopping";
      if (["once", "watch", "quote_fill", "quote_submit"].includes(run.kind) && !this.closed) {
        run.status = "indexing"; write(this.lastFile, run);
        try { await this.runJson("scripts/build_case_catalog.mjs", [], 120000); } catch { run.alert = "CASE 列表更新失败"; }
      }
      const log = this.tail(run);
      run.exitCode = code; run.finishedAt = now();
      run.status = stopped ? (run.kind === "quote_submit" ? "attention" : "stopped") : attention.test(log) ? "attention" : code === 0 && !run.alert ? "completed" : "failed";
      if (stopped && run.kind === "quote_submit") run.alert = "提交过程被中断，请核对页面和记录，不要直接重试";
      if (!stopped && code === 0 && run.kind.startsWith("quote_") && !new RegExp(`"status"\\s*:\\s*"${run.kind === "quote_fill" ? "filled_not_submitted" : "submitted"}"`).test(log)) { run.status = "attention"; run.alert = "报价动作没有可验证的完成状态，请人工核对"; }
      if (run.status === "failed") run.alert ||= "任务运行失败，请查看日志";
      if (run.status === "attention") run.alert ||= "登录、验证码或连接需要人工处理";
      this.current = null; this.process = null; this.last = run; write(this.lastFile, run);
    };
    child.once("error", () => done(1)); child.once("close", (code) => { if (this.process === child) done(code ?? 1); });
    return this.snapshot();
  }
  stop() {
    if (!this.current || !this.process) throw new Error("当前没有运行中的任务");
    if (this.current.status === "indexing") throw new Error("正在更新 CASE 列表，请稍后");
    this.current.status = "stopping"; this.revokeBrowser(); this.kill(this.process);
    const child = this.process;
    setTimeout(() => { if (this.process === child) this.kill(child, "SIGKILL"); }, 2000).unref();
    return this.snapshot();
  }
  async testNotification() {
    if (!this.settings.notificationsEnabled) throw new Error("请先开启机会系统通知");
    if (this.notify) {
      const result = await this.notify({ test: true }); write(path.join(this.opsDir, "notification-status.json"), result); return result;
    }
    return this.runJson("scripts/notify-console.mjs", ["test"], 25000);
  }
  async close() {
    this.closed = true; this.generation++; this.revokeBrowser(); this.kill(this.probe, "SIGKILL");
    for (const extra of this.children) if (extra !== this.process) this.kill(extra, "SIGKILL");
    const child = this.process;
    if (child) {
      if (this.current) this.current.status = "stopping";
      this.kill(child);
      await new Promise((resolve) => { const timer = setTimeout(() => { this.kill(child, "SIGKILL"); resolve(); }, 2000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    }
  }
}
