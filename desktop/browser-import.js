const alibabaDomain = (domain) => domain === "alibaba.com" || domain.endsWith(".alibaba.com");

/** 用户在原浏览器主动导出的 Cookie JSON。仅接受 Alibaba 域名，
 * 先校验整份文件再改会话；原始值不返回界面、不记录日志、不另存副本。
 */
export function parseAlibabaLoginFile(text, now = Date.now() / 1000) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("登录文件超过 1 MB 限制");
  let data; try { data = JSON.parse(text); } catch { throw new Error("请选择浏览器导出的登录 JSON 文件，不能导入浏览器配置目录"); }
  const entries = Array.isArray(data) ? data : data?.cookies;
  if (!Array.isArray(entries) || entries.length > 2000) throw new Error("登录文件须包含 Cookie 列表，最多 2000 条");
  const cookies = [], seen = new Set(); let ignored = 0, expired = 0, unsupported = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.domain !== "string") throw new Error("登录文件包含无效 Cookie 记录");
    const domain = entry.domain.toLowerCase().replace(/^\./, "");
    if (!alibabaDomain(domain)) { ignored++; continue; }
    if (entry.partitionKey) { unsupported++; continue; }
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..") || domain.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))) throw new Error("Alibaba 登录记录的域名无效");
    const cookiePath = entry.path ?? "/";
    // Chrome 导出显式提供 hostOnly；Playwright 以有无前导点区分域 Cookie。
    const hostOnly = entry.hostOnly ?? !entry.domain.startsWith(".");
    if (typeof entry.name !== "string" || /[\x00-\x20;=]/.test(entry.name) || typeof entry.value !== "string" || /[\x00-\x1f\x7f]/.test(entry.value)
      || entry.name.length + entry.value.length > 8192 || typeof cookiePath !== "string" || !cookiePath.startsWith("/") || /[\x00-\x1f?#]/.test(cookiePath)) throw new Error("Alibaba 登录记录格式无效");
    for (const key of ["secure", "httpOnly", "hostOnly", "session"]) if (entry[key] !== undefined && typeof entry[key] !== "boolean") throw new Error("Alibaba 登录记录属性无效");
    const expiration = entry.expirationDate ?? entry.expires;
    if (expiration !== undefined && (typeof expiration !== "number" || !Number.isFinite(expiration))) throw new Error("Alibaba 登录记录的有效期无效");
    if (entry.session !== true && expiration !== undefined && expiration !== -1 && expiration <= now) { expired++; continue; }
    const sameSite = { none: "no_restriction", None: "no_restriction", no_restriction: "no_restriction", unspecified: "unspecified", lax: "lax", Lax: "lax", strict: "strict", Strict: "strict" }[entry.sameSite || "unspecified"];
    if (!sameSite || (sameSite === "no_restriction" && entry.secure === false)) throw new Error("Alibaba 登录记录的 SameSite 属性无效");
    const secure = entry.secure !== false;
    if ((entry.name.startsWith("__Secure-") && !secure) || (entry.name.startsWith("__Host-") && (!secure || cookiePath !== "/" || !hostOnly))) throw new Error("Alibaba 登录记录的安全属性无效");
    const identity = JSON.stringify([domain, cookiePath, entry.name]);
    if (seen.has(identity)) throw new Error("登录文件包含重复 Cookie，请重新导出"); seen.add(identity);
    cookies.push({ url: `https://${domain}${cookiePath}`, name: entry.name, value: entry.value, path: cookiePath, secure, httpOnly: entry.httpOnly === true, sameSite,
      ...(hostOnly ? {} : { domain: `.${domain}` }),
      ...(entry.session !== true && expiration !== undefined && expiration > now ? { expirationDate: expiration } : {}) });
  }
  if (!cookies.length) throw new Error("文件中没有可导入的 Alibaba 登录记录，请重新导出或手动登录");
  return { cookies, ignored, expired, unsupported };
}

export async function importAlibabaCookies(session, prepared) {
  // RFQ 专用会话只访问 Alibaba。事务失败时恢复原会话，避免半份登录态。
  // 旧值仅在内存用于回滚，不回传前端；由 Chromium 负责会话落盘与加密。
  let old;
  // 不依赖 Electron 的 domain 过滤差异，完整读取应用自己拥有的
  // Alibaba 会话后做精确域名筛选；绝不访问原 Chrome 的会话存储。
  try { old = (await session.cookies.get({})).filter(cookie => alibabaDomain(cookie.domain.replace(/^\./, ""))); }
  catch { throw new Error("无法读取应用内当前登录记录，请稍后重试"); }
  const restore = old.map((cookie) => ({ url: `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`, name: cookie.name, value: cookie.value,
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }), ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }) }));
  try {
    await session.clearStorageData({ storages: ["cookies"] });
    for (const cookie of prepared.cookies) await session.cookies.set(cookie);
    await session.cookies.flushStore();
  } catch {
    try { await session.clearStorageData({ storages: ["cookies"] }); for (const cookie of restore) await session.cookies.set(cookie); await session.cookies.flushStore(); }
    catch { throw new Error("登录导入失败，原会话未能恢复；请在浏览器手动重新登录"); }
    throw new Error("登录导入失败，已恢复原会话；请重新导出或手动登录");
  }
  return { imported: prepared.cookies.length, ignored: prepared.ignored, expired: prepared.expired, unsupported: prepared.unsupported,
    detail: `已导入 ${prepared.cookies.length} 条 Alibaba 登录记录。打开 RFQ 列表检查账号；会话失效或网站验证时仍需手动登录。` };
}
