import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MODEL_CALLS, agentPrompt, modelRequestAllowed } from "./agent-runtime.js";

test("RFQ requests invoke the bundled skill while normal requests keep their prompt", () => {
  assert.equal(agentPrompt("核价", "rfq-quote-advisor"), "/rfq-quote-advisor\n\n核价");
  assert.equal(agentPrompt("hello", null), "hello");
});

test("outbound model credential is only available during a bounded run", () => {
  const request = { url: "http://rfq-service.internal/api/anthropic/v1/messages", method: "POST" };
  const run = { provider: "service", calls: 0, expiresAt: 101 };
  assert.equal(modelRequestAllowed(request, run, 100), true);
  assert.equal(modelRequestAllowed(request, { ...run, calls: MAX_MODEL_CALLS }, 100), false);
  assert.equal(modelRequestAllowed(request, run, 102), false);
  assert.equal(modelRequestAllowed({ ...request, method: "GET" }, run, 100), false);
  assert.equal(modelRequestAllowed({ ...request, url: "http://rfq-service.internal/api/anthropic/v1/models" }, run, 100), false);
  assert.equal(modelRequestAllowed({ ...request, url: "http://example.com/api/anthropic/v1/messages" }, run, 100), false);
});
