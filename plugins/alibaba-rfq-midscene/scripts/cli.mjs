#!/usr/bin/env node
import fs from "node:fs";
import {
  analyzeRfq,
  browserStatus,
  fillQuote,
  scanRfqs,
  submitQuote
} from "./runtime.mjs";

function option(name, fallback = "") {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const command = process.argv[2] || "status";
let output;

if (command === "status") {
  output = await browserStatus();
} else if (command === "scan") {
  output = await scanRfqs({
    searchTerm: option("term"),
    maxCards: Number(option("max", "20"))
  });
} else if (command === "analyze") {
  const inputPath = option("rfq-file");
  if (!inputPath) throw new Error("Use --rfq-file <scan-result.json>");
  const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const index = Number(option("index", "0"));
  const rfq = Array.isArray(data.rfqs) ? data.rfqs[index] : data;
  output = await analyzeRfq({ rfq, runId: data.runId || option("run-id") || null });
} else if (command === "fill") {
  output = await fillQuote({ file: option("file") });
} else if (command === "submit") {
  output = await submitQuote({
    file: option("file"),
    confirmationToken: option("confirm"),
    confirmLiveSubmission: option("confirm-live") === "true"
  });
} else {
  throw new Error(`Unknown command: ${command}`);
}

console.log(JSON.stringify(output, null, 2));
