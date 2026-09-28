import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCaseServer } from "../desktop/server.js";
import { DesktopSettings } from "../desktop/settings.js";
import { OperatorConsole } from "../desktop/console.js";
import { callModelHttp } from "../src/model-http.js";
import { importCaseData } from "../desktop/import-data.js";
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
test("desktop HTTP retains local authorization and evidence allowlist, never probes Chrome when disabled", async () => {
  const root = temporary(); seed(root);
  const service = await createCaseServer({ resources, workspace: root, spawnProcess: () => assert.fail("browser/process must not run") });
  try {
    const get = async (route) => fetch(service.url + route);
    assert.equal((await (await get("api/catalog")).json()).counts.cases, 0);
    assert.equal((await (await get("api/env/check?force=1")).json()).status, "skipped");
    assert.equal((await get("api/extension")).status, 200);
    const post = (origin, payload) => fetch(service.url + "api/ops/settings", { method: "POST", headers: { "Content-Type": "application/json", "X-Case-Console": "1", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload) });
    assert.equal((await post("https://attacker.example", { browserEnabled: true })).status, 403);
    assert.equal((await post(null, { browserEnabled: true })).status, 403);
    assert.equal((await post(new URL(service.url).origin, { quoteEnabled: true })).status, 409);
    assert.equal((await post(new URL(service.url).origin, { alertsEnabled: false })).status, 200);
    assert.equal((await get("api/image?case=../../.env&index=0")).status, 404);
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("console requires saved model and respects scan/quote authorization and concurrency", () => {
  const root = temporary(); seed(root);
  try {
    const c = new OperatorConsole({ resources, workspace: root, desktop: true, spawnProcess: () => assert.fail("must not run") });
    const request = { kind: "once", term: c.searchTerms[0], limit: 1 };
    assert.throws(() => c.start(request), /浏览器/);
    c.updateSettings({ browserEnabled: true }); assert.throws(() => c.start(request), /API Key/);
    c.probe = {}; assert.throws(() => c.start(request), /环境检测/); c.probe = null;
    c.quotePreparing = true; assert.throws(() => c.start(request), /已有任务/); c.quotePreparing = false;
    c.updateSettings({ quoteEnabled: true }); c.updateSettings({ browserEnabled: false }); assert.equal(c.settings.quoteEnabled, false);
    const restored = new OperatorConsole({ resources, workspace: root }); assert.equal(restored.settings.quoteEnabled, false);
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
    c.updateSettings({ browserEnabled: true });
    c.start({ kind: "watch", term: c.searchTerms[0], limit: 1 });
    const pid = c.process.pid;
    for (let i = 0; i < 40 && !c.tail().includes("ready"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(c.tail(), /ready/); c.updateSettings({ browserEnabled: false });
    assert.equal(c.current.status, "stopping");
    for (let i = 0; i < 140 && c.current; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(c.current, null); assert.equal(c.last.status, "stopped");
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await c.close(); fs.rmSync(root, { recursive: true }); fs.rmSync(fakeResources, { recursive: true }); }
});
