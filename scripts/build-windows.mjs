#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharpVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/sharp/package.json"))).version;
// 在隔离的构建缓存安装目标平台依赖，保持 Mac 开发与 Mac 打包仍可用。
const stage = path.join(root, "build/native-win-x64");
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`构建步骤失败 (${code})`)));
  });
}
// npm_execpath 来自 npm run；通过 Node 运行 npm 的 JS 入口，Windows
// 不需要 shell 去执行 npm.cmd，也不会依赖额外的 PowerShell 配置。
const npm = process.env.npm_execpath;
if (!npm) throw new Error("请通过 npm run desktop:dist:win 启动构建");
if (process.platform !== "win32") await run(process.execPath, [npm, "install", "--prefix", stage,
  "--os=win32", "--cpu=x64", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
  "--registry=https://registry.npmjs.org", `sharp@${sharpVersion}`]);
await run(process.execPath, [require.resolve("electron-builder/out/cli/cli.js"), "--win", "--x64", "--publish", "never"]);
