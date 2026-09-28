import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
import { OperatorConsole } from "./console.js";
import { BrowserExtension } from "./extension.js";
import { createNotificationTools } from "../src/notification-tools.js";
import { readQuoteImage } from "../src/quote-images.js";

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function safeProbeError(error, environment) {
  let message = String(error?.message || "服务调用失败");
  for (const key of ["MODEL_API_KEY", "GLM_OCR_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (environment[key]) message = message.replaceAll(environment[key], "[redacted]");
  }
  return message.slice(0, 250);
}
function contained(file, directory) {
  const real = fs.realpathSync(file), root = fs.realpathSync(directory);
  if (!real.startsWith(root + path.sep)) throw new Error("文件超出允许范围");
  return real;
}

/** 只绑定 loopback。Host 防 DNS rebinding，Origin + 自定义头防跨站
 * 操作。所有证据文件由 catalog 白名单选取，客户端不能指定绝对路径。
 */
export async function createCaseServer(options) {
  const { resources, workspace, port = 0, desktopSettings, importData, importBrowserLogin, testLocalClaude, testOcr, notify, notifyToken, toolToken, embeddedBrowser, browserToken } = options;
  const console = new OperatorConsole(options);
  const tools = createNotificationTools({ workspace, file: console.settingsFile,
    ...(notify ? { send: notify } : {}) });
  const extension = new BrowserExtension(resources, workspace);
  let extensionError = null;
  // 桌面内置浏览器不加载扩展；仅 Web 兼容模式准备 Chrome Bridge 文件。
  if (!embeddedBrowser) try { extension.prepare(); } catch (error) { extensionError = error.message; }
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
        const browser = route === "/api/desktop/browser/command" && browserToken && req.headers["x-rfq-browser"] === browserToken;
        // 工作台网页不能凭 Origin + 控制台头获得 CDP。专用令牌只在进程
        // 环境中分发，不返回给 renderer，也不能用于设置/通知/其他路由。
        if (route === "/api/desktop/browser/command" && !browser) return fail(403, "内置浏览器任务授权无效");
        if (!native && !tool && !browser && (!new Set([...hosts].map((host) => `http://${host}`)).has(req.headers.origin) || req.headers["x-case-console"] !== "1")) return fail(403, "操作请求来源无效");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json") return fail(415, "仅接受 JSON 请求");
        const length = Number(req.headers["content-length"]);
        if (!Number.isInteger(length) || length <= 0 || length > 16384) return fail(413, "请求过大或为空");
        let body = "";
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return fail(413, "请求过大"); }
        let payload; try { payload = JSON.parse(body); } catch { return fail(400, "请求 JSON 无效"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail(400, "请求格式无效");
        const empty = () => { if (Object.keys(payload).length) throw new Error("此操作不接受额外参数"); };
        let result;
        if (browser && embeddedBrowser) result = await embeddedBrowser.command(payload);
        else if (route === "/api/desktop/browser/open" && embeddedBrowser) {
          if (Object.keys(payload).some((key) => key !== "url") || ("url" in payload && typeof payload.url !== "string")) throw new Error("浏览器打开参数无效");
          if (payload.url) console.assertIdle();
          result = await embeddedBrowser.open(payload.url);
        } else if (route === "/api/desktop/browser/navigate" && embeddedBrowser) {
          if (Object.keys(payload).some((key) => !["action", "url"].includes(key)) || typeof payload.action !== "string" || ("url" in payload && (payload.action !== "navigate" || typeof payload.url !== "string"))) throw new Error("浏览器导航参数无效");
          if (payload.action !== "hide") console.assertIdle();
          result = await embeddedBrowser.manual(payload);
        } else if (route === "/api/desktop/browser/inspect" && embeddedBrowser) {
          empty(); console.assertIdle(); result = await embeddedBrowser.inspect();
        } else if (route === "/api/desktop/browser/import" && importBrowserLogin) {
          empty(); console.assertIdle(); result = await importBrowserLogin(console);
        } else if (native) {
          if (!console.settings.notificationsEnabled) result = { status: "disabled", detail: "机会系统通知已关闭" };
          else result = await notify(payload);
        } else if (route === "/api/tools/notifications") {
          if (Object.keys(payload).some((key) => !["tool", "arguments"].includes(key))) throw new Error("通知工具参数无效");
          result = await tools.call(payload.tool, payload.arguments);
        } else if (route === "/api/ops/start") result = console.start(payload);
        else if (route === "/api/quotes/archive") result = console.archiveQuote(payload);
        else if (route === "/api/ops/stop") { empty(); result = console.stop(); }
        else if (route === "/api/ops/settings") result = console.updateSettings(payload);
        else if (route === "/api/ops/quote/start") result = await console.startQuote(payload);
        else if (route === "/api/notifications/test") { empty(); result = await console.testNotification(); }
        else if (route === "/api/extension/prepare") { empty(); result = extension.prepare(); extensionError = null; }
        else if (route === "/api/desktop/settings" && desktopSettings) {
          console.assertIdle(); result = desktopSettings.save(payload);
        } else if (route === "/api/desktop/settings/environment" && desktopSettings) {
          empty(); console.assertIdle(); result = await desktopSettings.refreshEnvironment();
        } else if (route === "/api/desktop/model/test" && desktopSettings) {
          empty(); console.assertIdle();
          // 只有显式点击才实际调用模型。失败结果也记入本次进程的环境状态；
          // GET 环境检查永远不触发付费请求。
          try {
          const { callModelHttp } = await import("../src/model-http.js");
          const v = desktopSettings.resolved().value;
          let data;
          if (v.agentProvider === "local-claude-sdk") {
            const env = desktopSettings.environment();
            if (!env.LOCAL_CLAUDE_EXECUTABLE) throw new Error("未找到本机 Claude，请安装或切换 GLM HTTP");
            if (testLocalClaude) data = await testLocalClaude(env);
            else {
              const { runLocalAgentJson } = await import("../src/local-agent.js");
              const sdk = await runLocalAgentJson({ localClaudeExecutable: env.LOCAL_CLAUDE_EXECUTABLE,
                localClaudeModel: env.LOCAL_CLAUDE_MODEL, localClaudeSettingSources: [],
                localClaudeStructuredOutput: false, localClaudeTimeoutMs: 120000, localClaudeMaxBudgetUsd: 0.05,
                localClaudeEnvironment: Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
                  .filter(key => env[key]).map(key => [key, env[key]])) },
              { prompt: 'Return exactly this JSON object and nothing else: {"ok":true}',
                schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } });
              data = sdk.data;
            }
          } else if (v.agentProvider === "anthropic-http") data = await (await import("../src/claude.js"))
            .callAnthropicHttp({ anthropicApiKey: v.modelApiKey, anthropicModel: v.modelName, anthropicApiUrl: v.modelApiUrl }, "Return JSON only: {\"ok\":true}", { test: true }, 256);
          else data = await callModelHttp({ modelApiKey: v.modelApiKey, modelApiUrl: v.modelApiUrl, modelName: v.modelName }, "Return JSON only: {\"ok\":true}", { test: true }, 256);
          if (data.ok !== true) throw new Error("模型返回格式不符合要求");
          result = { ok: true, detail: "模型连接成功；测试仅发送固定文本，会产生少量模型用量" };
          console.recordServiceCheck("model", true, "固定文本请求成功，模型返回格式正确");
          } catch (error) {
            const message = safeProbeError(error, desktopSettings.environment());
            console.recordServiceCheck("model", false, message);
            throw new Error(message);
          }
        } else if (route === "/api/desktop/ocr/test" && desktopSettings) {
          empty(); console.assertIdle();
          try {
            const env = desktopSettings.environment();
            if (env.OCR_PROVIDER === "off") throw new Error("图片识别已关闭，请先在设置中开启");
            if (!env.GLM_OCR_API_KEY) throw new Error("未配置 GLM OCR API Key，请检查设置或本机环境变量");
            let ocr;
            if (testOcr) ocr = await testOcr(env);
            else {
              const { default: sharp } = await import("sharp");
              const { extractImageText } = await import("../src/ocr.js");
              const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-ocr-check-"));
              try {
                // 固定样张只含测试文字，不上传用户 RFQ 或浏览器内容。
                const svg = '<svg width="640" height="180" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="34" y="112" font-family="Arial,sans-serif" font-size="72" font-weight="bold" fill="black">RFQ 123</text></svg>';
                const image = path.join(directory, "probe.png");
                fs.writeFileSync(image, await sharp(Buffer.from(svg)).png().toBuffer());
                ocr = await extractImageText(image, { ocrProvider: env.OCR_PROVIDER, ocrApiKey: env.GLM_OCR_API_KEY,
                  ocrApiUrl: env.GLM_OCR_API_URL, ocrTimeoutMs: 30000 });
              } finally { fs.rmSync(directory, { recursive: true, force: true }); }
            }
            if (ocr?.status !== "read" || !/RFQ/i.test(ocr.text || "") || !/123/.test(ocr.text || ""))
              throw new Error(ocr?.error || "OCR 已响应，但未能正确识别测试样张 RFQ 123");
            result = { ok: true, detail: "OCR 连接成功，已识别内置样张 RFQ 123；会产生少量 OCR 用量" };
            console.recordServiceCheck("ocr", true, "内置样张 RFQ 123 识别成功");
          } catch (error) {
            const message = safeProbeError(error, desktopSettings.environment());
            console.recordServiceCheck("ocr", false, message);
            throw new Error(message);
          }
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
        platform: process.platform, version: JSON.parse(fs.readFileSync(path.join(resources, "package.json"), "utf8")).version,
        runtime: { node: process.versions.node, electron: process.versions.electron || null, chromium: process.versions.chrome || null },
        extensionError, browserProvider: embeddedBrowser ? "electron-cdp" : "chrome-bridge", ...(desktopSettings ? { settings: desktopSettings.info() } : {}) });
      if (route === "/api/desktop/browser" && embeddedBrowser) return reply(200, await console.browserStatus());
      if (route === "/api/desktop/browser/export-tool" && embeddedBrowser) {
        const zip = new AdmZip(); zip.addLocalFolder(path.join(resources, "plugins/alibaba-login-export"));
        return reply(200, zip.toBuffer(), "application/zip", "RFQ-Alibaba-Login-Export.zip");
      }
      if (route === "/api/tools/notifications") return reply(200, { tools: tools.definitions, ...tools.status() });
      if (route === "/api/catalog") return reply(200, getCatalog());
      if (route === "/api/ops/status") return reply(200, console.snapshot());
      if (route === "/api/ops/stage") return reply(200, console.stageDetail(Number(url.searchParams.get("index"))));
      if (route === "/api/env/check") return reply(200, await console.envCheck(url.searchParams.get("force") === "1"));
      if (route === "/api/quotes") return reply(200, await console.listQuotes());
      if (route === "/api/quote/image") {
        const index = url.searchParams.get("index");
        const image = /^(0|[1-9]\d*)$/.test(index || "")
          ? readQuoteImage(workspace, url.searchParams.get("draft"), Number(index)) : null;
        if (!image) return fail(404, "这张 RFQ 图片未保存在本机");
        return reply(200, fs.readFileSync(image.file), image.type);
      }
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
