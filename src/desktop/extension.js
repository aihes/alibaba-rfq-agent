import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

/** 安装包中携带官方 ZIP；只解压固定资源到稳定的用户目录。
 * 不下载、不启动 Chrome、不修改用户配置或替用户授予插件权限。
 */
export class BrowserExtension {
  constructor(resources, workspace) {
    this.vendor = path.join(resources, "vendor/midscene");
    this.metadata = JSON.parse(fs.readFileSync(path.join(this.vendor, "extension.json"), "utf8"));
    this.archive = path.join(this.vendor, this.metadata.archive);
    this.installPath = path.join(workspace, "data/browser-extension", `midscene-v${this.metadata.releaseVersion}`);
  }
  bytes() {
    const bytes = fs.readFileSync(this.archive);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== this.metadata.sha256) throw new Error("Midscene 安装包校验失败");
    return bytes;
  }
  ready() {
    try {
      if (fs.lstatSync(this.installPath).isSymbolicLink()) return false;
      const marker = JSON.parse(fs.readFileSync(path.join(this.installPath, ".bundle.json"), "utf8"));
      const manifest = JSON.parse(fs.readFileSync(path.join(this.installPath, "manifest.json"), "utf8"));
      return marker.sha256 === this.metadata.sha256 && manifest.version === this.metadata.manifestVersion
        && marker.files.length > 0 && marker.files.every((name) => {
          const file = path.resolve(this.installPath, name);
          return file.startsWith(this.installPath + path.sep) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile();
        });
    } catch { return false; }
  }
  info() { return { ...this.metadata, ready: this.ready(), installPath: this.installPath, downloadUrl: "/api/extension/download" }; }
  prepare() {
    const bytes = this.bytes();
    if (this.ready()) return this.info();
    if (fs.existsSync(this.installPath)) throw new Error("插件目录不完整，请先关闭插件并移除页面显示的目录，再准备安装文件");
    const entries = new AdmZip(bytes).getEntries();
    if (entries.reduce((size, entry) => size + entry.header.size, 0) > 100 * 1024 * 1024) throw new Error("插件解压大小异常");
    for (const entry of entries) {
      const name = entry.entryName;
      if (path.posix.isAbsolute(name) || name.split("/").includes("..") || /[\\:]/.test(name)
        || ((entry.header.attr >>> 16) & 0o170000) === 0o120000) throw new Error("插件包含不安全路径");
    }
    const parent = path.dirname(this.installPath);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, ".prepare-"));
    try {
      for (const entry of entries) {
        const file = path.join(staging, entry.entryName);
        if (entry.isDirectory) fs.mkdirSync(file, { recursive: true });
        else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry.getData()); }
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
      if (manifest.name !== this.metadata.name || manifest.version !== this.metadata.manifestVersion || manifest.manifest_version !== 3) throw new Error("插件版本不匹配");
      fs.writeFileSync(path.join(staging, ".bundle.json"), JSON.stringify({ sha256: this.metadata.sha256, files: entries.filter((e) => !e.isDirectory).map((e) => e.entryName) }));
      fs.renameSync(staging, this.installPath);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    return this.info();
  }
}
