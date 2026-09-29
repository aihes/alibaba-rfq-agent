import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runCloudAgentJson, cloudEndpoint } from "../src/cloud-agent.js";
import { buildClassificationRequest } from "../src/claude.js";
import { DesktopSettings } from "../src/desktop/settings.js";
import { createCaseServer } from "../src/desktop/server.js";

const cipher = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v).map(x => x ^ 0x55),
  decryptString: v => Buffer.from(v).map(x => x ^ 0x55).toString() };

test("cloud Claude sends the unchanged prompt and original image bytes to the authorized endpoint", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-cloud-test-"));
  const file = path.join(directory, "photo.webp");
  fs.writeFileSync(file, await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).webp().toBuffer());
  const prompt = "Return JSON only. RFQ 123";
  try {
    let calls = 0;
    const result = await runCloudAgentJson({ cloudAgentToken: "test-only-client-token", cloudAgentUrl: "https://glm.knowflow.work/v1/agent" },
      { prompt, imagePaths: [file], phase: "classification" }, { request: async (url, options) => {
        calls++;
        assert.equal(url, "https://glm.knowflow.work/v1/agent");
        assert.equal(options.headers.Authorization, "Bearer test-only-client-token");
        const body = JSON.parse(options.body);
        assert.equal(body.query, prompt);
        assert.equal(body.images.length, 1);
        assert.equal(body.images[0].mime_type, "image/jpeg");
        assert.ok(Buffer.from(body.images[0].data, "base64").subarray(0, 3).equals(Buffer.from([255, 216, 255])));
        assert.equal(body.session_id, undefined);
        return Response.json({ ok: true, answer: '{"ok":true}', model: "glm-5.3-flash", session_id: "fixture" });
      } });
    assert.equal(calls, 1);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(result.meta.provider, "cloud-claude");
    assert.equal(result.meta.imageCount, 1);
    assert.equal(result.meta.requestedModel, "glm-5.3-flash");
    await assert.rejects(() => runCloudAgentJson({ cloudAgentToken: "test-only-client-token" },
      { prompt, imagePaths: [file] }, { request: async () => new Response("secret", { status: 401 }) }), /授权失败/);
    assert.throws(() => cloudEndpoint("https://other.example/v1/agent"), /HTTPS/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cloud classifier attaches at most two RFQ images and labels any OCR-only remainder", () => {
  const imagePaths = ["/tmp/first.png", "/tmp/second.png", "/tmp/third.png"];
  const request = buildClassificationRequest({ agentProvider: "cloud-claude", imageAnalysisMode: "agent-read",
    maxRfqImages: 4 }, { title: "Bag", imagePaths, imageAssets: [] }, { bag: { keywords: ["bag"] } });
  assert.deepEqual(request.agentImagePaths, imagePaths.slice(0, 2));
  assert.match(request.prompt, /attached directly/);
  assert.match(request.prompt, /Other RFQ images/);
  assert.doesNotMatch(request.prompt, /Use the Read tool/);
});

test("desktop cloud token is encrypted, shared with cloud OCR and never exposed by settings info", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-cloud-settings-"));
  try {
    const settings = new DesktopSettings(directory, cipher, { detectClaude: () => "" });
    assert.equal(settings.info().agentProvider, "cloud-claude");
    assert.equal(settings.info().ocrProvider, "cloud-ocr");
    assert.equal(settings.info().modelReady, false);
    settings.save({ modelApiKey: "test-only-client-token" });
    assert.equal(settings.info().modelReady, true);
    assert.equal(settings.info().ocrKeySource, "cloud-model");
    assert.equal(settings.environment().RFQ_CLOUD_TOKEN, "test-only-client-token");
    assert.equal(settings.environment().RFQ_CLOUD_OCR_TOKEN, "test-only-client-token");
    assert.equal(settings.environment().ANTHROPIC_API_KEY, undefined);
    assert.ok(!JSON.stringify(settings.info()).includes("test-only-client-token"));
    assert.ok(!fs.readFileSync(settings.file, "utf8").includes("test-only-client-token"));
    const restored = new DesktopSettings(directory, cipher, { detectClaude: () => "" });
    assert.equal(restored.environment().RFQ_CLOUD_TOKEN, "test-only-client-token");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("upgrade moves automatic local Claude users to cloud while preserving explicit local choice", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-cloud-upgrade-"));
  try {
    const file = path.join(directory, "model-settings.json");
    fs.writeFileSync(file, JSON.stringify({ modelConfigSource: "auto", agentProvider: "local-claude-sdk",
      modelName: "glm-5.3", modelApiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      ocrProvider: "glm-ocr", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing" }));
    const automatic = new DesktopSettings(directory, cipher, { detectClaude: () => process.execPath });
    assert.equal(automatic.info().agentProvider, "cloud-claude");
    assert.equal(automatic.info().ocrProvider, "cloud-ocr");
    assert.equal(automatic.info().modelReady, false);
    fs.writeFileSync(file, JSON.stringify({ modelConfigSource: "manual", agentProvider: "local-claude-sdk",
      modelName: "glm-5.3", modelApiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions" }));
    const explicit = new DesktopSettings(directory, cipher, { detectClaude: () => process.execPath });
    assert.equal(explicit.info().agentProvider, "local-claude-sdk");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("desktop model connection check uses the cloud token without returning it to the browser", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-cloud-server-"));
  fs.mkdirSync(path.join(directory, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(directory, "data/case-catalog/cases.json"), '{"cases":[],"counts":{}}');
  const settings = new DesktopSettings(directory, cipher, { detectClaude: () => "" });
  settings.save({ modelApiKey: "test-only-client-token" });
  let calls = 0;
  const service = await createCaseServer({ resources: path.resolve("."), workspace: directory, desktop: true,
    desktopSettings: settings, environment: () => settings.environment(), testCloudAgent: async env => {
      calls++;
      assert.equal(env.RFQ_CLOUD_TOKEN, "test-only-client-token");
      assert.equal(env.RFQ_CLOUD_AGENT_URL, "https://glm.knowflow.work/v1/agent");
      return { ok: true };
    } });
  try {
    const before = await fetch(service.url + "api/env/check").then(r => r.json());
    assert.equal(before.checks.find(c => c.key === "model").state, "已配置 · 待检测");
    const response = await fetch(service.url + "api/desktop/model/test", { method: "POST",
      headers: { Origin: new URL(service.url).origin, "X-Case-Console": "1", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.ok(!(await response.text()).includes("test-only-client-token"));
    const after = await fetch(service.url + "api/env/check").then(r => r.json());
    assert.equal(after.checks.find(c => c.key === "model").state, "实测可用");
  } finally { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
