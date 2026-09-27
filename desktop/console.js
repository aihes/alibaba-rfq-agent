import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";

const now = () => new Date().toISOString();
const attention = /CAPTCHA|verification challenge|login is required|Cannot attach to the existing Chrome session|Chrome Bridge or Alibaba requires human attention|needs_manual_review|Submit was clicked, but success could not be verified/i;
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** 与 Web 控制台相同的权限边界。每个任务独立进程组，退出只清理本
 * 应用创建的任务，不杀 Chrome。任务日志永远不包含传入的环境密钥。
 */
export class OperatorConsole {
  constructor({ resources, workspace, environment = () => ({}), notify, spawnProcess = spawn, desktop = false }) {
    Object.assign(this, { resources, workspace, environment, notify, spawnProcess, desktop });
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
      log: this.tail(), serverTime: now(), envChecking: Boolean(this.probe),
      notifications: { supported: this.desktop || process.platform === "darwin", last: read(path.join(this.opsDir, "notification-status.json"), null) } };
  }
  updateSettings(changes) {
    if (!changes || Array.isArray(changes) || !Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !(key in this.settings) || typeof value !== "boolean")) throw new Error("开关参数无效");
    if (changes.quoteEnabled && !(changes.browserEnabled ?? this.settings.browserEnabled)) throw new Error("请先开启浏览器操作");
    if ("browserEnabled" in changes) { this.cache = null; this.generation++; }
    this.settings = { ...this.settings, ...changes };
    if (!this.settings.browserEnabled) { this.settings.quoteEnabled = false; this.kill(this.probe, "SIGKILL"); }
    write(this.settingsFile, this.settings);
    if (this.current && ((!this.settings.browserEnabled && this.current.kind !== "refresh") || (!this.settings.quoteEnabled && this.current.kind.startsWith("quote_")))) this.stop();
    return this.snapshot();
  }
  assertIdle() { if (this.closed) throw new Error("应用正在退出"); if (this.current || this.quotePreparing) throw new Error("已有任务正在运行，请先停止"); if (this.probe) throw new Error("环境检测正在进行，请稍后再试"); }
  async envCheck(force = false) {
    const checks = [
      { key: "node", ok: true, label: this.desktop ? "内置运行环境" : "Node.js 运行环境", detail: this.desktop ? "已随应用安装，无需另装 Node 或 Python" : process.version },
      { key: "plugin", ok: fs.existsSync(path.join(this.resources, "plugins/alibaba-rfq-midscene/scripts/cli.mjs")), label: "Midscene 本地适配脚本", detail: "Chrome 扩展仍需按下方引导加载" },
      { key: "bridge", ok: false, label: "Chrome Bridge 连接", detail: "未检测" },
      { key: "login", ok: false, label: "Alibaba 登录态", detail: "未检测" }
    ];
    const report = (status, reason) => { if (reason) checks.slice(2).forEach((x) => { x.detail = reason; }); return { ok: checks.every((x) => x.ok), checks, status, checkedAt: now() }; };
    if (this.closed) return report("skipped", "应用正在退出");
    if (!this.settings.browserEnabled) return report("skipped", "浏览器控制已关闭；开启后才检测连接和登录态");
    if (this.current || this.quotePreparing || this.probe) return report("skipped", "任务或检测正在进行；完成后再检测");
    if (!force && this.cache && Date.now() - this.cache.at < 20000) return this.cache.value;
    const generation = this.generation;
    try {
      const result = await this.runJson("plugins/alibaba-rfq-midscene/scripts/cli.mjs", ["status"], 30000, (child) => { this.probe = child; });
      if (generation !== this.generation || !this.settings.browserEnabled) return report("skipped", "授权已变化，本次检测已取消");
      checks[2].ok = result.connected === true; checks[2].detail = result.connected ? `已连接（tab ${result.tabId}）` : "请在 Chrome 中开启 Midscene Bridge";
      checks[3].ok = result.connected === true && result.loggedIn === true; checks[3].detail = checks[3].ok ? "已登录 Alibaba" : "请人工在监听 Chrome 中登录 Alibaba";
    } catch {
      return generation !== this.generation || !this.settings.browserEnabled
        ? report("skipped", "授权已变化，本次检测已取消")
        : report("checked", "检测失败或超时，请检查 Chrome、插件和登录状态");
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
    if (this.desktop && ["once", "watch"].includes(kind) && !this.environment().MODEL_API_KEY) throw new Error("请先在模型设置中填写 API Key 并保存");
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
    this.current.status = "stopping"; this.kill(this.process);
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
    this.closed = true; this.generation++; this.kill(this.probe, "SIGKILL");
    for (const extra of this.children) if (extra !== this.process) this.kill(extra, "SIGKILL");
    const child = this.process;
    if (child) {
      if (this.current) this.current.status = "stopping";
      this.kill(child);
      await new Promise((resolve) => { const timer = setTimeout(() => { this.kill(child, "SIGKILL"); resolve(); }, 2000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    }
  }
}
