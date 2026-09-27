import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractImageText } from "../src/ocr.js";

const config = { ocrProvider: "glm-ocr", ocrApiKey: "test-only-secret", ocrApiUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing", ocrTimeoutMs: 1000 };
test("GLM OCR sends official data URI protocol and retains written evidence", async () => {
  const file = path.join(os.tmpdir(), `rfq-ocr-${process.pid}.png`);
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  fs.writeFileSync(file, bytes);
  try {
    let calls = 0;
    const result = await extractImageText(file, config, { request: async (url, options) => {
      calls++; assert.equal(url, config.ocrApiUrl); assert.equal(options.headers.Authorization, `Bearer ${config.ocrApiKey}`);
      const body = JSON.parse(options.body); assert.equal(body.model, "glm-ocr");
      assert.equal(body.file, `data:image/png;base64,${bytes.toString("base64")}`);
      assert.equal(options.redirect, "error");
      return Response.json({ md_results: "Quantity 150\nUnit Price $7.50", request_id: "request-fixture" });
    } });
    assert.equal(calls, 1); assert.equal(result.status, "read"); assert.match(result.text, /150/); assert.equal(result.requestId, "request-fixture");
    assert.equal((await extractImageText(file, { ...config, ocrApiKey: "" }, { request: () => assert.fail("must not call") })).status, "unavailable");
    assert.equal((await extractImageText(file, { ...config, ocrProvider: "off" }, { request: () => assert.fail("must not call") })).status, "unavailable");
  } finally { fs.unlinkSync(file); }
});
test("WebP attachments convert to PNG without external runtimes; errors never expose remote secrets", async () => {
  const file = path.join(os.tmpdir(), `rfq-ocr-${process.pid}.webp`);
  fs.writeFileSync(file, await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).webp().toBuffer());
  try {
    const result = await extractImageText(file, config, { request: async (_url, options) => {
      assert.match(JSON.parse(options.body).file, /^data:image\/png;base64,/);
      return Response.json({ layout_details: [[{ content: "40oz tumbler" }]] });
    } });
    assert.equal(result.status, "read"); assert.match(result.text, /40oz/);
    const failed = await extractImageText(file, config, { request: async () => new Response(config.ocrApiKey, { status: 401 }) });
    assert.equal(failed.status, "error"); assert.ok(!JSON.stringify(failed).includes(config.ocrApiKey));
    const timeout = await extractImageText(file, config, { request: async () => { throw new DOMException("timeout", "TimeoutError"); } });
    assert.match(timeout.error, /超时/);
  } finally { fs.unlinkSync(file); }
});
