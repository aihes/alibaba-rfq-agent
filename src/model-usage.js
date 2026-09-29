import fs from "node:fs";

const number = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const usageFile = () => process.env.RFQ_USAGE_FILE || (process.env.RFQ_PROGRESS_FILE ? `${process.env.RFQ_PROGRESS_FILE}.usage.jsonl` : "");

/** One row per request, with no prompt, buyer text, credentials or response.
 * HTTP providers often report token counts without price; do not estimate a
 * monetary amount from a possibly stale public price table.
 */
export function recordModelUsage({ provider, model, phase = "unspecified", status, usage, reportedCostUsd }) {
  const file = usageFile();
  if (!file) return;
  const entry = { at: new Date().toISOString(), provider, model, phase, status,
    inputTokens: number(usage?.input_tokens ?? usage?.prompt_tokens),
    outputTokens: number(usage?.output_tokens ?? usage?.completion_tokens),
    reportedCostUsd: number(reportedCostUsd) };
  try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); } catch {}
}

const emptySummary = (recorded = false) => ({ recorded, attempts: 0, modelAttempts: 0, ocrAttempts: 0,
  inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, unpriced: 0 });

export function summarizeModelUsage(progressFile) {
  if (!progressFile) return emptySummary();
  try {
    const file = `${progressFile}.usage.jsonl`;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-1000);
    const entries = lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    return entries.reduce((sum, entry) => ({ recorded: true, attempts: sum.attempts + 1,
      modelAttempts: sum.modelAttempts + (entry.phase === "ocr" ? 0 : 1),
      ocrAttempts: sum.ocrAttempts + (entry.phase === "ocr" ? 1 : 0),
      inputTokens: sum.inputTokens + (number(entry.inputTokens) || 0),
      outputTokens: sum.outputTokens + (number(entry.outputTokens) || 0),
      reportedCostUsd: sum.reportedCostUsd + (number(entry.reportedCostUsd) || 0),
      unpriced: sum.unpriced + (entry.reportedCostUsd == null ? 1 : 0) }),
    emptySummary(true));
  } catch { return emptySummary(); }
}
