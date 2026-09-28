import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BACKUP_BYTES = 1024 * 1024;
const MAX_COOKIES = 2000;
const SAVE_DELAY_MS = 250;
const COOKIE_OP_TIMEOUT_MS = 8000;
const ENVELOPE = Buffer.from("RFQ2");

function sessionPaths(userData) {
  return { backup: path.join(userData, "alibaba-session-v2.bin"),
    key: path.join(userData, "alibaba-session.key"),
    legacy: path.join(userData, "alibaba-session.bin") };
}

function localKey(userData, create) {
  const file = sessionPaths(userData).key;
  if (create && !fs.existsSync(file)) {
    fs.mkdirSync(userData, { recursive: true });
    try { fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("Unsafe Alibaba session key permissions");
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error("Invalid Alibaba session key");
  return key;
}

function writeSessionData(userData, data) {
  const plainText = Buffer.from(JSON.stringify(data));
  if (plainText.length > MAX_BACKUP_BYTES) throw new Error("Session backup too large");
  const key = localKey(userData, true), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([ENVELOPE, nonce, cipher.update(plainText), cipher.final(), cipher.getAuthTag()]);
  const file = sessionPaths(userData).backup;
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, encrypted, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}

function readSessionData(userData) {
  let encrypted;
  try { encrypted = fs.readFileSync(sessionPaths(userData).backup); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (encrypted.length < 32 || encrypted.length > MAX_BACKUP_BYTES + 32
    || !encrypted.subarray(0, 4).equals(ENVELOPE)) throw new Error("Invalid session backup");
  const key = localKey(userData, false);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(4, 16));
  decipher.setAuthTag(encrypted.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16, -16)), decipher.final()]).toString("utf8"));
}

function boundedCookieCall(operation, timeoutMs) {
  let timer;
  return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Alibaba cookie store timed out")), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function alibabaDomain(value) {
  if (typeof value !== "string") return false;
  const domain = value.toLowerCase().replace(/^\./, "");
  return domain === "alibaba.com" || domain.endsWith(".alibaba.com");
}

function cookieKey(cookie) {
  return JSON.stringify([cookie.domain.toLowerCase().replace(/^\./, ""), cookie.path || "/", cookie.name]);
}

function sessionCookieDetails(cookie) {
  if (!alibabaDomain(cookie?.domain) || cookie.session !== true || cookie.partitionKey) return null;
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  const cookiePath = cookie.path || "/";
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..") || !cookiePath.startsWith("/")
    || typeof cookie.name !== "string" || typeof cookie.value !== "string"
    || /[\x00-\x20;=]/.test(cookie.name) || /[\x00-\x1f\x7f]/.test(cookie.value)
    || cookie.name.length + cookie.value.length > 8192) return null;
  const secure = cookie.secure !== false;
  if ((cookie.name.startsWith("__Secure-") && !secure)
    || (cookie.name.startsWith("__Host-") && (!secure || cookiePath !== "/" || !cookie.hostOnly))) return null;
  if (!["unspecified", "no_restriction", "lax", "strict"].includes(cookie.sameSite)) return null;
  return {
    url: `https://${domain}${cookiePath}`, name: cookie.name, value: cookie.value,
    path: cookiePath, secure, httpOnly: cookie.httpOnly === true, sameSite: cookie.sameSite,
    ...(cookie.hostOnly ? {} : { domain: `.${domain}` })
  };
}

/**
 * Chromium 的持久分区会保留有过期时间的 Cookie 和站点存储，但不会
 * 在下次进程启动时保留 session Cookie。Alibaba 的登录可能依赖后者。
 * 因此只把本应用自有分区中的 Alibaba session Cookie 加密备份；恢复
 * 发生在首次导航之前。密钥仅在当前用户可读的应用数据目录中，避免
 * macOS 钥匙串能力查询在某些本地签名安装包中卡住主进程。
 * 网页主动退出登录时的 Cookie 删除事件会覆盖备份。不读个人 Chrome，
 * 也不把 Cookie 值写进日志、API 或明文临时文件。
 */
export class AlibabaSessionBackup {
  constructor({ browserSession, userData, logger = console, cookieTimeoutMs = COOKIE_OP_TIMEOUT_MS }) {
    this.browserSession = browserSession;
    this.userData = userData;
    this.file = sessionPaths(userData).backup;
    this.logger = logger;
    this.cookieTimeoutMs = cookieTimeoutMs;
    this.timer = null;
    this.pending = Promise.resolve();
    this.listener = null;
    this.enabled = false;
    this.lastError = null;
    this.retryAttempted = false;
  }

  async start() {
    if (this.listener) return;
    try {
      await this.restore();
      this.listener = (_event, cookie) => {
        if (alibabaDomain(cookie?.domain)) this.schedule();
      };
      this.browserSession.cookies.on("changed", this.listener);
      this.enabled = true;
    } catch {
      this.lastError = "阿里巴巴登录会话首次恢复未完成；打开内置浏览器时会再试一次";
      this.logger.warn(this.lastError);
      // 即使旧备份解密失败，也继续监听新登录，下一次写入可自动修复。
      this.listener = (_event, cookie) => {
        if (alibabaDomain(cookie?.domain)) this.schedule();
      };
      this.browserSession.cookies.on("changed", this.listener);
      this.enabled = true;
    }
  }

  async restore() {
    const data = readSessionData(this.userData);
    if (!data) return;
    if (data?.version !== 1 || !Array.isArray(data.cookies) || data.cookies.length > MAX_COOKIES) throw new Error("Invalid session backup");
    // 某些旧 Chromium 分区会让 Cookie API 一直不返回。应用不能因此
    // 永远停在无窗口状态；打开可见浏览器后会再尝试一次恢复。
    const current = await boundedCookieCall(() => this.browserSession.cookies.get({}), this.cookieTimeoutMs);
    const known = new Set(current.filter(cookie => alibabaDomain(cookie.domain)).map(cookieKey));
    for (const raw of data.cookies) {
      if (!raw || raw.session !== true) throw new Error("Invalid session cookie");
      const details = sessionCookieDetails(raw);
      if (!details) throw new Error("Invalid session cookie");
      const key = cookieKey(raw);
      // Chromium 里的现有 Cookie 更新时，不用旧快照把它覆盖。
      if (known.has(key)) continue;
      await boundedCookieCall(() => this.browserSession.cookies.set(details), this.cookieTimeoutMs);
      known.add(key);
    }
  }

  async retry() {
    if (!this.enabled || !this.lastError || this.retryAttempted) return !this.lastError;
    this.retryAttempted = true;
    try { await this.restore(); this.lastError = null; return true; }
    catch { this.lastError = "阿里巴巴登录会话恢复失败；请在内置浏览器重新登录"; return false; }
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.save().catch(() => {}); }, SAVE_DELAY_MS);
  }

  save() {
    this.pending = this.pending.catch(() => {}).then(async () => {
      const all = await boundedCookieCall(() => this.browserSession.cookies.get({}), this.cookieTimeoutMs);
      const cookies = all.filter(cookie => alibabaDomain(cookie.domain) && cookie.session === true)
        .filter(cookie => sessionCookieDetails(cookie))
        .map(cookie => ({
          domain: cookie.domain, hostOnly: cookie.hostOnly === true, path: cookie.path || "/",
          name: cookie.name, value: cookie.value, secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly === true, sameSite: cookie.sameSite, session: true
        }));
      if (cookies.length > MAX_COOKIES) throw new Error("Too many session cookies");
      writeSessionData(this.userData, { version: 1, cookies });
      this.lastError = null;
    }).catch(() => {
      this.lastError = "阿里巴巴登录会话保存失败；下次打开可能需要重新登录";
      this.logger.warn(this.lastError);
    });
    return this.pending;
  }

  async flush() {
    if (!this.enabled) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.save();
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.listener) this.browserSession.cookies.off("changed", this.listener);
    this.listener = null;
  }
}

/** 仅供已有本机用户在可访问旧钥匙串的 Electron 进程中迁移一次。 */
export function migrateLegacySessionBackup(userData, safeStorage) {
  const paths = sessionPaths(userData);
  if (fs.existsSync(paths.backup)) return false;
  const encrypted = fs.readFileSync(paths.legacy);
  if (!encrypted.length || encrypted.length > MAX_BACKUP_BYTES) throw new Error("Invalid legacy session backup");
  const data = JSON.parse(safeStorage.decryptString(encrypted));
  if (data?.version !== 1 || !Array.isArray(data.cookies) || data.cookies.length > MAX_COOKIES
    || data.cookies.some((cookie) => cookie?.session !== true || !sessionCookieDetails(cookie))) {
    throw new Error("Invalid legacy session backup");
  }
  writeSessionData(userData, data);
  return true;
}
