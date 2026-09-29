import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import AdmZip from "adm-zip";
import { DesktopSettings } from "../src/desktop/settings.js";
import { resolveGlmCredential } from "../src/glm-credentials.js";
import { pickModelEnvironment, resolveEnvironmentModel, readModelEnvironment, findLocalClaudeExecutable } from "../src/desktop/model-environment.js";
import { parseAlibabaLoginFile, importAlibabaCookies } from "../src/desktop/browser-import.js";
import { callAnthropicHttp } from "../src/claude.js";
import { createCaseServer } from "../src/desktop/server.js";
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "rfq-migration-test-"));
const cipher = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v).map(x => x ^ 0x55), decryptString: (v) => Buffer.from(v).map(x => x ^ 0x55).toString() };
const localEnvironment = { variables: { ANTHROPIC_AUTH_TOKEN: "synthetic-env-key", ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_MODEL: "glm-fixture" }, source: "测试环境变量" };
test("model environment keeps the endpoint paired with its key, excludes operational permissions", () => {
  const model = resolveEnvironmentModel(localEnvironment.variables);
  assert.equal(model.modelApiUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(model.agentProvider, "anthropic-http");
  assert.equal(resolveEnvironmentModel({ ANTHROPIC_AUTH_TOKEN: "unpaired" }), null);
  assert.deepEqual(pickModelEnvironment({ GLM_API_KEY: "fixture", ALLOW_LIVE_SUBMIT: "true", RFQ_BROWSER_TOKEN: "private", AUTO_CONTACT_MODE: "on" }), { GLM_API_KEY: "fixture" });
  assert.equal(resolveEnvironmentModel({ GLM_API_KEY: "fixture" }).modelApiUrl, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(resolveEnvironmentModel({ ZAI_APIKEY: "fixture" }).modelApiUrl, "https://api.z.ai/api/paas/v4/chat/completions");
  assert.equal(resolveEnvironmentModel({ ZAI_APIKEY: "fixture" }).modelName, "glm-5.3");
  for (const base of ["http://example.test", "https://key@example.test", "https://example.test?key=private", "https://example.test/#key"]) assert.throws(() => resolveEnvironmentModel({ GLM_API_KEY: "fixture", GLM_BASE_URL: base }), /HTTPS/);
  assert.equal(resolveGlmCredential({ ZAI_APIKEY: "fixture" }).origin, "https://api.z.ai");
  assert.equal(resolveGlmCredential(localEnvironment.variables).keyVariable, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(resolveGlmCredential({ ANTHROPIC_AUTH_TOKEN: "fixture", ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), null);
  assert.equal(resolveGlmCredential({ MODEL_API_KEY: "fixture", MODEL_API_URL: "https://proxy.example/v1/chat/completions" }), null);
  assert.equal(resolveGlmCredential({ ZAI_APIKEY: "fixture", ZAI_BASE_URL: "https://proxy.example/v4" }), null);
});
test("desktop defaults to cloud Claude and explicitly keeps local Claude and GLM HTTP", () => {
  const root = temporary(), fallbackRoot = temporary();
  try {
    assert.equal(findLocalClaudeExecutable({ LOCAL_CLAUDE_EXECUTABLE: process.execPath }), process.execPath);
    const local = new DesktopSettings(root, cipher, { localEnvironment: { variables: { ...localEnvironment.variables,
      LOCAL_CLAUDE_EXECUTABLE: process.execPath }, source: "fixture" }, detectClaude: e => e.LOCAL_CLAUDE_EXECUTABLE });
    assert.equal(local.info().agentProvider, "cloud-claude"); assert.equal(local.info().modelName, "glm-5.3");
    assert.equal(local.info().modelReady, false); assert.equal(local.environment().MODEL_API_KEY, "");
    local.save({ modelConfigSource: "manual", agentProvider: "local-claude-sdk", ocrProvider: "glm-ocr",
      ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" });
    assert.equal(local.info().modelReady, true);
    assert.equal(local.environment().LOCAL_CLAUDE_MODEL, "glm-5.3");
    assert.equal(local.environment().LOCAL_CLAUDE_SETTING_SOURCES, "none");
    assert.equal(local.environment().ANTHROPIC_AUTH_TOKEN, "synthetic-env-key");
    assert.ok(!JSON.stringify(local.info()).includes("synthetic-env-key"));
    local.save({ agentProvider: "openai-http", modelApiKey: "synthetic-http-key" });
    assert.equal(local.environment().AGENT_PROVIDER, "openai-http"); assert.equal(local.environment().MODEL_API_KEY, "synthetic-http-key");
    const unavailable = new DesktopSettings(fallbackRoot, cipher, { localEnvironment: { variables: { GLM_API_KEY: "synthetic-fallback" }, source: "fixture" }, detectClaude: () => "" });
    assert.equal(unavailable.environment().AGENT_PROVIDER, "cloud-claude"); assert.equal(unavailable.info().modelName, "glm-5.3");
  } finally { fs.rmSync(root, { recursive: true }); fs.rmSync(fallbackRoot, { recursive: true }); }
});
test("local Claude connection test uses the app-selected executable without exposing credentials", async () => {
  const root = temporary(); fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{}}');
  const settings = new DesktopSettings(root, cipher, { localEnvironment: { variables: { LOCAL_CLAUDE_EXECUTABLE: process.execPath }, source: "fixture" },
    detectClaude: () => process.execPath });
  settings.save({ modelConfigSource: "manual", agentProvider: "local-claude-sdk" });
  let calls = 0;
  const service = await createCaseServer({ resources: path.resolve("."), workspace: root, desktop: true, desktopSettings: settings,
    environment: () => settings.environment(), testLocalClaude: async env => {
    calls++; assert.equal(env.LOCAL_CLAUDE_EXECUTABLE, process.execPath); assert.equal(env.AGENT_PROVIDER, "local-claude-sdk"); return { ok: true };
  } });
  try {
    const post = () => fetch(service.url + "api/desktop/model/test", { method: "POST", headers: { Origin: new URL(service.url).origin,
      "X-Case-Console": "1", "Content-Type": "application/json" }, body: "{}" });
    const modelBefore = (await fetch(service.url + "api/env/check").then(r => r.json())).checks.find(c => c.key === "model");
    assert.equal(modelBefore.state, "已配置 · 待检测"); assert.equal(calls, 0);
    assert.equal((await post()).status, 200); assert.equal(calls, 1);
    const modelAfter = (await fetch(service.url + "api/env/check").then(r => r.json())).checks.find(c => c.key === "model");
    assert.equal(modelAfter.state, "实测可用"); assert.equal(modelAfter.ok, true);
    settings.save({ modelName: "changed-model" });
    assert.equal((await fetch(service.url + "api/env/check").then(r => r.json())).checks.find(c => c.key === "model").state, "已配置 · 待检测");
    assert.equal((await fetch(service.url + "api/desktop/info").then(r => r.json())).settings.modelReady, true);
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("OCR probe recognizes a fixed sample and invalidates success when the key changes", async () => {
  const root = temporary(); fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{}}');
  const settings = new DesktopSettings(root, cipher, { localEnvironment: { variables: { GLM_OCR_API_KEY: "synthetic-ocr-key" }, source: "fixture" }, detectClaude: () => "" });
  settings.save({ ocrProvider: "glm-ocr", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" });
  let response = { status: "read", text: "RFQ 123" }, calls = 0;
  const service = await createCaseServer({ resources: path.resolve("."), workspace: root, desktop: true, desktopSettings: settings,
    environment: () => settings.environment(), testOcr: async () => { calls++; return response; } });
  const check = async () => (await fetch(service.url + "api/env/check").then(r => r.json())).checks.find(c => c.key === "ocr");
  const post = () => fetch(service.url + "api/desktop/ocr/test", { method: "POST", headers: { Origin: new URL(service.url).origin,
    "X-Case-Console": "1", "Content-Type": "application/json" }, body: "{}" });
  try {
    assert.equal((await check()).state, "已配置 · 待检测"); assert.equal(calls, 0);
    assert.equal((await post()).status, 200); assert.equal((await check()).state, "实测可用");
    response = { status: "empty", text: "" };
    assert.equal((await post()).status, 409); assert.equal((await check()).state, "检测失败");
    settings.save({ ocrApiKey: "changed-synthetic-key" });
    assert.equal((await check()).state, "已配置 · 待检测");
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("auto uses local GLM without storing its key; manual and explicit environment selection remain predictable", async () => {
  const root = temporary();
  try {
    const settings = new DesktopSettings(root, cipher, { localEnvironment, reloadEnvironment: async () => ({ variables: {}, source: "测试空环境" }) });
    settings.save({ agentProvider: "anthropic-http", modelApiUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
      ocrProvider: "glm-ocr", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" });
    assert.equal(settings.environment().MODEL_API_KEY, "synthetic-env-key");
    assert.equal(settings.environment().ANTHROPIC_API_URL, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(settings.info().effectiveModelSource, "environment");
    settings.save({ quotePort: "Shanghai" });
    assert.ok(!fs.readFileSync(settings.file, "utf8").includes("synthetic-env-key"));
    assert.ok(!JSON.stringify(settings.info()).includes("synthetic-env-key"));
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-env-key");
    assert.equal(settings.info().ocrKeySource, "environment-model");
    settings.save({ modelApiKey: "synthetic-manual-key" });
    assert.equal(settings.environment().MODEL_API_KEY, "synthetic-manual-key");
    settings.save({ modelConfigSource: "environment" });
    assert.equal(settings.environment().MODEL_API_KEY, "synthetic-env-key");
    await settings.refreshEnvironment();
    assert.equal(settings.info().modelKeyConfigured, false);
    settings.save({ modelConfigSource: "manual" });
    assert.equal(settings.environment().MODEL_API_KEY, "synthetic-manual-key");
    settings.save({ agentProvider: "anthropic-http", modelApiUrl: "https://another-provider.example/v1/messages" });
    assert.equal(settings.info().modelKeyConfigured, false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("OCR reuses an official GLM key with matching endpoint and keeps explicit OCR credentials first", () => {
  const root = temporary();
  try {
    const settings = new DesktopSettings(root, cipher, { localEnvironment: { variables: { ZAI_APIKEY: "synthetic-zai-key",
      GLM_OCR_API_URL: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" }, source: "fixture" }, detectClaude: () => "" });
    settings.save({ ocrProvider: "glm-ocr", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" });
    assert.equal(settings.info().ocrKeyConfigured, true);
    assert.equal(settings.info().ocrKeyVariable, "ZAI_APIKEY");
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-zai-key");
    assert.equal(settings.environment().GLM_OCR_API_URL, "https://api.z.ai/api/paas/v4/layout_parsing");
    assert.ok(!JSON.stringify(settings.info()).includes("synthetic-zai-key"));
    assert.ok(!fs.readFileSync(settings.file, "utf8").includes("synthetic-zai-key"));

    settings.save({ modelConfigSource: "manual", agentProvider: "openai-http",
      modelApiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", modelApiKey: "synthetic-model-key" });
    assert.equal(settings.info().ocrKeySource, "saved-model");
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-model-key");
    settings.save({ ocrApiKey: "synthetic-ocr-key" });
    assert.equal(settings.info().ocrKeySource, "saved-ocr");
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-ocr-key");
    assert.equal(settings.environment().GLM_OCR_API_URL, "https://open.bigmodel.cn/api/paas/v4/layout_parsing");
    settings.save({ clearSecrets: ["ocrApiKey"] });
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-model-key");
    assert.ok(!fs.readFileSync(settings.file, "utf8").includes("synthetic-zai-key"));

    settings.save({ clearSecrets: ["modelApiKey"], ocrApiUrl: "https://other.example/layout_parsing" });
    assert.equal(settings.info().ocrKeySource, "endpoint-mismatch");
    assert.equal(settings.environment().GLM_OCR_API_KEY, "");
    settings.save({ ocrApiUrl: "https://api.z.ai/api/paas/v4/layout_parsing" });
    assert.equal(settings.environment().GLM_OCR_API_KEY, "synthetic-zai-key");
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("OCR does not reuse a non-Zhipu model key", () => {
  const root = temporary();
  try {
    const settings = new DesktopSettings(root, cipher, { localEnvironment: { variables: { MODEL_API_KEY: "synthetic-proxy-key", MODEL_API_URL: "https://proxy.example/v1/chat/completions" }, source: "fixture" }, detectClaude: () => "" });
    assert.equal(settings.info().ocrKeyConfigured, false);
    settings.save({ modelConfigSource: "manual", agentProvider: "openai-http", modelApiUrl: "https://proxy.example/v1/chat/completions", modelApiKey: "synthetic-saved-proxy-key" });
    assert.equal(settings.environment().GLM_OCR_API_KEY, "");
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("Finder fallback reads only Claude env, and shell failures never expose stdout or stderr", async () => {
  const root = temporary(), file = path.join(root, "settings.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ env: { ...localEnvironment.variables, ALLOW_LIVE_SUBMIT: "true" }, hooks: { dangerous: "must never run" } }));
    const configured = await readModelEnvironment({ env: {}, claudeSettingsFile: file, run: () => assert.fail("existing env should avoid shell") });
    assert.equal(configured.source, "Claude Code 本机 env 配置");
    assert.equal(configured.variables.ALLOW_LIVE_SUBMIT, undefined);
    const inherited = await readModelEnvironment({ env: { GLM_API_KEY: "synthetic-inherited-key" }, claudeSettingsFile: file });
    assert.equal(inherited.source, "进程环境变量");
    assert.equal(inherited.claudeVariables.ANTHROPIC_AUTH_TOKEN, "synthetic-env-key");
    const withInheritedKey = new DesktopSettings(root, cipher, { localEnvironment: { ...inherited,
      variables: { ...inherited.variables, LOCAL_CLAUDE_EXECUTABLE: process.execPath } }, detectClaude: () => process.execPath });
    withInheritedKey.save({ modelConfigSource: "manual", agentProvider: "local-claude-sdk" });
    assert.equal(withInheritedKey.environment().ANTHROPIC_AUTH_TOKEN, "synthetic-env-key");
    assert.equal(withInheritedKey.environment().LOCAL_CLAUDE_MODEL, "glm-5.3");
    const missing = path.join(root, "missing");
    const shell = await readModelEnvironment({ env: {}, platform: "darwin", executable: "/a b/Node's app", claudeSettingsFile: missing, run: (exe, args, opts, cb) => {
      assert.equal(exe, "/bin/zsh"); assert.equal(opts.timeout, 8000);
      assert.ok(!args.join(" ").includes("synthetic-shell-key"));
      cb(null, `banner\n__RFQ_MODEL_ENV__${Buffer.from(JSON.stringify({ GLM_API_KEY: "synthetic-shell-key", AUTO_CONTACT_MODE: "on" })).toString("base64")}__RFQ_ENV_END__`);
    } });
    assert.equal(shell.variables.GLM_API_KEY, "synthetic-shell-key"); assert.equal(shell.variables.AUTO_CONTACT_MODE, undefined);
    const failed = await readModelEnvironment({ env: {}, claudeSettingsFile: missing, run: (_exe, _args, _opts, cb) => cb(new Error("private fixture key"), "private stdout", "private stderr") });
    assert.ok(!JSON.stringify(failed).includes("private")); assert.ok(failed.error);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test("GLM Anthropic HTTP uses the chosen compatible endpoint, rejects truncation and ignores reasoning", async () => {
  const config = { anthropicApiKey: "synthetic-api-key", anthropicModel: "glm-fixture", anthropicApiUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages" };
  const result = await callAnthropicHttp(config, "fixed", { test: true }, 64, { request: async (url, options) => {
    assert.equal(url, config.anthropicApiUrl); assert.equal(options.headers["x-api-key"], config.anthropicApiKey); assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).thinking.type, "disabled");
    return Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: '{"ok":true}' }] });
  } });
  assert.deepEqual(result, { ok: true });
  await assert.rejects(callAnthropicHttp(config, "", {}, 64, { request: async () => Response.json({ stop_reason: "max_tokens" }) }), /截断/);
  await assert.rejects(callAnthropicHttp(config, "", {}, 64, { request: async () => new Response("private key", { status: 401 }) }), /HTTP 401/);
  await assert.rejects(callAnthropicHttp({ ...config, anthropicApiUrl: "https://key@example.test/v1/messages" }, "", {}, 64, { request: () => assert.fail("must not send credentials") }), /HTTPS/);
});
const cookie = (changes = {}) => ({ domain: ".alibaba.com", name: "synthetic-login", value: "synthetic-cookie-value", path: "/", secure: true, httpOnly: true, sameSite: "lax", ...changes });
test("Cookie parsing filters scope and expiry, preserves host-only cookies, validates all before writing", () => {
  const prepared = parseAlibabaLoginFile(JSON.stringify({ cookies: [cookie(), cookie({ domain: "other.example" }), cookie({ name: "expired", expires: 50 }), cookie({ name: "partitioned", partitionKey: { topLevelSite: "https://alibaba.com" } }), cookie({ domain: "passport.alibaba.com", name: "__Host-test", expires: -1 })] }), 100);
  assert.equal(prepared.cookies.length, 2); assert.equal(prepared.ignored, 1); assert.equal(prepared.expired, 1); assert.equal(prepared.unsupported, 1);
  assert.equal(prepared.cookies[0].domain, ".alibaba.com"); assert.equal(prepared.cookies[1].domain, undefined); assert.equal(prepared.cookies[1].expirationDate, undefined);
  for (const invalid of [cookie({ domain: "-a.alibaba.com" }), cookie({ name: "bad=name" }), cookie({ path: false }), cookie({ secure: "true" }), cookie({ expires: "tomorrow" }), cookie({ sameSite: "None", secure: false }), cookie({ name: "__Host-invalid", hostOnly: false })]) assert.throws(() => parseAlibabaLoginFile(JSON.stringify([cookie(), invalid])), /记录|重复/);
  assert.throws(() => parseAlibabaLoginFile(JSON.stringify([cookie(), cookie()])), /重复/);
  assert.throws(() => parseAlibabaLoginFile(JSON.stringify([cookie({ domain: "alibaba.com.attacker.test" })])), /没有/);
  assert.throws(() => parseAlibabaLoginFile("private-non-json"), /JSON/);
  assert.throws(() => parseAlibabaLoginFile(" ".repeat(1024 * 1024 + 1)), /1 MB/);
});
test("import failure restores the owned session and never returns cookie values", async () => {
  const old = cookie({ name: "old", session: true, hostOnly: false }), prepared = parseAlibabaLoginFile(JSON.stringify([cookie()]));
  let stored = [old], failOnce = true;
  const session = { clearStorageData: async () => { stored = []; }, cookies: { get: async (query) => { assert.deepEqual(query, {}); return stored; }, set: async (value) => {
    if (failOnce && value.name === "synthetic-login") { failOnce = false; throw new Error(value.value); } stored.push(value);
  }, flushStore: async () => {} } };
  await assert.rejects(importAlibabaCookies(session, prepared), error => /已恢复/.test(error.message) && !error.message.includes("synthetic-cookie-value"));
  assert.equal(stored[0].name, "old");
  const result = await importAlibabaCookies(session, prepared);
  assert.equal(result.imported, 1); assert.equal(stored[0].name, "synthetic-login"); assert.ok(!JSON.stringify(result).includes("synthetic-cookie-value"));
  session.cookies.get = async () => { throw new Error("synthetic-cookie-value"); };
  await assert.rejects(importAlibabaCookies(session, prepared), error => /无法读取/.test(error.message) && !error.message.includes("synthetic-cookie-value"));
});
test("local import endpoint accepts only user UI initiation and bundle contains an Alibaba-only export extension", async () => {
  const root = temporary(); fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true }); fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{}}');
  let imports = 0;
  const service = await createCaseServer({ resources: path.resolve("."), workspace: root, embeddedBrowser: { info: () => ({}) }, importBrowserLogin: async () => { imports++; return { canceled: true }; } });
  try {
    const post = (payload, origin = new URL(service.url).origin, header = true) => fetch(service.url + "api/desktop/browser/import", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(header ? { "X-Case-Console": "1" } : {}) }, body: JSON.stringify(payload) });
    assert.equal((await post({}, "https://attacker.test")).status, 403);
    assert.equal((await post({}, undefined, false)).status, 403);
    assert.equal((await post({ path: "/private/file" })).status, 409);
    assert.equal((await post({ cookies: [cookie()] })).status, 409);
    service.console.browserImporting = true; assert.equal((await post({})).status, 409); service.console.browserImporting = false;
    assert.equal((await post({})).status, 200); assert.equal(imports, 1);
    const zip = new AdmZip(Buffer.from(await (await fetch(service.url + "api/desktop/browser/export-tool")).arrayBuffer()));
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    assert.deepEqual(manifest.permissions, ["cookies"]); assert.ok(manifest.host_permissions.every(x => x.includes("alibaba.com"))); assert.ok(!manifest.background);
    assert.ok(zip.getEntry("popup.js"));
  } finally { await service.close(); fs.rmSync(root, { recursive: true }); }
});
test("export helper reads cookies only on click, creates a local file and redacts failures", async () => {
  let handler, calls = 0, clicked = 0, blob;
  const button = { addEventListener: (_name, fn) => { handler = fn; } }, status = {};
  const context = { document: { querySelector: selector => selector === "#export" ? button : status, createElement: () => ({ click() { clicked++; } }) }, chrome: { cookies: { getAll: async (query) => { calls++; assert.deepEqual(JSON.parse(JSON.stringify(query)), {}); return [cookie(), cookie({ domain: "other.example" })]; } } }, Blob, URL: { createObjectURL: value => { blob = value; return "blob:fixture"; }, revokeObjectURL() {} }, setTimeout: () => {} };
  vm.runInNewContext(fs.readFileSync("plugins/alibaba-login-export/popup.js", "utf8"), context);
  assert.equal(calls, 0); await handler(); assert.equal(calls, 1); assert.equal(clicked, 1);
  assert.equal(JSON.parse(await blob.text()).cookies.length, 1); assert.equal(JSON.parse(await blob.text()).cookies[0].name, "synthetic-login"); assert.ok(!status.textContent.includes("synthetic-cookie-value"));
  context.chrome.cookies.getAll = async () => { throw new Error("private key"); }; await handler(); assert.ok(!status.textContent.includes("private")); assert.equal(button.disabled, false);
});
