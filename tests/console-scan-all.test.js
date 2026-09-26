import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scanAllTerms } from "../scripts/scan_all_terms.mjs";

const terms = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8")).searchTerms;
const silent = () => {};

test("all-category scan stops on the first failed category and preserves its exit code", () => {
  const calls = [];
  const status = scanAllTerms({
    log: silent, error: silent,
    run: (_executable, args) => {
      calls.push(args);
      return { status: calls.length === 2 ? 7 : 0 };
    }
  });
  assert.equal(status, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][3], terms[1]);
});

test("all-category scan covers the configured list and forwards literal arguments in read-only mode", () => {
  const calls = [];
  const status = scanAllTerms({ log: silent, error: silent, run: (executable, args, options) => {
    calls.push(args[3]);
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(1), ["scan", "--term", args[3], "--max", "10"]);
    assert.equal(options.env.AUTO_CONTACT_MODE, "off");
    assert.equal(options.env.ALLOW_LIVE_SUBMIT, "false");
    assert.equal(options.shell, undefined);
    assert.equal(options.detached, undefined);
    return { status: 0 };
  } });
  assert.equal(status, 0);
  assert.deepEqual(calls, terms);
});

test("a killed or unlaunchable scanner never continues to another category", () => {
  for (const result of [{ status: null, signal: "SIGTERM" }, { error: new Error("unavailable") }]) {
    let calls = 0;
    assert.equal(scanAllTerms({ log: silent, error: silent, run: () => { calls++; return result; } }), 1);
    assert.equal(calls, 1);
  }
});
