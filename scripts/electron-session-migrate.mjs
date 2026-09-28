// 一次性本机迁移：在旧 Electron 开发运行时读取旧安全存储备份，
// 转为本应用数据目录里的 AES-GCM 备份。不会打印 Cookie 或调用网站。
import { app, safeStorage } from "electron";
import path from "node:path";
import { migrateLegacySessionBackup } from "../desktop/alibaba-session-backup.js";

const directory = process.env.RFQ_DESKTOP_DATA_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error("RFQ_DESKTOP_DATA_DIR must be absolute");
app.setName("RFQ 助手");
app.setPath("userData", directory);
app.whenReady().then(() => {
  try {
    const migrated = migrateLegacySessionBackup(directory, safeStorage);
    console.log(JSON.stringify({ ok: true, migrated }));
    app.exit(0);
  } catch (error) {
    console.error(`Alibaba session migration failed: ${error.message}`);
    app.exit(1);
  }
});
