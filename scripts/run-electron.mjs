/** 一些开发宿主以 ELECTRON_RUN_AS_NODE=1 启动任务。启动桌面应用时
 * 必须清除此标记；它只应在应用自己的 Node 工作进程中使用。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const testing = process.argv[2] === "scripts/electron-browser-smoke.mjs";
let output = "";
const child = spawn(require("electron"), process.argv.slice(2), { env: environment, stdio: testing ? ["inherit", "pipe", "inherit"] : "inherit" });
if (testing) child.stdout.on("data", (chunk) => { process.stdout.write(chunk); output = (output + chunk).slice(-16000); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("close", (code) => {
  if (testing) {
    const line = output.split("\n").find((x) => x.startsWith('{"ok":true'));
    const root = line ? JSON.parse(line).workspace : null;
    if (root && fs.existsSync(root) && path.dirname(fs.realpathSync(root)) === fs.realpathSync(os.tmpdir()) && path.basename(root).startsWith("rfq-electron-smoke-")) fs.rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = code ?? 1;
});
