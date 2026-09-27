import { app, BrowserWindow, Menu, Tray, nativeImage, Notification, dialog, shell, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DesktopSettings } from "./settings.js";
import { OperatorConsole } from "./console.js";
import { createCaseServer } from "./server.js";
import { importCaseData } from "./import-data.js";
import { createNativeNotifier } from "./native-notifications.js";

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
const connectionFile = path.join(workspace, "data/case-catalog/ops/notification-tools-connection.json");
const notifier = createNativeNotifier({ Notification, openDraft: (draftId) => {
  if (!service) return;
  const url = new URL(service.url); url.searchParams.set("view", "console");
  if (draftId) url.searchParams.set("draft", draftId);
  show(url.href);
} });

function show(url = service?.url) {
  if (!window || window.isDestroyed()) return;
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
    // 无法持续监听。只终止本应用任务，Chrome 仍由用户自行管理。
    (async () => {
      await service?.close(); fs.rmSync(connectionFile, { force: true });
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
    const settings = new DesktopSettings(app.getPath("userData"), safeStorage);
    const environment = () => ({ ...settings.environment(), RFQ_NOTIFY_URL: service ? `${service.url}api/desktop/notify` : "", RFQ_NOTIFY_TOKEN: token });
    const builder = new OperatorConsole({ resources, workspace, desktop: true, environment });
    await builder.runJson("scripts/build_case_catalog.mjs", [], 120000);
    service = await createCaseServer({ resources, workspace, desktop: true, desktopSettings: settings,
      environment, importData, notify: notifier.send, notifyToken: token, toolToken });
    fs.writeFileSync(connectionFile, JSON.stringify({ url: `${service.url}api/tools/notifications`, token: toolToken }), { mode: 0o600 });
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 820, minHeight: 620, title: "RFQ 助手",
      backgroundColor: "#f5f3ee", show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => { if (externalAllowed(url)) shell.openExternal(url); return { action: "deny" }; });
    window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== new URL(service.url).origin) event.preventDefault(); });
    window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
    const icon = nativeImage.createFromPath(path.join(resources, "desktop/assets/icon.png")).resize({ width: 18, height: 18 });
    tray = new Tray(icon); tray.setToolTip("RFQ 助手 · 关闭窗口后继续运行");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 RFQ 助手", click: () => show() },
      { label: "打开数据文件夹", click: () => shell.openPath(workspace) },
      { type: "separator" }, { label: "退出并停止任务", click: () => app.quit() }
    ]));
    tray.on("click", () => show());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "RFQ 助手", submenu: [{ label: "打开工作台", click: () => show() }, { role: "hide" }, { type: "separator" }, { label: "退出并停止任务", accelerator: "CmdOrCtrl+Q", click: () => app.quit() }] },
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
