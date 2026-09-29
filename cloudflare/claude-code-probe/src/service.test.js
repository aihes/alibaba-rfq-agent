import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, buildClaudeInput, callGlmOcr, parseImage, readJson,
  selectAgentModel, validateAgent } from "./service.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9C9S8AAAAASUVORK5CYII=";

test("image input accepts actual PNG bytes and rejects remote URLs or false MIME types", () => {
  const image = parseImage({ mime_type: "image/png", data: png });
  assert.equal(image.mime_type, "image/png");
  assert.ok(image.byte_length > 0);
  assert.throws(() => parseImage({ mime_type: "image/jpeg", data: png }),
    (error) => error instanceof ApiError && error.code === "image_content_mismatch");
  assert.throws(() => parseImage({ mime_type: "image/png", data: "https://example.com/a.png" }),
    (error) => error instanceof ApiError && error.code === "invalid_image_data");
});

test("agent validates session ids and limits images", () => {
  const input = validateAgent({ query: "  summarize ", session_id: "case_123", images: [] });
  assert.equal(input.query, "  summarize ");
  assert.equal(input.sessionId, "case_123");
  assert.throws(() => validateAgent({ query: "ok", session_id: "../other-client" }),
    (error) => error instanceof ApiError && error.code === "invalid_session_id");
  assert.throws(() => validateAgent({ query: "ok", images: [{}, {}, {}] }),
    (error) => error instanceof ApiError && error.code === "invalid_images");
});

test("request body limit is enforced even without a Content-Length header", async () => {
  const request = new Request("https://example.com/v1/agent", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "long" }) });
  await assert.rejects(readJson(request, 8),
    (error) => error instanceof ApiError && error.code === "request_too_large");
});

test("OCR forwards only the image to the fixed provider and returns recognized text", async () => {
  let called = false;
  const result = await callGlmOcr(parseImage({ mime_type: "image/png", data: png }), "private-key",
    async (url, options) => {
      called = true;
      assert.equal(url, "https://open.bigmodel.cn/api/paas/v4/layout_parsing");
      assert.equal(options.headers.Authorization, "Bearer private-key");
      assert.equal(JSON.parse(options.body).model, "glm-ocr");
      assert.equal(options.body.includes("private-key"), false);
      return Response.json({ md_results: "OCR TEST 123", request_id: "test-id" });
    });
  assert.equal(called, true);
  assert.equal(result.text, "OCR TEST 123");
  assert.equal(result.provider_request_id, "test-id");
});

test("Agent sends query and original image blocks to Claude Code", () => {
  const input = JSON.parse(buildClaudeInput("What is in this image?", [
    parseImage({ mime_type: "image/png", data: png })
  ]));
  assert.equal(input.type, "user");
  assert.equal(input.message.content[0].text, "What is in this image?");
  assert.equal(input.message.content[1].type, "image");
  assert.equal(input.message.content[1].source.media_type, "image/png");
  assert.equal(input.message.content[1].source.data, png);
  assert.equal(selectAgentModel(null, []), "glm-5.3");
  assert.equal(selectAgentModel(null, [{}]), "glm-5.3-flash");
  assert.equal(selectAgentModel("glm-5.3-flash", []), "glm-5.3-flash");
});
