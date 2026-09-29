import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("an older desktop workspace without a publication-time setting still loads for local reanalysis", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rfq-old-workspace-"));
  try {
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config/default.json"), JSON.stringify({ searchTerms: [], supportedCategories: {} }));
    fs.writeFileSync(path.join(root, "config/pricing-rules.json"), JSON.stringify({ rules: {} }));
    const run = (recent) => spawnSync(process.execPath, ["--input-type=module", "-e",
      'import { loadConfig } from "./src/config.js"; process.stdout.write(String(loadConfig().recentRfqMinutes));'],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8",
      env: { PATH: process.env.PATH || "", RFQ_DESKTOP: "1", RFQ_WORKSPACE_DIR: root,
        ...(recent === undefined ? {} : { RECENT_RFQ_MINUTES: recent }) } });
    const fallback = run();
    assert.equal(fallback.status, 0);
    assert.equal(fallback.stdout, "60");
    const unlimited = run("0");
    assert.equal(unlimited.status, 0);
    assert.equal(unlimited.stdout, "0");
    const invalid = run("invalid");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /整数分钟/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
