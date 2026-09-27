/** Native opportunity alerts: local files only; never browser or quote actions. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import AdmZip from "adm-zip";
import { projectDir, resourceDir } from "./config.js";
import { priceRfq } from "./pricing.js";

const exec = (executable, args, options) => new Promise((resolve, reject) => {
  const child = execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
  // terminal-notifier 会读取管道输入；即使 message 已在参数中，未关闭的
  // stdin 仍会让它等待 EOF。这里显式结束输入，避免把它误判成系统超时。
  child.stdin?.end();
});
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const clean = (text) => String(text || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);

export function settingsPath() {
  return process.env.RFQ_CONSOLE_SETTINGS_FILE || path.join(projectDir, "data/case-catalog/ops/settings.json");
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

export function prepareNotifier({ vendorDir = path.join(resourceDir, "vendor/terminal-notifier"),
  installRoot = path.join(projectDir, "data/notification-helper") } = {}) {
  const metadata = readJson(path.join(vendorDir, "notifier.json"));
  const bytes = fs.readFileSync(path.join(vendorDir, metadata.archive));
  if (hash(bytes) !== metadata.sha256) throw new Error("系统通知组件校验失败，请重新获取完整项目。");
  const entries = new AdmZip(bytes).getEntries();
  const target = path.join(installRoot, `v${metadata.version}`);
  if (entries.reduce((size, entry) => size + entry.header.size, 0) > 8 * 1024 * 1024) {
    throw new Error("系统通知组件解压大小异常。");
  }
  for (const entry of entries) {
    const name = entry.entryName;
    const mode = entry.header.attr >>> 16;
    if (path.posix.isAbsolute(name) || name.split("/").includes("..") || /[\\:]/.test(name)
      || (mode & 0o170000) === 0o120000) throw new Error("系统通知组件包含不安全的路径。");
  }
  // 每次发送前核对已解压的官方文件。Chrome 插件和通知程序各自独立，
  // 通知不会连接 Bridge；稳定目录也让 macOS 能识别同一个通知应用。
  const executable = path.join(target, "terminal-notifier.app/Contents/MacOS/terminal-notifier");
  if (fs.existsSync(target)) {
    const ready = entries.filter((entry) => !entry.isDirectory).every((entry) => {
      const file = path.join(target, entry.entryName);
      return fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()
        && hash(fs.readFileSync(file)) === hash(entry.getData());
    });
    if (!ready || fs.lstatSync(target).isSymbolicLink()) throw new Error("系统通知组件目录不完整，请删除 data/notification-helper 后重试。");
    return executable;
  }
  fs.mkdirSync(installRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(installRoot, ".prepare-"));
  try {
    for (const entry of entries) {
      const file = path.join(temporary, entry.entryName);
      if (entry.isDirectory) fs.mkdirSync(file, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, entry.getData());
      }
    }
    fs.chmodSync(path.join(temporary, "terminal-notifier.app/Contents/MacOS/terminal-notifier"), 0o755);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return executable;
}

export function consoleUrl(base = process.env.RFQ_CONSOLE_URL || "http://localhost:8888/", draftId) {
  const url = new URL(base);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
    || url.username || url.password) throw new Error("通知只能打开本机报价工作台。");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", "console");
  if (draftId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draftId)) throw new Error("通知草稿 ID 无效。");
    url.searchParams.set("draft", draftId);
  }
  return url.href;
}

export async function sendNativeNotification({ message, draftId, test = false, baseUrl }, {
  platform = os.platform(), run = exec, prepare = prepareNotifier
} = {}) {
  if (process.env.RFQ_DESKTOP === "1" && process.env.RFQ_NOTIFY_URL && process.env.RFQ_NOTIFY_TOKEN) {
    try {
      // 工作进程通过私有 token 请求主进程原生通知，不能调用任意 IPC 或
      // 打开外部 URL。桌面版权限归 RFQ 助手，无需 terminal-notifier。
      const response = await fetch(process.env.RFQ_NOTIFY_URL, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", "X-RFQ-Notify": process.env.RFQ_NOTIFY_TOKEN },
        body: JSON.stringify({ message: clean(message), draftId, test }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Native notification request failed");
      return await response.json();
    } catch { return { status: "failed", detail: "桌面通知未被接受，请检查应用和系统通知权限" }; }
  }
  if (platform !== "darwin") return { status: "unsupported", detail: "当前系统通知仅支持 macOS。" };
  try {
    const url = consoleUrl(baseUrl, draftId);
    const executable = prepare();
    // 参数数组不经过 shell；买家文本只进入 message，不能变成命令、URL
    // 或 -execute 参数。通知标题、点击目标和分组键由本项目固定生成。
    const args = ["-title", "RFQ 报价工作台", "-message", test ? "系统通知测试：收到这条提醒后，即可开启持续监控。"
      : `发现报价机会：${clean(message)}。点击查看草稿，报价仍需逐单核对。`,
    "-group", test ? "rfq-agent-test" : `rfq-agent-${draftId}`, "-open", url, "-sound", "default"];
    await run(executable, args, { timeout: 20000, maxBuffer: 32 * 1024, windowsHide: true });
    // 返回 0 只证明 macOS 接受了请求；勿扰模式/系统设置仍决定是否弹横幅。
    return { status: "accepted", detail: "已交给 macOS 通知中心。若未看到横幅，请检查 terminal-notifier 的通知权限及专注模式。" };
  } catch (error) {
    const detail = error.code === 3 ? "系统未允许通知。请在系统设置 → 通知 → terminal-notifier 中允许通知，再发送测试。"
      : error.killed || error.code === 4 ? "系统通知授权或发送超时。请允许通知后重试测试。"
      : error.code === 5 ? "系统通知发送失败，请检查 macOS 通知设置。"
      : `系统通知不可用：${clean(error.message)}`;
    return { status: "failed", detail };
  }
}

export function isOpportunity(record, config = {}) {
  const q = record?.quote, a = record?.analysis, d = record?.draft;
  if (q?.status !== "quoted" || a?.recommendation !== "quote" || !Number.isFinite(a.confidence)
    || a.confidence < (config.autoContactMinConfidence ?? 0.92)
    || !Array.isArray(a.missingRequired) || a.missingRequired.length
    || !Array.isArray(a.riskFlags) || a.riskFlags.length
    || !Number.isFinite(record.rfq?.remainingQuotes) || record.rfq.remainingQuotes <= 0
    || ![undefined, "not_submitted", "skipped"].includes(record.submission?.status)) return false;
  // “可报价”还要求表单可表达的完整报价。条件报价、非美元、算术不符、
  // 一次性费用、缺少人工核实港口/商品描述都不能弹成可用机会。
  if (q.currency !== "USD" || ![q.quantity, q.unitPriceUsd, q.totalUsd].every((value) => Number.isFinite(value) && value > 0)
    || Number(q.setupUsd || 0) !== 0 || Math.abs(q.quantity * q.unitPriceUsd - q.totalUsd) > 0.011
    || ![d?.port, d?.productName, d?.productDetails, d?.buyerMessage].every((value) => typeof value === "string" && value.trim())) return false;
  try {
    const url = new URL(record.rfq.quoteUrl);
    if (url.protocol !== "https:" || url.username || url.password
      || !["sourcing.alibaba.com", "rfqposting.alibaba.com"].includes(url.hostname)) return false;
    // 复用接口可能读取历史草稿，按当前确定性规则重算，旧规则价格不能
    // 仅凭文件里的 quoted 字样触发。实时 pipeline 使用同样的检查。
    if (config.pricing) {
      const current = priceRfq(record.rfq, a, config.pricing);
      if (current.status !== "quoted" || ["quantity", "unitPriceUsd", "setupUsd", "totalUsd", "currency", "tradeTerm"].some((key) => current[key] !== q[key])) return false;
    }
    return true;
  } catch { return false; }
}

export async function notifyOpportunity(record, config, { file = settingsPath(), send = sendNativeNotification } = {}) {
  // 只有扫描后新产出的规则匹配草稿触发；不会把历史数据集导入当成新机会。
  // 每次读持久化开关，使持续监控期间关闭通知也立即生效。
  if (!isOpportunity(record, config)) return { status: "not_opportunity" };
  try {
    if (readJson(file, {}).notificationsEnabled !== true) return { status: "disabled" };
    const draftId = record.rfq.id;
    consoleUrl(undefined, draftId);
    const stateFile = path.join(path.dirname(file), "notification-state.json");
    const state = readJson(stateFile, { attempts: {} });
    if (state.attempts[draftId]) return { status: "duplicate" };
    // exclusive-create 是跨进程的领取动作。两个工具/扫描进程同时
    // 发现同一 RFQ 时只允许一个发送，防止 read-then-write 的重复提醒。
    const claims = path.join(path.dirname(file), "notification-claims");
    fs.mkdirSync(claims, { recursive: true });
    try { fs.writeFileSync(path.join(claims, `${draftId}.json`), JSON.stringify({ at: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") return { status: "duplicate" }; throw error; }
    // 先落盘再发，重启/重复扫描时不会反复弹同一 RFQ。失败留记录，
    // 用户可用测试按钮排查；通知失败不能打断草稿保存和下一条分析。
    state.attempts[draftId] = { status: "attempting", at: new Date().toISOString() };
    atomicJson(stateFile, state);
    let result;
    try { result = await send({ message: `${record.rfq.title} · ${record.quote.quantity} 件 · USD ${record.quote.unitPriceUsd}/件 · 总计 USD ${record.quote.totalUsd}`, draftId }); }
    catch { result = { status: "failed", detail: "通知发送失败；草稿已保存，请检查系统通知权限" }; }
    // 其他 RFQ 可同时发送；结束时重新读索引，保留它们已写入的记录。
    const latest = readJson(stateFile, { attempts: {} });
    state.attempts = latest.attempts;
    state.attempts[draftId] = { ...result, at: new Date().toISOString() };
    atomicJson(path.join(claims, `${draftId}.json`), state.attempts[draftId]);
    atomicJson(stateFile, state);
    atomicJson(path.join(path.dirname(file), "notification-status.json"), state.attempts[draftId]);
    return result;
  } catch (error) {
    console.error(`[notification] ${clean(error.message)}`);
    return { status: "failed", detail: "通知记录无法读取或保存；RFQ 草稿仍正常保存。" };
  }
}

export async function testNotification({ file = settingsPath(), baseUrl, send = sendNativeNotification } = {}) {
  if (readJson(file, {}).notificationsEnabled !== true) return { status: "disabled", detail: "请先开启机会系统通知。" };
  const result = await send({ test: true, baseUrl });
  atomicJson(path.join(path.dirname(file), "notification-status.json"), { ...result, at: new Date().toISOString() });
  return result;
}
