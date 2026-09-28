import fs from "node:fs";
import path from "node:path";
const target = process.argv[2] || "dist/desktop/mac-arm64/RFQ助手.app/Contents/Resources/app";
const forbidden = ["data", ".env", "tests", ".git", "config/local.json"];
for (const relative of forbidden) if (fs.existsSync(path.join(target, relative))) throw new Error(`私有/开发文件被打包：${relative}`);
for (const relative of ["desktop/main.js", "desktop/embedded-browser.js", "desktop/browser-toolbar.html", "desktop/browser-toolbar.css", "desktop/browser-toolbar.js", "desktop/browser-toolbar-preload.cjs", "desktop/browser-import.js", "desktop/model-environment.js", "plugins/alibaba-login-export/manifest.json", "plugins/alibaba-login-export/popup.html", "plugins/alibaba-login-export/popup.js", "plugins/alibaba-login-export/popup.css", "src/electron-browser.js", "src/dom-locator.js", "desktop/native-notifications.js", "src/notification-tools.js", "scripts/notification-tools.mjs", "frontend/src/app.js", "vendor/midscene/extension.json", "src/ocr.js", "node_modules/sharp/package.json"]) if (!fs.existsSync(path.join(target, relative))) throw new Error(`缺少运行资源：${relative}`);
if (process.argv[3] === "win-x64") {
  const native = path.join(target, "node_modules/@img/sharp-win32-x64/lib");
  for (const file of ["sharp-win32-x64-0.35.4.node", "libvips-42.dll", "libvips-cpp-8.18.6.dll"]) {
    const bytes = fs.readFileSync(path.join(native, file));
    if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error(`Windows x64 原生模块无效：${file}`);
  }
  const foreign = fs.readdirSync(path.join(target, "node_modules/@img")).filter((name) => name.startsWith("sharp-") && name !== "sharp-win32-x64");
  if (foreign.length) throw new Error(`错误平台的图片处理模块：${foreign.join(", ")}`);
}
console.log("安装包资源检查通过：包含运行资源和插件，不包含私有 data 或 .env。");
