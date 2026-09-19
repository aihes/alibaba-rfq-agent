import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeAutoContact } from "./auto-contact.js";
import { probeLocalVision } from "./claude.js";
import { loadConfig, projectDir } from "./config.js";
import { fillQuoteForm, submissionToken } from "./form.js";
import { runCycle } from "./pipeline.js";
import { sleep } from "./utils.js";

function argValue(name) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function loadRecord(fileArg) {
  if (!fileArg) throw new Error("Provide --file data/drafts/<uuid>.json");
  const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(projectDir, fileArg);
  return { filePath, record: JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

async function main() {
  const config = loadConfig();
  const command = process.argv[2] || "once";

  if (command === "once") {
    console.log(JSON.stringify(await runCycle(config), null, 2));
    return;
  }

  if (command === "watch") {
    for (;;) {
      const started = new Date().toISOString();
      try {
        console.log(JSON.stringify({ started, ...(await runCycle(config)) }, null, 2));
      } catch (error) {
        console.error(JSON.stringify({ started, error: error.message }));
        const requiresHuman = /CAPTCHA|verification challenge|login is required|Cannot attach to the existing Chrome session through Chrome Bridge/i.test(error.message);
        if (requiresHuman) {
          console.error(JSON.stringify({ stopped: true, reason: "Chrome Bridge or Alibaba requires human attention" }));
          process.exitCode = 1;
          return;
        }
      }
      await sleep(config.pollIntervalSeconds * 1000);
    }
  }

  if (command === "doctor") {
    if (config.agentProvider !== "local-claude-sdk") {
      throw new Error("doctor checks AGENT_PROVIDER=local-claude-sdk only");
    }
    const version = execFileSync(config.localClaudeExecutable, ["--version"], { encoding: "utf8" }).trim();
    const imagePath = path.resolve(argValue("image") || path.join(projectDir, "tests/fixtures/vision-probe.png"));
    const probe = await probeLocalVision(config, imagePath);
    const actual = probe.data;
    const fixtureMatched = ["read", "partial"].includes(actual.imageReadStatus)
      && actual.tradeTerm === "EXW"
      && Number(actual.quantity) === 150
      && Number(actual.unitPrice) === 7.5;
    console.log(JSON.stringify({
      executable: config.localClaudeExecutable,
      version,
      requestedModel: config.localClaudeModel || "inherit-local-default",
      inheritedModel: process.env.ANTHROPIC_MODEL || "not_exposed",
      imagePath,
      visionProbe: actual,
      fixtureMatched,
      agent: probe.meta
    }, null, 2));
    if (!fixtureMatched) process.exitCode = 3;
    return;
  }

  if (command === "contact") {
    const { filePath, record } = loadRecord(argValue("file"));
    record.submission = await executeAutoContact(config, record);
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record.submission, null, 2));
    return;
  }

  if (command === "fill" || command === "submit") {
    const { filePath, record } = loadRecord(argValue("file"));
    if (command === "submit" && !argValue("confirm")) {
      console.log(`Submission is gated. Review ${filePath}, run fill first, then use:\n`);
      console.log(`ALLOW_LIVE_SUBMIT=true npm run submit -- --file '${filePath}' --confirm '${submissionToken(record)}'`);
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(await fillQuoteForm(config, record, {
      submit: command === "submit",
      confirmation: argValue("confirm")
    }), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
