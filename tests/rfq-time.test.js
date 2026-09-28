import test from "node:test";
import assert from "node:assert/strict";
import { parsePublishedAt, parseRecentMinutes, publishedWithinMinutes } from "../src/rfq-time.js";

test("parses buyer publication time and filters at each card's observation time", () => {
  const observedAt = new Date("2026-09-28T08:00:00.000Z");
  const recent = parsePublishedAt("Posted 45 minutes ago", observedAt);
  assert.equal(recent, "2026-09-28T07:15:00.000Z");
  assert.equal(parsePublishedAt("发布于 2小时前", observedAt), "2026-09-28T06:00:00.000Z");
  assert.equal(parsePublishedAt("发布日期:7 小时前", observedAt), "2026-09-28T01:00:00.000Z");
  assert.equal(parsePublishedAt("发布日期:3 天前", observedAt), "2026-09-25T08:00:00.000Z");
  assert.equal(parsePublishedAt("Posted on 2026-09-28 15:00", observedAt) != null, true);
  assert.equal(parsePublishedAt("unknown", observedAt), null);
  assert.equal(publishedWithinMinutes({ publishedAt: recent }, 60, observedAt), true);
  assert.equal(publishedWithinMinutes({ publishedAt: recent }, 30, observedAt), false);
  assert.equal(publishedWithinMinutes({ publishedAt: null }, 60, observedAt), false);
  assert.equal(publishedWithinMinutes({ publishedAt: null }, 0, observedAt), true);
});

test("recent minute setting accepts only 0 through 525600 as whole minutes", () => {
  assert.equal(parseRecentMinutes("0"), 0);
  assert.equal(parseRecentMinutes("60"), 60);
  for (const invalid of ["", "1.5", "-1", "525601", "abc", null]) {
    assert.throws(() => parseRecentMinutes(invalid), /整数分钟/);
  }
});
