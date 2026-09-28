import { app, BrowserWindow, WebContentsView, ipcMain, clipboard, Menu, Tray, nativeImage, Notification, dialog, shell, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DesktopSettings } from "./settings.js";
import { readModelEnvironment } from "./model-environment.js";
import { parseAlibabaLoginFile } from "./browser-import.js";
import { OperatorConsole } from "./console.js";
import { createCaseServer } from "./server.js";
import { importCaseData } from "./import-data.js";
import { createNativeNotifier } from "./native-notifications.js";
import { EmbeddedBrowser } from "./embedded-browser.js";

const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.setName("RFQ 助手");
// 测试可以使用独立数据目录。发布版默认使用操作系统的应用数据目录。
if (process.env.RFQ_DESKTOP_DATA_DIR) app.setPath("userData", path.resolve(process.env.RFQ_DESKTOP_DATA_DIR));
const workspace = path.join(app.getPath("userData"), "workspace");
process.env.RFQ_WORKSPACE_DIR = workspace;
process.env.RFQ_DESKTOP = "1";
let window, tray, service, quitting = false, quitReady = false;
const token = crypto.randomBytes(32).toString("hex");
const toolToken = crypto.randomBytes(32).toString("hex");
const browserToken = crypto.randomBytes(32).toString("hex");
const embeddedBrowser = new EmbeddedBrowser({ BrowserWindow, WebContentsView, ipcMain, clipboard, authorize: () => ({
  browser: service?.console.settings.browserEnabled === true,
  quote: service?.console.settings.quoteEnabled === true && service?.console.current?.kind.startsWith("quote_"),
  busy: Boolean(service?.console.current || service?.console.probe || service?.console.quotePreparing || service?.console.browserImporting),
  stopping: quitting || ["stopping", "indexing"].includes(service?.console.current?.status)
}) });
const connectionFile = path.join(workspace, "data/case-catalog/ops/notification-tools-connection.json");
const notifier = createNativeNotifier({ Notification, openDraft: (draftId) => {
  if (!service) return;
  const url = new URL(service.url); url.searchParams.set("view", "console");
  if (draftId) url.searchParams.set("draft", draftId);
  show(url.href);
} });

function show(url) {
  if (!window || window.isDestroyed()) return;
  // 从浏览器返回工作台时保留当前页面和未保存的表单；只有通知指定
  // 草稿时才导航，避免每次激活应用都跳回 CASE 列表。
  if (url && window.webContents.getURL() !== url) window.loadURL(url);
  window.show(); window.focus();
}
function externalAllowed(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["sourcing.alibaba.com", "rfqposting.alibaba.com"].includes(url.hostname); } catch { return false; }
}
async function importData(console) {
  const result = await dialog.showOpenDialog(window, { title: "选择已有项目的 data 文件夹", properties: ["openDirectory"] });
  if (result.canceled) return { canceled: true };
  console.assertIdle();
  const imported = importCaseData(result.filePaths[0], workspace);
  return { ...console.start({ kind: "refresh", term: console.searchTerms[0], limit: 1 }), ...imported };
}
async function importBrowserLogin(console) {
  console.assertIdle(); console.browserImporting = true;
  try {
    // 路径由主进程系统选择框给出；网页不能传任意本机路径或 Cookie 值。
    const selected = await dialog.showOpenDialog(window, { title: "选择 Alibaba 登录导出文件", properties: ["openFile"], filters: [{ name: "Alibaba 登录 JSON", extensions: ["json"] }] });
    if (selected.canceled) return { canceled: true };
    const file = selected.filePaths[0], stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("请选择不超过 1 MB 的登录 JSON 文件");
    const prepared = parseAlibabaLoginFile(fs.readFileSync(file, "utf8"));
    console.browserImporting = false;
    return await embeddedBrowser.importLogin(prepared);
  } finally { console.browserImporting = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => show());
  app.on("activate", () => show());
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // 退出应用才停止任务；关闭窗口进入后台。应用不保活电脑，休眠时
    // 无法持续监听。先撤销浏览器控制，再结束子任务和应用自己的窗口。
    (async () => {
      embeddedBrowser.invalidate(); await service?.close(); embeddedBrowser.close(); fs.rmSync(connectionFile, { force: true });
      tray?.destroy(); quitReady = true; app.quit();
    })().catch(() => { quitReady = true; app.exit(1); });
  });
  // Electron 等入口模块加载结束后才发 ready；入口顶层 await ready 会
  // 互相等待而停在无窗口状态。用回调初始化，保持 ESM 入口及时返回。
  app.whenReady().then(async () => {
  app.setAppUserModelId("com.rfq.assistant");
  try {
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    for (const name of ["default.json", "pricing-rules.json"]) {
      const target = path.join(workspace, "config", name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(resources, "config", name), target);
    }
    const settings = new DesktopSettings(app.getPath("userData"), safeStorage, {
      localEnvironment: await readModelEnvironment(), reloadEnvironment: readModelEnvironment
    });
    const environment = () => ({ ...settings.environment(), RFQ_NOTIFY_URL: service ? `${service.url}api/desktop/notify` : "", RFQ_NOTIFY_TOKEN: token,
      BROWSER_PROVIDER: "electron-cdp", RFQ_BROWSER_URL: service ? `${service.url}api/desktop/browser/command` : "", RFQ_BROWSER_TOKEN: browserToken });
    const builder = new OperatorConsole({ resources, workspace, desktop: true, environment });
    await builder.runJson("scripts/build_case_catalog.mjs", [], 120000);
    service = await createCaseServer({ resources, workspace, desktop: true, desktopSettings: settings,
      environment, importData, importBrowserLogin, notify: notifier.send, notifyToken: token, toolToken, embeddedBrowser, browserToken,
      revokeBrowser: () => embeddedBrowser.invalidate() });
    // 全新安装还没有运行记录/设置，ops 目录未必存在。连接文件必须在
    // 创建父目录后写入，不能依赖导入过 CASE 或曾经开过任务的开发目录。
    fs.mkdirSync(path.dirname(connectionFile), { recursive: true });
    fs.writeFileSync(connectionFile, JSON.stringify({ url: `${service.url}api/tools/notifications`, token: toolToken }), { mode: 0o600 });
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 820, minHeight: 620, title: "RFQ 助手",
      backgroundColor: "#f5f3ee", show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => { if (externalAllowed(url) && !service.console.current) void embeddedBrowser.open(url).catch(() => {}); return { action: "deny" }; });
    window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== new URL(service.url).origin) event.preventDefault(); });
    window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
    const icon = nativeImage.createFromPath(path.join(resources, "desktop/assets/icon.png")).resize({ width: 18, height: 18 });
    tray = new Tray(icon); tray.setToolTip("RFQ 助手 · 关闭窗口后继续运行");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 RFQ 助手", click: () => show() },
      { label: "打开阿里巴巴浏览器", click: () => { void embeddedBrowser.open().catch(() => {}); } },
      { label: "打开数据文件夹", click: () => shell.openPath(workspace) },
      { type: "separator" }, { label: "退出并停止任务", click: () => app.quit() }
    ]));
    tray.on("click", () => show());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "RFQ 助手", submenu: [{ label: "打开工作台", click: () => show() }, { label: "打开阿里巴巴浏览器", click: () => { void embeddedBrowser.open().catch(() => {}); } }, { role: "hide" }, { type: "separator" }, { label: "退出并停止任务", accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] },
      { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "视图", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] }
    ]));
    window.once("ready-to-show", () => window.show());
    await window.loadURL(service.url);
  } catch (error) {
    dialog.showErrorBox("RFQ 助手无法启动", `请检查应用数据目录或重新安装。\n${error.message}`);
    app.quit();
  }
  });
}
