import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCaseServer } from "../src/desktop/server.js";
import { DesktopSettings } from "../src/desktop/settings.js";
import { OperatorConsole } from "../src/desktop/console.js";
import { callModelHttp } from "../src/model-http.js";
import { importCaseData } from "../src/desktop/import-data.js";
import { notifyOpportunity } from "../src/notifications.js";
const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "rfq-desktop-test-"));
function seed(root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  for (const name of ["default.json", "pricing-rules.json"]) fs.copyFileSync(path.join(resources, "config", name), path.join(root, "config", name));
  execFileSync(process.execPath, [path.join(resources, "scripts/build_case_catalog.mjs")], { env: { ...process.env, RFQ_WORKSPACE_DIR: root }, stdio: "pipe" });
}
test("empty installed workspace builds a catalog without developer data or Python", () => {
  const root = temporary();
  try { seed(root); const c = JSON.parse(fs.readFileSync(path.join(root, "data/case-catalog/cases.json"))); assert.equal(c.counts.cases, 0); assert.deepEqual(c.cases, []); }
  finally { fs.rmSync(root, { recursive: true }); }
});
test("settings persist encrypted secrets, never return them, blank preserves and explicit clear deletes", () => {
  const root = temporary();
  const cipher = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v).map((x) => x ^ 0x55), decryptString: (v) => Buffer.from(v).map((x) => x ^ 0x55).toString() };
  try {
    const settings = new DesktopSettings(root, cipher);
    settings.save({ agentProvider: "openai-http" });
    const info = settings.save({ modelApiKey: "test-model-key", ocrApiKey: "test-ocr-key" });
    assert.equal(info.modelKeyConfigured, true); assert.ok(!JSON.stringify(info).includes("test-model-key"));
    assert.ok(!fs.readFileSync(settings.file, "utf8").includes("test-model-key"));
    const restored = new DesktopSettings(root, cipher); assert.equal(restored.environment().MODEL_API_KEY, "test-model-key");
    restored.save({ modelApiKey: "" }); assert.equal(restored.environment().MODEL_API_KEY, "test-model-key");
    restored.save({ modelApiUrl: "https://another-provider.example/v1/chat/completions" });
    assert.equal(restored.info().modelKeyConfigured, false);
    assert.equal(restored.info().ocrKeyConfigured, true);
    restored.save({ clearSecrets: ["modelApiKey", "ocrApiKey"] }); assert.equal(new DesktopSettings(root, cipher).info().modelKeyConfigured, false);
    assert.throws(() => restored.save({ modelApiUrl: "http://example.com" }), /HTTPS/);
    assert.throws(() => restored.save({ agentProvider: "unknown-provider" }));
    const unavailable = new DesktopSettings(root, { ...cipher, isEncryptionAvailable: () => false });
    assert.throws(() => unavailable.save({ modelApiKey: "never-plaintext" }), /加密不可用/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("opening an unconfigured workbench does not request keychain access", () => {
  const root = temporary();
  try {
    const settings = new DesktopSettings(root, { isEncryptionAvailable: () => assert.fail("GET must not access keychain"), decryptString: () => assert.fail("no saved secrets") });
    assert.equal(settings.info().encryptedStorage, null);
    assert.equal(settings.info().modelKeyConfigured, false);
    assert.equal(settings.environment().MODEL_API_KEY, "");
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("workbench HTTP retains local authorization and evidence allowlist with browser capability on", async () => {
  const root = temporary(); seed(root);
  const service = await createCaseServer({ resources, workspace: root, spawnProcess: () => assert.fail("browser/process must not run") });
  try {
    const get = async (route) => fetch(service.url + route);
    assert.equal((await (await get("api/catalog")).json()).counts.cases, 0);
    let probes = 0;
    const originalRunJson = service.console.runJson.bind(service.console);
    service.console.runJson = async () => { probes++; return { connected: false, loggedIn: false }; };
    assert.equal((await (await get("api/env/check?force=1")).json()).status, "checked");
    assert.equal(probes, 1);
    service.console.runJson = originalRunJson;
    assert.equal((await get("api/extension")).status, 200);
    const priceCsv = await get("price-csv.js");
    assert.equal(priceCsv.status, 200);
    assert.match(priceCsv.headers.get("content-type"), /text\/javascript/);
    const post = (origin, payload) => fetch(service.url + "api/ops/settings", { method: "POST", headers: { "Content-Type": "application/json", "X-Case-Console": "1", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload) });
    assert.equal((await post("https://attacker.example", { browserEnabled: true })).status, 403);
    assert.equal((await post(null, { browserEnabled: true })).status, 403);
    assert.equal((await post(new URL(service.url).origin, { quoteEnabled: true })).status, 200);
    assert.equal((await post(new URL(service.url).origin, { alertsEnabled: false })).status, 200);
    assert.equal((await get("api/image?case=../../.env&index=0")).status, 404);
    const images = path.join(root, "data/rfqs/rfq-photo/images");
    const drafts = path.join(root, "data/drafts");
    fs.mkdirSync(images, { recursive: true }); fs.mkdirSync(drafts, { recursive: true });
    fs.writeFileSync(path.join(images, "product-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    fs.writeFileSync(path.join(drafts, "rfq-photo.json"), JSON.stringify({ rfq: { id: "rfq-photo",
      title: "Buyer product photo", imageAssets: [{ filePath: "/previous-computer/product-1.png" }] },
      analysis: { categoryId: "paper_shopping_bag", recommendation: "review" },
      quote: { status: "needs_review" }, submission: { status: "skipped" } }));
    const photo = await get("api/quote/image?draft=rfq-photo&index=0");
    assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/png");
    assert.equal((await get("api/quote/image?draft=rfq-photo")).status, 404);
    assert.equal((await get("api/quote/image?draft=..%2F..%2F.env&index=0")).status, 404);
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("pending RFQ exposes its captured buyer image in list and read-only detail", async () => {
  const root = temporary(); seed(root);
  const images = path.join(root, "data/rfqs/rfq-photo/images");
  fs.mkdirSync(images, { recursive: true });
  fs.mkdirSync(path.join(root, "data/drafts"), { recursive: true });
  fs.writeFileSync(path.join(images, "product-1.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(root, "data/drafts/rfq-photo.json"), JSON.stringify({
    rfq: { id: "rfq-photo", title: "Buyer product photo", imageAssets: [{ filePath: "/previous-computer/product-1.png" }] },
    analysis: { categoryId: "paper_shopping_bag", recommendation: "review" },
    quote: { status: "needs_review" }, submission: { status: "skipped" }
  }));
  const service = await createCaseServer({ resources, workspace: root });
  try {
    const listed = await (await fetch(service.url + "api/quotes")).json();
    assert.deepEqual(listed.drafts.find((row) => row.id === "rfq-photo").images, [{ index: 0, label: "买家图片" }]);
    const detail = await (await fetch(service.url + "api/quote?draft=rfq-photo")).json();
    assert.equal(detail.quote.status, "needs_review");
    assert.deepEqual(detail.images, [{ index: 0, label: "买家图片" }]);
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("price approval API requires same-origin action and creates a local-only quote", async () => {
  const root = temporary(); seed(root);
  const service = await createCaseServer({ resources, workspace: root, spawnProcess: () => assert.fail("price approval must not launch browser or model") });
  try {
    const directory = path.join(root, "data/drafts");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "draft-price.json");
    fs.writeFileSync(file, JSON.stringify({ rfq: { id: "rfq-price", title: "Kraft bag", quantity: 1000 },
      analysis: { categoryId: "paper_shopping_bag", fields: { quantity: 1000 }, recommendation: "review", buyerQuestions: [] },
      quote: { status: "needs_review" }, submission: { status: "skipped" } }));
    const payload = { id: "draft-price", rfqId: "rfq-price", reviewHash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      unitPriceUsd: 0.25, validThrough: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      sourceNote: "Current supplier sell price confirmed by operator", specification: "Kraft paper bag, 1000 pieces, EXW; buyer specifications must be checked.", approved: true };
    const post = (origin) => fetch(service.url + "api/quotes/approve-price", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Case-Console": "1", Origin: origin }, body: JSON.stringify(payload) });
    assert.equal((await post("https://attacker.example")).status, 403);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).quote.status, "needs_review");
    service.console.runJson = async (script) => { assert.equal(script, "scripts/build_case_catalog.mjs"); return {}; };
    const response = await post(new URL(service.url).origin);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).browserAction, "none");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).quote.totalUsd, 250);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("quote example reads a local case when available and falls back to the bundled redacted scan", async () => {
  const root = temporary(); seed(root);
  const service = await createCaseServer({ resources, workspace: root,
    spawnProcess: () => assert.fail("case preview must not start a browser or process") });
  try {
    const fallback = await (await fetch(service.url + "api/quote/example")).json();
    assert.equal(fallback.source, "bundled_redacted");
    assert.equal(fallback.detail.quote.status, "conditional_quote");
    assert.equal(fallback.detail.quote.totalUsd, 495);
    assert.equal(fallback.detail.submission.status, "skipped");
    assert.equal(fallback.detail.rfq.detailUrl, undefined);
    assert.equal(fs.existsSync(path.join(root, "data/drafts")), false);

    const drafts = path.join(root, "data/drafts");
    fs.mkdirSync(drafts);
    fs.writeFileSync(path.join(drafts, "real-rfq.json"), JSON.stringify({
      createdAt: "2026-09-20T00:00:00Z",
      rfq: { id: "real-rfq", title: "Real RFQ", detailText: "Buyer asks for cartons",
        detailUrl: "https://sourcing.alibaba.com/rfq_detail.htm?p=real-rfq" },
      analysis: { categoryId: "corrugated_rsc", recommendation: "quote" },
      quote: { status: "quoted", currency: "USD", quantity: 100, unitPriceUsd: 2, totalUsd: 200 },
      draft: { productName: "Cartons", buyerMessage: "Our quote is USD 200" },
      submission: { status: "not_submitted" }, privateField: "must not leave workspace"
    }));
    const local = await (await fetch(service.url + "api/quote/example")).json();
    assert.equal(local.source, "local_scan");
    assert.equal(local.detail.id, "real-rfq");
    assert.equal(local.detail.rfq.detailText, "Buyer asks for cartons");
    assert.equal(local.detail.rfq.detailUrl, "https://sourcing.alibaba.com/rfq_detail.htm?p=real-rfq");
    assert.equal(local.detail.quote.totalUsd, 200);
    assert.equal(JSON.stringify(local).includes("must not leave workspace"), false);
    assert.deepEqual(fs.readdirSync(drafts), ["real-rfq.json"]);
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("test and real opportunity remain visible in workbench notification history", async () => {
  const root = temporary(); seed(root);
  const service = await createCaseServer({ resources, workspace: root, desktop: true,
    notify: async () => ({ status: "accepted", detail: "system accepted, banner unknown" }),
    spawnProcess: () => assert.fail("notification must not start browser tasks") });
  try {
    service.console.updateSettings({ notificationsEnabled: true });
    const headers = { "Content-Type": "application/json", "X-Case-Console": "1", Origin: new URL(service.url).origin };
    const testResponse = await fetch(service.url + "api/notifications/test", { method: "POST", headers, body: "{}" });
    assert.equal(testResponse.status, 200);
    const testSnapshot = await (await fetch(service.url + "api/ops/status")).json();
    assert.equal(testSnapshot.notifications.events[0].kind, "test");
    const record = { rfq: { id: "rfq-alert", title: "纸箱", remainingQuotes: 2, quoteUrl: "https://sourcing.alibaba.com/rfq/quote" },
      quote: { status: "quoted", currency: "USD", quantity: 1000, unitPriceUsd: 1, totalUsd: 1000, setupUsd: 0 },
      draft: { port: "Verified", productName: "Carton", productDetails: "B flute", buyerMessage: "Review" },
      analysis: { recommendation: "quote", confidence: 0.99, missingRequired: [], riskFlags: [] }, submission: { status: "skipped" } };
    assert.equal((await notifyOpportunity(record, {}, { file: service.console.settingsFile, send: async () => ({ status: "accepted" }) })).status, "accepted");
    const snapshot = await (await fetch(service.url + "api/ops/status")).json();
    assert.equal(snapshot.notifications.events.find((event) => event.draftId === "rfq-alert").message.includes("纸箱"), true);
    assert.equal(snapshot.notifications.events.some((event) => event.kind === "test"), true);
    assert.equal(snapshot.notifications.events.find((event) => event.draftId === "rfq-alert").id, "opportunity:rfq-alert");
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("an old attention banner is labeled as an RFQ-page check, not current account state", () => {
  const root = temporary(); seed(root);
  try {
    const dir = path.join(root, "data/case-catalog/ops");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "last-run.json"), JSON.stringify({ id: "oldrun", kind: "once", status: "attention", alert: "登录、验证码或连接需要人工处理" }));
    fs.writeFileSync(path.join(dir, "oldrun.log"), "Error: Alibaba login is required in the selected browser session.\n");
    const console = new OperatorConsole({ resources, workspace: root });
    assert.match(console.snapshot().run.alert, /RFQ 页面遇到登录提示/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("console requires saved model and respects scan/quote authorization and concurrency", () => {
  const root = temporary(); seed(root);
  try {
    // 旧版本可能把总开关保存为 false；升级后所有工作台都忽略这个
    // 废弃字段。启动任务仍须点击，逐单报价仍须单独确认。
    fs.mkdirSync(path.join(root, "data/case-catalog/ops"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/case-catalog/ops/settings.json"), JSON.stringify({ browserEnabled: false }));
    const c = new OperatorConsole({ resources, workspace: root, desktop: true, spawnProcess: () => assert.fail("must not run") });
    const request = { kind: "once", term: c.searchTerms[0], recentMinutes: 60 };
    assert.equal(c.settings.browserEnabled, true);
    assert.throws(() => c.start(request), /API Key/);
    c.probe = {}; assert.throws(() => c.start(request), /环境检测/); c.probe = null;
    c.quotePreparing = true; assert.throws(() => c.start(request), /已有任务/); c.quotePreparing = false;
    c.updateSettings({ quoteEnabled: true });
    assert.throws(() => c.updateSettings({ browserEnabled: false }), /默认可用/);
    c.updateSettings({ quoteEnabled: false }); assert.equal(c.settings.quoteEnabled, false);
    assert.equal(new OperatorConsole({ resources, workspace: root, desktop: true }).settings.browserEnabled, true);
    const restored = new OperatorConsole({ resources, workspace: root });
    assert.equal(restored.settings.browserEnabled, true); assert.equal(restored.settings.quoteEnabled, false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("manual quote permission is scoped to an approved single-RFQ launch", async () => {
  const root = temporary(); seed(root);
  try {
    const c = new OperatorConsole({ resources, workspace: root, desktop: true });
    c.settings.quoteEnabled = true;
    c.reviewQuote = async () => ({ archivedAt: null, reviewHash: "current-hash", rfq: { id: "rfq-reviewed" },
      quote: { categoryId: "paper_shopping_bag" }, draft: { port: "Hangzhou" }, fillEligible: true, submitEligible: true });
    c.launch = (_task, _script, _args, extra) => extra;
    assert.equal(c.env().RFQ_MANUAL_OPERATOR_QUOTE, "0");
    const base = { draftId: "draft-reviewed", reviewHash: "current-hash", confirmation: "rfq-reviewed", approved: true };
    assert.equal((await c.startQuote({ ...base, kind: "fill" })).RFQ_MANUAL_OPERATOR_QUOTE, "1");
    const submit = await c.startQuote({ ...base, kind: "submit" });
    assert.equal(submit.RFQ_MANUAL_OPERATOR_QUOTE, "1");
    assert.equal(submit.AUTO_CONTACT_MODE, "submit");
    await assert.rejects(() => c.startQuote({ ...base, confirmation: "other", kind: "fill" }), /RFQ ID/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("HTTP model adapter returns final JSON only, rejects truncation and does not echo credentials", async () => {
  const config = { modelApiKey: "fixture-key", modelApiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", modelName: "glm-4.7" };
  const result = await callModelHttp(config, "JSON only", { fixture: true }, 100, { request: async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-key"); assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).thinking.type, "disabled");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}', reasoning_content: "private scratchpad" } }] });
  } });
  assert.deepEqual(result, { ok: true });
  await callModelHttp({ ...config, modelApiUrl: "https://api.z.ai/api/paas/v4/chat/completions" }, "JSON only", {}, 256, { request: async (_url, options) => {
    assert.equal(JSON.parse(options.body).thinking.type, "disabled");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] });
  } });
  await assert.rejects(() => callModelHttp(config, "", {}, 100, { request: async () => new Response(config.modelApiKey, { status: 401 }) }), /HTTP 401/);
  await assert.rejects(() => callModelHttp(config, "", {}, 100, { request: async () => Response.json({ choices: [{ finish_reason: "length" }] }) }), /截断/);
});
test("case import relocates image paths, preserves buyer text, rejects conflicts and never imports permissions", () => {
  const source = temporary(), destination = temporary();
  try {
    fs.mkdirSync(path.join(source, "rfqs/fixture/images"), { recursive: true }); fs.mkdirSync(path.join(source, "drafts"));
    const image = path.join(source, "rfqs/fixture/images/product.png"); fs.writeFileSync(image, "fixture");
    const original = { rfq: { id: "fixture", imagePaths: [image.replace(source, "/old/project/data")], detailText: "Buyer text /data/ must remain unchanged" } };
    fs.writeFileSync(path.join(source, "drafts/fixture.json"), JSON.stringify(original));
    fs.mkdirSync(path.join(source, "case-catalog/ops"), { recursive: true }); fs.writeFileSync(path.join(source, "case-catalog/ops/settings.json"), '{"quoteEnabled":true}');
    assert.equal(importCaseData(source, destination).importedFiles, 2);
    const imported = JSON.parse(fs.readFileSync(path.join(destination, "data/drafts/fixture.json")));
    assert.equal(imported.rfq.imagePaths[0], path.join(destination, "data/rfqs/fixture/images/product.png"));
    assert.equal(imported.rfq.detailText, original.rfq.detailText);
    assert.equal(fs.existsSync(path.join(destination, "data/case-catalog/ops/settings.json")), false);
    assert.equal(importCaseData(source, destination).importedFiles, 0);
    fs.writeFileSync(path.join(source, "rfqs/fixture/images/product.png"), "conflict");
    assert.throws(() => importCaseData(source, destination), /未覆盖/);
    assert.equal(fs.readFileSync(path.join(destination, "data/rfqs/fixture/images/product.png"), "utf8"), "fixture");
  } finally { fs.rmSync(source, { recursive: true }); fs.rmSync(destination, { recursive: true }); }
});
test("stopping an owned task escalates a stubborn process and records stopped state", { skip: process.platform === "win32" }, async () => {
  const root = temporary(), fakeResources = temporary(); seed(root);
  fs.mkdirSync(path.join(fakeResources, "src")); fs.mkdirSync(path.join(fakeResources, "scripts"));
  fs.writeFileSync(path.join(fakeResources, "src/cli.js"), 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);');
  fs.writeFileSync(path.join(fakeResources, "scripts/build_case_catalog.mjs"), 'console.log(JSON.stringify({ok:true}));');
  const c = new OperatorConsole({ resources: fakeResources, workspace: root });
  try {
    c.start({ kind: "watch", term: c.searchTerms[0], recentMinutes: 60 });
    const pid = c.process.pid;
    for (let i = 0; i < 40 && !c.tail().includes("ready"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(c.tail(), /ready/); c.stop();
    assert.equal(c.current.status, "stopping");
    for (let i = 0; i < 140 && c.current; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(c.current, null); assert.equal(c.last.status, "stopped");
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await c.close(); fs.rmSync(root, { recursive: true }); fs.rmSync(fakeResources, { recursive: true }); }
});
