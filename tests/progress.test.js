import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { progressEventsFile, readProgressEvents, reportProgress, reportProgressResult } from "../src/progress.js";

test("task progress is a bounded local stage record without browser credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-progress-test-"));
  const previous = process.env.RFQ_PROGRESS_FILE;
  const previousCategory = process.env.RFQ_PROGRESS_CATEGORY_INDEX;
  try {
    process.env.RFQ_PROGRESS_FILE = path.join(root, "run.progress.json");
    const stageId = reportProgress("analysis", "正在调用模型\n下一行", { categoryIndex: 2, categoryTotal: 4, itemIndex: 1, itemTotal: 3 },
      { rfqId: "fixture", detailText: "Buyer needs kraft bags", password: "must never persist" });
    reportProgressResult(stageId, { recommendation: "review", missingRequired: ["gsm"] });
    const progress = JSON.parse(fs.readFileSync(process.env.RFQ_PROGRESS_FILE, "utf8"));
    assert.equal(progress.stage, "analysis");
    assert.equal(progress.message, "正在调用模型 下一行");
    assert.equal(progress.categoryIndex, 2);
    assert.equal(progress.itemTotal, 3);
    assert.ok(!JSON.stringify(progress).includes("RFQ_BROWSER_TOKEN"));
    process.env.RFQ_PROGRESS_CATEGORY_INDEX = "3";
    reportProgress("search", "正在扫描下一品类");
    assert.equal(JSON.parse(fs.readFileSync(process.env.RFQ_PROGRESS_FILE, "utf8")).categoryIndex, 3);
    reportProgress("complete", "本轮已完成");
    assert.deepEqual(readProgressEvents(process.env.RFQ_PROGRESS_FILE).events.map((item) => item.stage),
      ["analysis", "search", "complete"]);
    const analysis = readProgressEvents(process.env.RFQ_PROGRESS_FILE).events[0];
    assert.equal(analysis.input.detailText, "Buyer needs kraft bags");
    assert.equal(analysis.input.password, undefined);
    assert.deepEqual(analysis.output.missingRequired, ["gsm"]);
    assert.ok(analysis.completedAt);
    const bounded = readProgressEvents(process.env.RFQ_PROGRESS_FILE, 2);
    assert.deepEqual(bounded.events.map((item) => item.stage), ["search", "complete"]);
    assert.equal(bounded.truncated, true);
    assert.equal(fs.readFileSync(progressEventsFile(process.env.RFQ_PROGRESS_FILE), "utf8").trim().split("\n").length, 4);
  } finally {
    if (previous === undefined) delete process.env.RFQ_PROGRESS_FILE;
    else process.env.RFQ_PROGRESS_FILE = previous;
    if (previousCategory === undefined) delete process.env.RFQ_PROGRESS_CATEGORY_INDEX;
    else process.env.RFQ_PROGRESS_CATEGORY_INDEX = previousCategory;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
