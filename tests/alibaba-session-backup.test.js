import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlibabaSessionBackup, migrateLegacySessionBackup } from "../desktop/alibaba-session-backup.js";

test("a stalled cookie store cannot leave the desktop app without a window, and visible-browser retry restores login", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-session-timeout-"));
  try {
    const cookie = { domain: ".alibaba.com", hostOnly: false, path: "/", name: "fixture-login",
      value: "synthetic-only", secure: true, httpOnly: true, sameSite: "lax", session: true };
    fs.writeFileSync(path.join(userData, "alibaba-session.bin"), Buffer.from("encrypted-fixture"));
    assert.equal(migrateLegacySessionBackup(userData, {
      decryptString: () => JSON.stringify({ version: 1, cookies: [cookie] })
    }), true);
    assert.equal(fs.readFileSync(path.join(userData, "alibaba-session-v2.bin")).includes(Buffer.from("synthetic-only")), false);
    let gets = 0, restored = null;
    const browserSession = { cookies: {
      get: async () => ++gets === 1 ? new Promise(() => {}) : [],
      set: async (value) => { restored = value; }, on: () => {}, off: () => {}
    } };
    const backup = new AlibabaSessionBackup({ browserSession, userData, cookieTimeoutMs: 15,
      logger: { warn: () => {} } });
    await backup.start();
    assert.equal(backup.enabled, true);
    assert.match(backup.lastError, /再试一次/);
    assert.equal(await backup.retry(), true);
    assert.equal(restored.name, "fixture-login");
    assert.equal(backup.lastError, null);
    backup.close();
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
});
