import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readDraftArchive, setDraftArchived } from "../src/draft-archive.js";

test("a rejected draft can leave the workbench and return without altering its quote evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-draft-archive-"));
  try {
    const directory = path.join(root, "data/drafts");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "rfq-one.json");
    const source = JSON.stringify({ rfq: { id: "rfq-one" }, quote: { status: "needs_review" }, submission: { status: "skipped" } });
    fs.writeFileSync(file, source);
    const archived = setDraftArchived(root, "rfq-one", true);
    assert.equal(archived.archived, true);
    assert.ok(Date.parse(archived.archivedAt));
    assert.equal(readDraftArchive(root)["rfq-one"].archivedAt, archived.archivedAt);
    assert.equal(fs.readFileSync(file, "utf8"), source);
    setDraftArchived(root, "rfq-one", false);
    assert.deepEqual(readDraftArchive(root), {});
    assert.equal(fs.readFileSync(file, "utf8"), source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("submitted or uncertain browser actions cannot be archived", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-draft-archive-"));
  try {
    const directory = path.join(root, "data/drafts");
    fs.mkdirSync(directory, { recursive: true });
    for (const [id, status] of [["sent", "submitted"], ["attempt", "attempting"], ["unknown", "new_status"]]) {
      fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ submission: { status } }));
      assert.throws(() => setDraftArchived(root, id, true), /保留在列表/);
    }
    assert.deepEqual(readDraftArchive(root), {});
    assert.throws(() => setDraftArchived(root, "../sent", true), /参数无效/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a later verified submission reappears even if the draft was archived earlier", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-draft-archive-"));
  try {
    const directory = path.join(root, "data/drafts");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "rfq-later.json");
    const record = { createdAt: new Date().toISOString(), rfq: { id: "rfq-later", title: "Later submission" },
      quote: { status: "quoted", currency: "USD", totalUsd: 10 }, submission: { status: "skipped" } };
    fs.writeFileSync(file, JSON.stringify(record));
    setDraftArchived(root, "rfq-later", true);
    record.submission = { status: "submitted", completedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(record));
    const rows = JSON.parse(execFileSync(process.execPath, ["scripts/console-quote.mjs", "list"], {
      cwd: path.resolve("."), env: { ...process.env, RFQ_WORKSPACE_DIR: root }, encoding: "utf8"
    }));
    assert.equal(rows.drafts[0].archivedAt, null);
    assert.equal(rows.counts.submitted, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
