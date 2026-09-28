import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consoleUrl, isOpportunity, notifyOpportunity, prepareNotifier, sendNativeNotification, testNotification } from "../src/notifications.js";

const opportunity = () => ({ rfq: { id: "rfq-new", title: "纸箱", remainingQuotes: 2, quoteUrl: "https://sourcing.alibaba.com/rfq/quote" },
  quote: { status: "quoted", currency: "USD", quantity: 1000, unitPriceUsd: 1, totalUsd: 1000, setupUsd: 0 },
  draft: { port: "Verified port", productName: "Carton", productDetails: "Confirmed specification", buyerMessage: "Please review" },
  analysis: { recommendation: "quote", confidence: 0.99, missingRequired: [], riskFlags: [] },
  submission: { status: "skipped" } });

test("only new reviewable rule quotes are opportunity alerts", () => {
  assert.equal(isOpportunity(opportunity()), true);
  for (const mutate of [r => r.quote.status = "conditional_quote", r => r.analysis.recommendation = "review",
    r => r.analysis.confidence = 0.5, r => r.analysis.missingRequired = ["size"], r => r.analysis.riskFlags = ["risk"],
    r => r.rfq.remainingQuotes = null, r => r.rfq.remainingQuotes = 0, r => r.submission.status = "submitted",
    r => r.submission.status = "filled_not_submitted", r => r.quote.currency = "EUR", r => r.quote.totalUsd = 1001,
    r => r.quote.setupUsd = 5, r => r.draft.port = "", r => r.analysis.confidence = NaN,
    r => r.rfq.quoteUrl = "https://attacker.example/quote"]) {
    const record = opportunity(); mutate(record); assert.equal(isOpportunity(record), false);
  }
});

test("opportunity notifications persist deduplication and read the off switch while watching", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-notify-"));
  const file = path.join(root, "settings.json");
  let calls = 0;
  const send = async () => { calls++; return { status: "accepted", detail: "fixture" }; };
  try {
    fs.writeFileSync(file, JSON.stringify({ notificationsEnabled: false }));
    assert.equal((await notifyOpportunity(opportunity(), {}, { file, send })).status, "disabled");
    fs.writeFileSync(file, JSON.stringify({ notificationsEnabled: true }));
    assert.equal((await notifyOpportunity(opportunity(), {}, { file, send })).status, "accepted");
    assert.equal((await notifyOpportunity(opportunity(), {}, { file, send })).status, "duplicate");
    const next = opportunity(); next.rfq.id = "rfq-second";
    fs.writeFileSync(file, JSON.stringify({ notificationsEnabled: false }));
    assert.equal((await notifyOpportunity(next, {}, { file, send })).status, "disabled");
    assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "notification-state.json"))).attempts["rfq-new"];
    assert.equal(saved.status, "accepted");
    assert.match(saved.message, /纸箱.*USD 1\/件/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("OS delivery failure never discards a draft or repeatedly alerts the same RFQ", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-notify-fail-"));
  const file = path.join(root, "settings.json");
  const record = opportunity();
  const saved = JSON.stringify(record);
  try {
    fs.writeFileSync(file, JSON.stringify({ notificationsEnabled: true }));
    const send = async () => ({ status: "failed", detail: "permission denied" });
    assert.equal((await notifyOpportunity(record, {}, { file, send })).status, "failed");
    assert.equal((await notifyOpportunity(record, {}, { file, send })).status, "duplicate");
    assert.equal(JSON.stringify(record), saved);
    fs.writeFileSync(path.join(root, "notification-state.json"), "broken");
    assert.equal((await notifyOpportunity(record, {}, { file, send })).status, "failed");
    assert.equal(JSON.stringify(record), saved);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("notification click opens only the local console and exact draft with the actual port", () => {
  assert.equal(consoleUrl("http://localhost:8889/", "rfq-new"), "http://localhost:8889/?view=console&draft=rfq-new");
  for (const url of ["https://evil.example", "file:///etc/passwd", "http://localhost.evil.example", "http://user:pass@localhost:8888"]) {
    assert.throws(() => consoleUrl(url, "rfq-new"));
  }
  assert.throws(() => consoleUrl(undefined, "../private"));
});

test("native helper receives literal untrusted text, fixed actions and a bounded wait", async () => {
  let calls = 0;
  const result = await sendNativeNotification({ message: '"; $(touch /tmp/no); -execute evil', draftId: "rfq-new" }, {
    platform: "darwin", prepare: () => "/official/helper", run: async (executable, args, options) => {
      calls++;
      assert.equal(executable, "/official/helper");
      assert.ok(args[3].includes("$(touch /tmp/no)"));
      assert.equal(args.includes("-execute"), false);
      assert.equal(args[7], "http://localhost:8888/?view=console&draft=rfq-new");
      assert.equal(options.shell, undefined);
      assert.equal(options.timeout, 20000);
    }
  });
  assert.equal(calls, 1); assert.equal(result.status, "accepted");
  const failed = await sendNativeNotification({ draftId: "rfq-new" }, {
    platform: "darwin", prepare: () => "/official/helper", run: async () => { throw Object.assign(new Error("denied"), { code: 3 }); }
  });
  assert.equal(failed.status, "failed"); assert.ok(failed.detail.includes("允许通知"));
});

test("unsupported systems and disabled test requests do not launch notification processes", async () => {
  const unexpected = () => { throw new Error("must not run"); };
  assert.equal((await sendNativeNotification({}, { platform: "win32", run: unexpected, prepare: unexpected })).status, "unsupported");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-notify-test-"));
  try {
    assert.equal((await testNotification({ file: path.join(root, "missing.json"), send: unexpected })).status, "disabled");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native command receives EOF on stdin rather than waiting for the timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-notify-stdin-"));
  const executable = path.join(root, "fixture");
  try {
    fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n`, { mode: 0o755 });
    const started = Date.now();
    const result = await sendNativeNotification({ test: true }, { platform: "darwin", prepare: () => executable });
    assert.equal(result.status, "accepted");
    assert.ok(Date.now() - started < 5000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bundled universal macOS app prepares offline with its signature and executable intact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-notify-bundle-"));
  try {
    const executable = prepareNotifier({ installRoot: root });
    assert.ok(fs.statSync(executable).mode & 0o111);
    assert.ok(fs.existsSync(path.join(path.dirname(executable), "../_CodeSignature/CodeResources")));
    const mtime = fs.statSync(executable).mtimeMs;
    assert.equal(prepareNotifier({ installRoot: root }), executable);
    assert.equal(fs.statSync(executable).mtimeMs, mtime);
    fs.writeFileSync(executable, "corrupt");
    assert.throws(() => prepareNotifier({ installRoot: root }), /目录不完整/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
