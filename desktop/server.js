import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { OperatorConsole } from "./console.js";
import { BrowserExtension } from "./extension.js";
import { createNotificationTools } from "../src/notification-tools.js";

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function contained(file, directory) {
  const real = fs.realpathSync(file), root = fs.realpathSync(directory);
  if (!real.startsWith(root + path.sep)) throw new Error("文件超出允许范围");
  return real;
}

/** 只绑定 loopback。Host 防 DNS rebinding，Origin + 自定义头防跨站
 * 操作。所有证据文件由 catalog 白名单选取，客户端不能指定绝对路径。
 */
export async function createCaseServer(options) {
  const { resources, workspace, port = 0, desktopSettings, importData, notify, notifyToken, toolToken } = options;
  const console = new OperatorConsole(options);
  const tools = createNotificationTools({ workspace, file: console.settingsFile,
    ...(notify ? { send: notify } : {}) });
  const extension = new BrowserExtension(resources, workspace);
  let extensionError = null;
  try { extension.prepare(); } catch (error) { extensionError = error.message; }
  const catalogFile = path.join(workspace, "data/case-catalog/cases.json");
  let catalog, mtime;
  const getCatalog = () => {
    const stamp = fs.statSync(catalogFile).mtimeMs;
    if (!catalog || stamp !== mtime) { catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8")); mtime = stamp; }
    return catalog;
  };
  getCatalog();
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    const reply = (code, body, type = "application/json; charset=utf-8", name) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      res.writeHead(code, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store",
        "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        ...(name ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}) });
      res.end(bytes);
    };
    const fail = (code, message) => reply(code, { error: message });
    try {
      if (!hosts.has(req.headers.host)) return fail(403, "仅允许本机访问");
      const url = new URL(req.url, `http://127.0.0.1:${address.port}`), route = url.pathname;
      if (req.method === "POST") {
        const native = route === "/api/desktop/notify" && notifyToken && req.headers["x-rfq-notify"] === notifyToken;
        const tool = route === "/api/tools/notifications" && toolToken && req.headers["x-rfq-tool"] === toolToken;
        if (!native && !tool && (!new Set([...hosts].map((host) => `http://${host}`)).has(req.headers.origin) || req.headers["x-case-console"] !== "1")) return fail(403, "操作请求来源无效");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") return fail(415, "仅接受 JSON 请求");
        const length = Number(req.headers["content-length"]);
        if (!Number.isInteger(length) || length <= 0 || length > 16384) return fail(413, "请求过大或为空");
        let body = "";
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return fail(413, "请求过大"); }
        let payload; try { payload = JSON.parse(body); } catch { return fail(400, "请求 JSON 无效"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail(400, "请求格式无效");
        const empty = () => { if (Object.keys(payload).length) throw new Error("此操作不接受额外参数"); };
        let result;
        if (native) {
          if (!console.settings.notificationsEnabled) result = { status: "disabled", detail: "机会系统通知已关闭" };
          else result = await notify(payload);
        } else if (route === "/api/tools/notifications") {
          if (Object.keys(payload).some((key) => !["tool", "arguments"].includes(key))) throw new Error("通知工具参数无效");
          result = await tools.call(payload.tool, payload.arguments);
        } else if (route === "/api/ops/start") result = console.start(payload);
        else if (route === "/api/ops/stop") { empty(); result = console.stop(); }
        else if (route === "/api/ops/settings") result = console.updateSettings(payload);
        else if (route === "/api/ops/quote/start") result = await console.startQuote(payload);
        else if (route === "/api/notifications/test") { empty(); result = await console.testNotification(); }
        else if (route === "/api/extension/prepare") { empty(); result = extension.prepare(); extensionError = null; }
        else if (route === "/api/desktop/settings" && desktopSettings) {
          console.assertIdle(); result = desktopSettings.save(payload);
        } else if (route === "/api/desktop/model/test" && desktopSettings) {
          empty(); console.assertIdle();
          const { callModelHttp } = await import("../src/model-http.js");
          const v = desktopSettings.value;
          const data = v.agentProvider === "anthropic-http"
            ? await (await import("../src/claude.js")).callAnthropicHttp({ anthropicApiKey: v.modelApiKey, anthropicModel: v.modelName }, "Return JSON only: {\"ok\":true}", { test: true }, 64)
            : await callModelHttp({ modelApiKey: v.modelApiKey, modelApiUrl: v.modelApiUrl, modelName: v.modelName }, "Return JSON only: {\"ok\":true}", { test: true }, 64);
          if (data.ok !== true) throw new Error("模型返回格式不符合要求");
          result = { ok: true, detail: "模型连接成功；测试仅发送固定文本，会产生少量 API 用量" };
        } else if (route === "/api/desktop/import" && importData) { empty(); console.assertIdle(); result = await importData(console); }
        else return fail(404, "操作不存在");
        return reply(200, result);
      }
      if (req.method !== "GET") return fail(405, "请求方法不支持");
      if (["/", "/app.js", "/styles.css"].includes(route)) {
        const file = path.join(resources, "frontend/src", route === "/" ? "index.html" : route.slice(1));
        return reply(200, fs.readFileSync(file), mime[path.extname(file)]);
      }
      if (route === "/api/desktop/info") return reply(200, { desktop: Boolean(desktopSettings), workspace,
        platform: process.platform, extensionError, ...(desktopSettings ? { settings: desktopSettings.info() } : {}) });
      if (route === "/api/tools/notifications") return reply(200, { tools: tools.definitions, ...tools.status() });
      if (route === "/api/catalog") return reply(200, getCatalog());
      if (route === "/api/ops/status") return reply(200, console.snapshot());
      if (route === "/api/env/check") return reply(200, await console.envCheck(url.searchParams.get("force") === "1"));
      if (route === "/api/quotes") return reply(200, await console.listQuotes());
      if (route === "/api/extension") return reply(200, extension.info());
      if (route === "/api/extension/download") return reply(200, extension.bytes(), "application/zip", extension.metadata.archive);
      if (["/api/quote", "/api/quote/screenshot"].includes(route)) {
        const review = await console.reviewQuote(url.searchParams.get("draft"));
        if (route === "/api/quote") return reply(200, review);
        if (!review.screenshotAvailable || !/^[a-zA-Z0-9_-]+$/.test(review.rfq.id)) return fail(404, "回填截图不存在");
        const dir = path.join(workspace, "data/drafts");
        return reply(200, fs.readFileSync(contained(path.join(dir, `${review.rfq.id}-filled.png`), dir)), "image/png");
      }
      const item = getCatalog().cases.find((item) => item.id === url.searchParams.get("case"));
      if (!item) return fail(404, "CASE 不存在");
      if (route === "/api/image") {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 0 || !item.images[index]) return fail(404, "图片不存在");
        const file = contained(path.join(workspace, "data", item.images[index]), path.join(workspace, "data/rfqs"));
        return reply(200, fs.readFileSync(file), mime[path.extname(file)] || "application/octet-stream");
      }
      if (route === "/api/source") {
        const source = item.sources.find((x) => x.id === url.searchParams.get("source"));
        if (!source) return fail(404, "来源文件不存在");
        if (source.kind === "archive_workbook") {
          const zip = new AdmZip(path.join(workspace, "data/reference-materials/2026-09-23-dingtalk/9.23报价模版收集.zip"));
          const entry = zip.getEntries()[source.archiveIndex];
          if (!entry || entry.isDirectory) return fail(404, "来源文件不存在");
          return reply(200, entry.getData(), "application/octet-stream", source.name);
        }
        if (source.kind === "local_json") return reply(200, fs.readFileSync(contained(path.join(workspace, source.path), path.join(workspace, "data/drafts"))), mime[".json"], source.name);
      }
      return fail(404, "页面不存在");
    } catch (error) {
      // 文件读取错误不回传绝对路径或堆栈。设置、授权错误保留可操作描述。
      return fail(error.code ? 404 : 409, error.code ? "文件不存在或无法读取" : error.message);
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.url = url;
  return { server, console, url, extension, async close() {
    const stopped = new Promise((resolve) => server.close(resolve));
    await console.close(); server.closeAllConnections(); await stopped;
  } };
}
