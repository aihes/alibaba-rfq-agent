import assert from "node:assert/strict";
import test from "node:test";
import { executeAutoContact } from "../src/auto-contact.js";

test("skipped automatic contact still records an evaluation timestamp", async () => {
  const result = await executeAutoContact({ autoContactMode: "off" }, {}, {
    statePath: `/tmp/alibaba-rfq-agent-contact-${process.pid}-${Date.now()}.json`
  });
  assert.equal(result.status, "skipped");
  assert.match(result.evaluatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(result.policy.reasons.includes("AUTO_CONTACT_MODE is off"));
});
