// 仅用于隔离的跨进程登录会话回归；不打开网站或读取生产用户目录。
import { app, session } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AlibabaSessionBackup } from "../desktop/alibaba-session-backup.js";
import { RFQ_PARTITION } from "../desktop/embedded-browser.js";

const root = process.env.RFQ_SESSION_SMOKE_DIR;
const phase = process.env.RFQ_SESSION_SMOKE_PHASE;
if (!root || !["baseline-write", "baseline-read", "write", "read", "logged-out"].includes(phase)) throw new Error("Isolated fixture directory and phase required");
app.setName("RFQ 助手");
app.setPath("userData", path.join(root, "userData"));
app.whenReady().then(async () => {
  try {
    const browserSession = session.fromPartition(RFQ_PARTITION);
    const backup = new AlibabaSessionBackup({ browserSession, userData: app.getPath("userData") });
    const name = "__Host-rfq-session-fixture";
    const url = "https://passport.alibaba.com/";
    if (phase === "baseline-write") {
      await browserSession.cookies.set({ url, name, value: "synthetic-session", path: "/", secure: true, httpOnly: true, sameSite: "lax" });
      await browserSession.cookies.flushStore();
    } else if (phase === "baseline-read") {
      assert.equal((await browserSession.cookies.get({ url, name })).length, 0, "Chromium should discard session cookies across process restart");
    } else {
      await backup.start();
      assert.equal(backup.enabled, true, backup.lastError || "session backup unavailable");
      if (phase === "write") {
        await browserSession.cookies.set({ url, name, value: "synthetic-session", path: "/", secure: true, httpOnly: true, sameSite: "lax" });
        await backup.flush();
        const stored = fs.readFileSync(backup.file);
        assert.equal(stored.includes(Buffer.from("synthetic-session")), false, "The backup must contain no plaintext cookie value");
        if (process.platform !== "win32") assert.equal(fs.statSync(backup.file).mode & 0o777, 0o600);
      } else if (phase === "read") {
        assert.equal((await browserSession.cookies.get({ url, name })).length, 1, "Encrypted session backup should restore cookie");
        await browserSession.cookies.remove(url, name);
        await backup.flush();
      } else {
        assert.equal((await browserSession.cookies.get({ url, name })).length, 0, "Explicit logout must not be undone after restart");
      }
      backup.close();
      await browserSession.cookies.flushStore();
    }
    console.log(JSON.stringify({ ok: true, phase }));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  }
});
