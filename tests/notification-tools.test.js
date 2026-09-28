import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createNativeNotifier } from "../desktop/native-notifications.js";
import { createNotificationTools } from "../src/notification-tools.js";
import { createCaseServer } from "../desktop/server.js";
import { fileURLToPath } from "node:url";
const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = () => ({ rfq: { id: "rfq-tool", title: "Carton", remainingQuotes: 2, quoteUrl: "https://sourcing.alibaba.com/rfq/quote" },
  analysis: { recommendation: "quote", confidence: 0.99, missingRequired: [], riskFlags: [] },
  quote: { status: "quoted", currency: "USD", quantity: 1000, unitPriceUsd: 1, totalUsd: 1000, setupUsd: 0 },
  draft: { productName: "Carton", productDetails: "Verified dimensions", port: "Verified port", buyerMessage: "Please review" }, submission: { status: "skipped" } });
function seed(root) {
  for (const dir of ["data/drafts", "data/case-catalog/ops", "config"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/ops/settings.json"), JSON.stringify({ notificationsEnabled: true }));
  fs.writeFileSync(path.join(root, "data/drafts/rfq-tool.json"), JSON.stringify(fixture()));
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), JSON.stringify({ cases: [], counts: { cases: 0 } }));
  fs.copyFileSync(path.join(resources, "config/default.json"), path.join(root, "config/default.json"));
  fs.copyFileSync(path.join(resources, "config/pricing-rules.json"), path.join(root, "config/pricing-rules.json"));
}
test("tool reads real draft, rejects forged parameters/path escape and deduplicates concurrent callers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-tool-")); seed(root);
  let calls = 0;
  const tools = createNotificationTools({ workspace: root, config: {}, send: async (payload) => {
    calls++; assert.match(payload.message, /USD 1\/件/); await new Promise((resolve) => setTimeout(resolve, 30)); return { status: "accepted" };
  } });
  try {
    assert.equal((await tools.call("notifications.status")).enabled, true);
    await assert.rejects(tools.call("notifications.opportunity", { draftId: "../private" }), /ID/);
    await assert.rejects(tools.call("notifications.opportunity", { draftId: "rfq-tool", quote: { status: "quoted" } }), /参数/);
    await assert.rejects(tools.call("notifications.test", { toString: "bad" }), /参数/);
    const results = await Promise.all([tools.call("notifications.opportunity", { draftId: "rfq-tool" }), tools.call("notifications.opportunity", { draftId: "rfq-tool" })]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["accepted", "duplicate"]); assert.equal(calls, 1);
    // 清空汇总索引仍有独占领取记录，模拟两个独立进程持有不同索引快照。
    fs.writeFileSync(path.join(root, "data/case-catalog/ops/notification-state.json"), '{"attempts":{}}');
    assert.equal((await tools.call("notifications.opportunity", { draftId: "rfq-tool" })).status, "duplicate");
    fs.writeFileSync(path.join(root, "data/case-catalog/ops/settings.json"), '{"notificationsEnabled":false}');
    assert.equal((await tools.call("notifications.test")).status, "disabled");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("tool rechecks current rules rather than trusting a historical quoted flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-tool-rules-")); seed(root);
  try {
    const tools = createNotificationTools({ workspace: root, send: () => assert.fail("stale quote cannot alert") });
    assert.equal((await tools.call("notifications.opportunity", { draftId: "rfq-tool" })).status, "not_opportunity");
    fs.symlinkSync(path.join(root, "config/default.json"), path.join(root, "data/drafts/outside.json"));
    await assert.rejects(tools.call("notifications.opportunity", { draftId: "outside" }), /允许目录/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("HTTP tool credentials are scoped to notification tools and cannot change desktop settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-tool-http-")); seed(root);
  let calls = 0;
  const token = "a".repeat(64);
  const service = await createCaseServer({ resources, workspace: root, desktop: true, toolToken: token,
    notify: async () => { calls++; return { status: "accepted" }; }, spawnProcess: () => assert.fail("must not control browser") });
  const post = (route, key, body) => fetch(service.url + route, { method: "POST", headers: { "Content-Type": "application/json", "X-RFQ-Tool": key }, body: JSON.stringify(body) });
  try {
    const info = await (await fetch(service.url + "api/tools/notifications")).json();
    assert.equal(info.tools.length, 3); assert.ok(!JSON.stringify(info).includes(token));
    assert.equal((await post("api/tools/notifications", "wrong", { tool: "notifications.test" })).status, 403);
    assert.equal((await post("api/ops/settings", token, { browserEnabled: true })).status, 403);
    assert.equal((await (await post("api/tools/notifications", token, { tool: "notifications.test" })).json()).status, "accepted");
    assert.equal(calls, 1); assert.equal(service.console.settings.browserEnabled, true);
    assert.equal(service.console.settings.quoteEnabled, false);
    assert.equal((await post("api/tools/notifications", token, { tool: "notifications.opportunity", arguments: { draftId: "rfq-tool", message: "forged" } })).status, 409);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("native adapter reports OS acceptance/failure and notification click opens only the exact draft", async () => {
  const made = [], opened = [], raised = [];
  let mode = "show";
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; made.push(this); }
    show() { if (mode) queueMicrotask(() => this.emit(mode)); }
  }
  const notifier = createNativeNotifier({ Notification: FakeNotification, openDraft: (id) => opened.push(id), showOpportunity: () => raised.push(true), waitMs: 10 });
  assert.equal((await notifier.send({ message: "Untrusted\ntext", draftId: "rfq-tool" })).status, "accepted");
  assert.equal(raised.length, 1);
  assert.equal(made[0].options.id, "rfq-rfq-tool"); assert.ok(!made[0].options.body.includes("\n"));
  made[0].emit("click"); assert.deepEqual(opened, ["rfq-tool"]);
  await assert.rejects(notifier.send({ draftId: "../../private" }), /ID/);
  mode = "failed"; assert.equal((await notifier.send({ test: true })).status, "failed"); assert.equal(raised.length, 1);
  mode = null; assert.equal((await notifier.send({ test: true })).status, "requested");
});
