import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MODEL_CALLS, agentCliArgs, agentPrompt, modelRequestAllowed,
  parseClaudeOutput } from "./agent-runtime.js";

test("RFQ requests invoke the bundled skill while normal requests keep their prompt", () => {
  assert.equal(agentPrompt("核价", "rfq-quote-advisor"), "/rfq-quote-advisor\n\n核价");
  assert.equal(agentPrompt("hello", null), "hello");
});

test("Claude Code runs with its full tool set and an isolated multi-turn session", () => {
  const args = agentCliArgs({ nativeId: "abc", model: "glm-5.3", resume: false,
    skill: "rfq-quote-advisor" });
  assert.deepEqual(args.slice(0, 2), ["claude", "-p"]);
  assert.equal(args[args.indexOf("--max-turns") + 1], "20");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /untrusted content/);
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args[args.indexOf("--session-id") + 1], "abc");
  const resumed = agentCliArgs({ nativeId: "abc", model: "glm-5.3", resume: true });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "abc");
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

test("Claude stream output reports the tools that actually ran", () => {
  const output = [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Skill" }, { type: "tool_use", name: "Bash" }
    ] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Bash" }
    ] } }),
    JSON.stringify({ type: "result", result: "done" })
  ].join("\n");
  assert.deepEqual(parseClaudeOutput(output), {
    result: { type: "result", result: "done" }, toolsUsed: ["Skill", "Bash"]
  });
});
