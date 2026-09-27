const fs = require("node:fs");
const path = require("node:path");

/** npm 在 Mac 只安装 Mac 的可选原生模块。交叉打包 Windows 时，必须
 * 换成预先下载的 Windows sharp（包含 .node 和 libvips DLL），否则
 * 主窗口虽然能打开，WebP/GIF 转换和 OCR 会在用户机器上失败。
 * 此钩子仅修改构建目录，不改开发机的 node_modules 或应用数据。
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
  if (!arch) throw new Error("Windows 安装包目前只配置 x64/arm64");
  const name = `sharp-win32-${arch}`;
  const staging = path.join(context.packager.projectDir, "build", `native-win-${arch}`, "node_modules", "@img", name);
  const source = process.platform === "win32" ? path.join(context.packager.projectDir, "node_modules", "@img", name) : staging;
  if (!fs.existsSync(path.join(source, "lib")) || !fs.readdirSync(path.join(source, "lib")).some((file) => file.endsWith(".node"))) {
    throw new Error("缺少 Windows 图片处理模块，请使用 npm run desktop:dist:win");
  }
  const target = path.join(context.appOutDir, "resources/app/node_modules/@img");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry.startsWith("sharp-")) fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
  fs.cpSync(source, path.join(target, name), { recursive: true });
  const sharp = JSON.parse(fs.readFileSync(path.join(context.appOutDir, "resources/app/node_modules/sharp/package.json")));
  const native = JSON.parse(fs.readFileSync(path.join(target, name, "package.json")));
  if (native.version !== sharp.version) throw new Error("Windows sharp 版本与 JS 包不一致");
};
