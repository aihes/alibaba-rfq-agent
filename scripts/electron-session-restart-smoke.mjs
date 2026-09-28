// 真正退出并重启 Electron，验证 Chromium session Cookie 的原始行为、
// 加密恢复以及退出登录后的删除。全部使用临时 userData 和假 Cookie。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "electron-session-fixture.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-session-smoke-"));
const environment = { ...process.env, RFQ_SESSION_SMOKE_DIR: root };
delete environment.ELECTRON_RUN_AS_NODE;

function run(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture], { env: { ...environment, RFQ_SESSION_SMOKE_PHASE: phase }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      try {
        assert.equal(code, 0, `Electron ${phase} failed: ${output.slice(-3000)}`);
        assert.ok(output.includes(`"ok":true,"phase":"${phase}"`), `Missing ${phase} result: ${output.slice(-3000)}`);
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

try {
  for (const phase of ["baseline-write", "baseline-read", "write", "read", "logged-out"]) await run(phase);
  console.log(JSON.stringify({ ok: true, checks: ["native session cookie lost on restart", "encrypted cookie restored", "logout preserved"] }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
