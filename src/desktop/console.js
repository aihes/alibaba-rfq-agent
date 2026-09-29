import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { readProgressEvents } from "../progress.js";
import { setDraftArchived } from "../draft-archive.js";
import { approveRfqPrice } from "../price-approval.js";
import { stageEvidenceFromRecord } from "../stage-evidence.js";
import { summarizeModelUsage } from "../model-usage.js";

const now = () => new Date().toISOString();
const attention = /CAPTCHA|verification challenge|login is required|login could not be verified|Cannot attach to the existing Chrome session|Browser connection or Alibaba requires human attention|Chrome Bridge or Alibaba requires human attention|needs_manual_review|Submit was clicked, but success could not be verified|内置浏览器|页面操作失败/i;
function attentionMessage(log) {
  if (/CAPTCHA|verification challenge/i.test(log)) return "Alibaba 页面要求验证码或安全验证，请在内置浏览器手动完成后重试";
  if (/login is required/i.test(log)) return "任务在 RFQ 页面遇到登录提示，已停止分析。页面可能尚未加载完成，也可能要求单独验证；请查看当前账号状态和该 RFQ 页面";
  if (/login could not be verified/i.test(log)) return "任务在 RFQ 页面未看到稳定的登录标记，已停止分析。请查看当前账号状态和该 RFQ 页面";
  if (/Cannot attach|Browser connection|Chrome Bridge|内置浏览器|页面操作失败/i.test(log)) return "内置浏览器连接或页面操作失败。请到「浏览器」查看状态后重试";
  return "任务需要人工检查，请查看下方日志";
}
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
      ...(b.opened && !b.loading && result?.status !== "logged_in" ? { action: result?.status === "unsupported_page" ? "open_rfq" : "open_browser", actionLabel: result?.status === "unsupported_page" ? "打开 RFQ 列表" : result?.status === "captcha" ? "去处理验证" : result?.status === "unknown" ? "查看浏览器" : "打开浏览器登录" } : {}) }
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
    // 浏览器控制是工作台的内置能力，不是一个由用户配置的总开关。
    // 旧版本保存的 browserEnabled=false 在这里忽略；启动任务仍需用户
    // 点击，浏览器适配器仍只接受有任务令牌的受限动作。
    this.settings = { browserEnabled: true, quoteEnabled: false, alertsEnabled: true, notificationsEnabled: false };
    const saved = read(this.settingsFile, {});
    for (const key of ["alertsEnabled", "notificationsEnabled"])
      if (typeof saved[key] === "boolean") this.settings[key] = saved[key];
    this.searchTerms = read(path.join(workspace, "config/default.json"), {}).searchTerms || [];
    this.current = null; this.process = null; this.probe = null; this.generation = 0; this.closed = false;
    // 服务实测只保存在本次应用进程。配置指纹包含密钥但只存哈希；设置或
    // 本机环境变量变化后，旧的成功结果不会继续冒充当前配置可用。
    this.serviceChecks = {};
    this.children = new Set();
    this.last = read(this.lastFile, null);
    if (["running", "stopping", "indexing"].includes(this.last?.status)) {
      this.last = { ...this.last, status: "interrupted", finishedAt: now(), alert: "应用重启，原任务已中断；提交状态需要人工核对" };
      write(this.lastFile, this.last);
    } else if (this.last?.status === "attention" && ["登录、验证码或连接需要人工处理", "RFQ 页面提示未登录。请在内置浏览器检查账号，打开 RFQ 列表后再重试"].includes(this.last.alert)) {
      // 旧版只保存了笼统文案。升级时从该次本地任务日志恢复精确原因，
      // 不会重新运行扫描，也不读取浏览器身份数据。
      this.last.alert = attentionMessage(this.tail(this.last));
      write(this.lastFile, this.last);
    }
  }
  env(extra = {}) {
    return { ...process.env, ...this.environment(), RFQ_WORKSPACE_DIR: this.workspace,
      ...(this.desktop ? { ELECTRON_RUN_AS_NODE: "1", RFQ_DESKTOP: "1" } : {}),
      AUTO_CONTACT_MODE: "off", ALLOW_LIVE_SUBMIT: "false", AUTO_CONTACT_ACK: "",
      RFQ_MANUAL_OPERATOR_QUOTE: "0",
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
    const last = read(path.join(this.opsDir, "notification-status.json"), null);
    const lastTest = read(path.join(this.opsDir, "notification-test.json"), null);
    const attempts = read(path.join(this.opsDir, "notification-state.json"), { attempts: {} }).attempts || {};
    // 机会提醒从现有去重记录恢复：即使系统横幅被专注模式隐藏，重新打开
    // 工作台仍能找到草稿。旧版本没有 message 的记录也保留 RFQ ID。
    const events = Object.entries(attempts).filter(([draftId, entry]) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draftId) && entry?.at && entry.status !== "attempting")
      .map(([draftId, entry]) => ({ id: `opportunity:${draftId}`, kind: "opportunity", draftId,
        message: String(entry.message || draftId).slice(0, 160), status: entry.status, at: entry.at }));
    const test = lastTest || (last?.kind === "test" ? last : null);
    if (test?.at) events.push({ id: `test:${test.at}`, kind: "test", status: test.status, detail: test.detail, at: test.at });
    events.sort((a, b) => b.at.localeCompare(a.at));
    const run = this.current || this.last;
    const progressFile = run ? path.join(this.opsDir, `${run.id}.progress.json`) : null;
    const progress = progressFile ? read(progressFile, null) : null;
    const history = progressFile ? readProgressEvents(progressFile) : { events: [], truncated: false };
    return { settings: this.settings, searchTerms: this.searchTerms, run: run ? { ...run, progress,
      progressEvents: history.events, progressTruncated: history.truncated,
      modelUsage: summarizeModelUsage(progressFile) } : null,
      log: this.tail(), serverTime: now(), envChecking: Boolean(this.probe || this.embeddedBrowser?.inspecting || this.browserImporting),
      notifications: { supported: this.desktop || process.platform === "darwin", last, events: events.slice(0, 20) } };
  }
  stageDetail(index) {
    const run = this.current || this.last;
    if (!run || !Number.isInteger(index) || index < 0 || index >= 120) throw new Error("阶段编号无效");
    const file = path.join(this.opsDir, `${run.id}.progress.json`);
    const events = readProgressEvents(file).events;
    // 旧版没有 JSONL 流水时，只能显示最后保留的单条状态。
    const event = events[index] || (index === 0 && !events.length ? read(file, null) : null);
    if (!event) throw new Error("阶段记录不存在，请刷新任务状态");
    if (event.input !== undefined || event.output !== undefined)
      return { stage: event.stage, at: event.at, completedAt: event.completedAt || null,
        source: "本次任务逐阶段记录", input: event.input ?? null, output: event.output ?? null,
        note: event.output === undefined ? "本阶段仍在运行，或结束前未取得产出。" : null };
    let summary = null;
    if (run.kind === "once") {
      try {
        const log = fs.readFileSync(path.join(this.opsDir, `${run.id}.log`), "utf8");
        if (log.length <= 2 * 1024 * 1024) summary = JSON.parse(log.slice(log.indexOf("{")));
      } catch {}
    }
    const recordId = ["detail", "analysis", "pricing", "draft", "save"].includes(event.stage)
      ? summary?.records?.[(event.itemIndex || 1) - 1]?.id : null;
    let record = null;
    if (typeof recordId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(recordId)) {
      const directory = path.join(this.workspace, "data/drafts");
      try {
        const resolved = fs.realpathSync(path.join(directory, `${recordId}.json`));
        if (resolved.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) record = JSON.parse(fs.readFileSync(resolved, "utf8"));
      } catch {}
    }
    return { stage: event.stage, at: event.at, completedAt: null,
      ...stageEvidenceFromRecord(event, summary, record) };
  }
  updateSettings(changes) {
    if (!changes || Array.isArray(changes) || !Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !(key in this.settings) || typeof value !== "boolean")) throw new Error("开关参数无效");
    if ("browserEnabled" in changes) throw new Error("浏览器能力默认可用；请使用停止任务控制当前运行");
    const wasQuoteEnabled = this.settings.quoteEnabled;
    this.settings = { ...this.settings, ...changes };
    if (changes.quoteEnabled === false && wasQuoteEnabled) this.revokeBrowser();
    write(this.settingsFile, this.settings);
    if (this.current && !this.settings.quoteEnabled && this.current.kind.startsWith("quote_")) this.stop();
    return this.snapshot();
  }
  assertIdle() { if (this.closed) throw new Error("应用正在退出"); if (this.current || this.quotePreparing) throw new Error("已有任务正在运行，请先停止"); if (this.probe || this.embeddedBrowser?.inspecting || this.browserImporting) throw new Error("环境检测或登录导入正在进行，请稍后再试"); }
  async browserStatus(force = false) {
    // 任务占用时保留已有检查结果，不打断运行。Agent 权限不影响只读状态。
    const browser = this.closed || this.current || this.quotePreparing || this.probe || this.browserImporting
      ? this.embeddedBrowser.info() : await this.embeddedBrowser.status(force);
    return { ...browser, checks: browserChecks(browser) };
  }
  serviceFingerprint(key, env = this.environment()) {
    const fields = key === "model"
      ? ["AGENT_PROVIDER", "MODEL_NAME", "MODEL_API_URL", "MODEL_API_KEY", "RFQ_CLOUD_TOKEN", "LOCAL_CLAUDE_EXECUTABLE", "LOCAL_CLAUDE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
      : ["OCR_PROVIDER", "GLM_OCR_API_URL", "GLM_OCR_API_KEY"];
    return crypto.createHash("sha256").update(JSON.stringify(fields.map(field => env[field] || ""))).digest("hex");
  }
  recordServiceCheck(key, ok, detail) {
    this.serviceChecks[key] = { fingerprint: this.serviceFingerprint(key), ok, detail, checkedAt: now() };
  }
  serviceCheck(key, env) {
    const check = this.serviceChecks[key];
    return check?.fingerprint === this.serviceFingerprint(key, env) ? check : null;
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
      const modelCheck = this.serviceCheck("model", env), ocrReady = env.OCR_PROVIDER !== "off" && Boolean(env.GLM_OCR_API_KEY);
      const ocrCheck = this.serviceCheck("ocr", env);
      checks.push({ key: "model", ok: modelReady && modelCheck?.ok === true, required: false, label: "需求分析模型",
        state: !modelReady ? "待配置" : !modelCheck ? "已配置 · 待检测" : modelCheck.ok ? "实测可用" : "检测失败",
        detail: modelReady ? localClaude ? `本机 Claude · ${env.LOCAL_CLAUDE_MODEL || "继承用户模型"}`
          : env.AGENT_PROVIDER === "cloud-claude" ? "云端 Claude Code · 文本 GLM-5.3 / 图片 Flash"
            : `${env.MODEL_NAME || "已配置模型"} · ${env.RFQ_MODEL_CONFIG_SOURCE || "已保存配置"}`
          : localClaude ? "未找到本机 Claude；请安装或在设置中选择云端服务" : env.AGENT_PROVIDER === "cloud-claude" ? "未配置云端服务授权令牌" : "未配置模型 API Key",
        help: modelCheck ? `${modelCheck.detail} · 检测于 ${new Date(modelCheck.checkedAt).toLocaleString("zh-CN")}` : "点击「测试模型」发送固定文本，确认当前调用方式可用；会产生少量模型用量",
        testable: modelReady });
      checks.push({ key: "ocr", ok: ocrReady && ocrCheck?.ok === true, required: false, label: "图片文字识别",
        state: env.OCR_PROVIDER === "off" ? "已关闭" : !ocrReady ? "待配置" : !ocrCheck ? "已配置 · 待检测" : ocrCheck.ok ? "实测可用" : "检测失败",
        detail: env.OCR_PROVIDER === "off" ? "图片识别已关闭" : env.OCR_PROVIDER === "cloud-ocr"
          ? ocrReady ? "云端 OCR · 已授权" : "云端 OCR · 未配置授权令牌"
          : ocrReady ? "GLM OCR · API Key 已配置" : "GLM OCR · 尚未配置 API Key",
        help: ocrCheck && ocrReady ? `${ocrCheck.detail} · 检测于 ${new Date(ocrCheck.checkedAt).toLocaleString("zh-CN")}` : "点击「测试 OCR」识别内置样张；会产生少量 OCR 用量",
        testable: ocrReady });
      checks.push({ key: "port", ok: Boolean(env.QUOTE_PORT), required: false, label: "报价交货地点", detail: env.QUOTE_PORT || "尚未核实交货地点 / 港口", help: "缺失时可浏览或扫描，但报价须先人工核实并在设置页填写" });
    }
    const report = (status, reason) => { if (reason) checks.filter((x) => ["bridge", "login"].includes(x.key)).forEach((x) => { x.detail = reason; }); return { ok: checks.filter((x) => x.required !== false).every((x) => x.ok), checks, status, checkedAt: now() }; };
    if (this.closed) return report("skipped", "应用正在退出");
    if (embedded) {
      // 桌面版只读自有窗口；Web / CLI 通过 Bridge 查询连接状态。
      // 两者都不会仅因检查环境而启动扫描或报价任务。
      const browser = await this.browserStatus(force);
      checks.splice(2, 2, ...browser.checks);
      return { ...report("checked"), browser };
    }
    if (this.current || this.quotePreparing || this.probe || this.embeddedBrowser?.inspecting) return report("skipped", "任务或检测正在进行；完成后再检测");
    if (!force && this.cache && Date.now() - this.cache.at < 20000) return this.cache.value;
    const generation = this.generation;
    try {
      const result = await this.runJson("plugins/alibaba-rfq-midscene/scripts/cli.mjs", ["status"], 30000, (child) => { this.probe = child; });
      if (generation !== this.generation) return report("skipped", "应用状态已变化，本次检测已取消");
      checks[2].ok = result.connected === true; checks[2].detail = result.connected ? `已连接（${embedded ? "应用窗口" : "tab"} ${result.tabId}）` : embedded ? "请打开应用内的阿里巴巴浏览器" : "请在 Chrome 中开启 Midscene Bridge";
      checks[3].ok = result.connected === true && result.loggedIn === true;
      checks[3].detail = checks[3].ok ? "当前 RFQ 页面已检测到登录标记" : /verification challenge/i.test(result.attention) ? "检测到验证码或安全验证，请停止任务并手动处理" : /login is required/i.test(result.attention) ? "尚未登录或登录失效，请在内置浏览器手动登录" : result.attention || (embedded ? "请在应用内的阿里巴巴窗口手动登录" : "请人工在监听 Chrome 中登录 Alibaba");
      checks[2].help = "这是本次实际连接检测；任务会再次连接并检查页面，空闲时 CDP 会断开";
      checks[3].help = "进入浏览器页可单独执行只读登录检测，无需开启 Agent 控制";
    } catch {
      return generation !== this.generation
        ? report("skipped", "应用状态已变化，本次检测已取消")
        : report("checked", embedded ? "检测失败或超时，请打开内置浏览器，检查网络与登录状态" : "检测失败或超时，请检查 Chrome、插件和登录状态");
    }
    finally { this.probe = null; }
    const value = report("checked"); this.cache = { at: Date.now(), value }; return value;
  }
  listQuotes() { return this.runJson("scripts/console-quote.mjs", ["list"]); }
  reanalyzeDraft(request) {
    this.assertIdle();
    if (!request || Object.keys(request).sort().join(",") !== "id,reviewHash" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(request.id || "") ||
      !/^[a-f0-9]{64}$/.test(request.reviewHash || "")) throw new Error("请选择有效的 RFQ 和草稿版本");
    if (this.desktop) {
      const env = this.environment();
      if (env.AGENT_PROVIDER === "local-claude-sdk" && !env.LOCAL_CLAUDE_EXECUTABLE)
        throw new Error("未找到本机 Claude，请安装后重试或在设置中选择 GLM HTTP");
      if (env.AGENT_PROVIDER !== "local-claude-sdk" && !env.MODEL_API_KEY)
        throw new Error("请先在模型设置中填写 API Key 并保存");
    }
    return this.launch({ kind: "reanalyze", draftId: request.id }, "scripts/reanalyze-draft.mjs",
      [request.id, request.reviewHash]);
  }
  async approvePrice(request) {
    this.assertIdle();
    this.quotePreparing = true;
    try {
      const result = approveRfqPrice(this.workspace, request, { port: this.environment().QUOTE_PORT || "" });
      try { await this.runJson("scripts/build_case_catalog.mjs", [], 120000); return { ...result, catalogUpdated: true }; }
      catch { return { ...result, catalogUpdated: false }; }
    } finally { this.quotePreparing = false; }
  }
  archiveQuote(request) {
    this.assertIdle();
    if (!request || Object.keys(request).some((key) => !["id", "archived"].includes(key))) throw new Error("草稿整理参数无效");
    return setDraftArchived(this.workspace, request.id, request.archived);
  }
  reviewQuote(id) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id || "")) throw new Error("草稿 ID 无效"); return this.runJson("scripts/console-quote.mjs", ["review", id]); }
  async startQuote(request) {
    this.assertIdle();
    if (!["fill", "submit"].includes(request?.kind) || request.approved !== true) throw new Error("请先核对该 RFQ 的报价字段");
    if (!this.settings.quoteEnabled) throw new Error("请先选择逐单浏览器报价模式");
    // 审阅是异步读取，必须先占用槽位；关闭权限后也要再次检查。
    this.quotePreparing = true;
    try {
      const review = await this.reviewQuote(request.draftId);
      if (review.archivedAt) throw new Error("草稿已移出当前列表；先恢复后再报价");
      if (this.closed || !this.settings.quoteEnabled) throw new Error("逐单浏览器报价模式已关闭");
      if (request.reviewHash !== review.reviewHash || request.confirmation !== review.rfq.id) throw new Error("草稿已变化或 RFQ ID 确认不匹配，请重新核对");
      if (!review[request.kind === "fill" ? "fillEligible" : "submitEligible"]) throw new Error("当前草稿不允许执行该报价动作");
      const extra = { RFQ_MANUAL_OPERATOR_QUOTE: "1",
        ...(request.kind === "submit" ? { AUTO_CONTACT_MODE: "submit", ALLOW_LIVE_SUBMIT: "true", AUTO_CONTACT_ACK: "I_UNDERSTAND_AUTO_QUOTES_ARE_SENT", AUTO_CONTACT_CATEGORIES: review.quote.categoryId, QUOTE_PORT: review.draft.port } : {}) };
      return this.launch({ kind: `quote_${request.kind}`, draftId: request.draftId, rfqId: review.rfq.id }, "scripts/console-quote.mjs", [request.kind, request.draftId, review.reviewHash, review.rfq.id], extra);
    } finally { this.quotePreparing = false; }
  }
  start(request) {
    this.assertIdle();
    const { kind, term = this.searchTerms[0], recentMinutes = 60 } = request || {};
    if (!["refresh", "scan", "once", "watch"].includes(kind) || ![...this.searchTerms, "__all__"].includes(term)
      || !Number.isInteger(recentMinutes) || recentMinutes < 0 || recentMinutes > 525600) throw new Error("任务参数无效");
    if (this.desktop && ["once", "watch"].includes(kind)) {
      const env = this.environment();
      if (env.AGENT_PROVIDER === "local-claude-sdk" && !env.LOCAL_CLAUDE_EXECUTABLE) throw new Error("未找到本机 Claude，请安装后重试或在设置中选择 GLM HTTP");
      if (env.AGENT_PROVIDER !== "local-claude-sdk" && !env.MODEL_API_KEY) throw new Error("请先在模型设置中填写 API Key 并保存");
    }
    const script = kind === "refresh" ? "scripts/build_case_catalog.mjs" : kind === "scan" ? (term === "__all__" ? "scripts/scan_all_terms.mjs" : "plugins/alibaba-rfq-midscene/scripts/cli.mjs") : "src/cli.js";
    const args = kind === "scan" && term !== "__all__" ? ["scan", "--term", term, "--recent-minutes", String(recentMinutes)] : ["once", "watch"].includes(kind) ? [kind] : [];
    return this.launch({ kind, term: kind === "refresh" ? null : term, recentMinutes }, script, args,
      { SEARCH_TERMS: term === "__all__" ? this.searchTerms.join(",") : term, RECENT_RFQ_MINUTES: String(recentMinutes) });
  }
  launch(fields, script, args, extra) {
    const run = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 12), ...fields, status: "running", startedAt: now(), finishedAt: null, exitCode: null, alert: null };
    fs.mkdirSync(this.opsDir, { recursive: true });
    const progressFile = path.join(this.opsDir, `${run.id}.progress.json`);
    // 即使价格前置筛选使本轮 0 次付费调用，也创建空流水，让界面能把
    // “确实是 0 次”与旧版任务根本没有用量记录区分开。
    if (["once", "watch", "reanalyze"].includes(run.kind)) fs.writeFileSync(`${progressFile}.usage.jsonl`, "", { mode: 0o600 });
    const fd = fs.openSync(path.join(this.opsDir, `${run.id}.log`), "w");
    let child;
    try { child = this.spawn(script, args, { env: this.env({ ...extra, RFQ_PROGRESS_FILE: progressFile }), stdio: ["ignore", fd, fd] }); } finally { fs.closeSync(fd); }
    this.current = run; this.process = child; write(this.lastFile, run);
    let finishing = false;
    const done = async (code) => {
      if (finishing) return;
      finishing = true;
      if (this.process !== child) return;
      const stopped = run.status === "stopping";
      if (["once", "watch", "reanalyze", "quote_fill", "quote_submit"].includes(run.kind) && !this.closed) {
        run.status = "indexing"; write(this.lastFile, run);
        try { await this.runJson("scripts/build_case_catalog.mjs", [], 120000); } catch { run.alert = "CASE 列表更新失败"; }
      }
      const log = this.tail(run);
      run.exitCode = code; run.finishedAt = now();
      run.status = stopped ? (run.kind === "quote_submit" ? "attention" : "stopped") : attention.test(log) ? "attention" : code === 0 && !run.alert ? "completed" : "failed";
      if (stopped && run.kind === "quote_submit") run.alert = "提交过程被中断，请核对页面和记录，不要直接重试";
      if (!stopped && code === 0 && run.kind.startsWith("quote_") && !new RegExp(`"status"\\s*:\\s*"${run.kind === "quote_fill" ? "filled_not_submitted" : "submitted"}"`).test(log)) { run.status = "attention"; run.alert = "报价动作没有可验证的完成状态，请人工核对"; }
      if (run.status === "failed") run.alert ||= "任务运行失败，请查看日志";
      if (run.status === "attention") run.alert ||= attentionMessage(log);
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
      const result = await this.notify({ test: true });
      const event = { ...result, kind: "test", at: now() };
      write(path.join(this.opsDir, "notification-test.json"), event);
      write(path.join(this.opsDir, "notification-status.json"), event);
      return result;
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
