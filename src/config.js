import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectDir = path.resolve(here, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, relativePath), "utf8"));
}

function resolveExecutable(candidate) {
  if (!candidate) return "";
  if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
    return fs.existsSync(candidate) ? candidate : "";
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const resolved = path.join(directory, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return "";
}

function firstExisting(paths) {
  for (const candidate of paths) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return "";
}

function parseList(value, fallback = []) {
  if (value === undefined || value === "") return fallback;
  if (["none", "off", "[]"].includes(value.trim().toLowerCase())) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function loadConfig() {
  const defaults = readJson("config/default.json");
  const localClaudeExecutable = firstExisting([
    process.env.LOCAL_CLAUDE_EXECUTABLE,
    path.join(os.homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude"
  ]);
  return {
    ...defaults,
    searchTerms: parseList(process.env.SEARCH_TERMS, defaults.searchTerms),
    maxCardsPerSearch: Number(process.env.MAX_CARDS_PER_SEARCH || defaults.maxCardsPerSearch),
    maxNewRfqsPerCycle: Number(process.env.MAX_NEW_RFQS_PER_CYCLE || defaults.maxNewRfqsPerCycle),
    navigationDelayMs: Number(process.env.NAVIGATION_DELAY_MS || defaults.navigationDelayMs),
    pricing: readJson("config/pricing-rules.json"),
    chromeBridgeTimeoutMs: Number(process.env.CHROME_BRIDGE_TIMEOUT_MS || 20000),
    agentProvider: process.env.AGENT_PROVIDER || "local-claude-sdk",
    localClaudeExecutable,
    localClaudeModel: process.env.LOCAL_CLAUDE_MODEL || "",
    localClaudeSettingSources: parseList(process.env.LOCAL_CLAUDE_SETTING_SOURCES, []),
    localClaudeStructuredOutput: process.env.LOCAL_CLAUDE_STRUCTURED_OUTPUT === "true",
    localClaudeTimeoutMs: Number(process.env.LOCAL_CLAUDE_TIMEOUT_MS || 120000),
    localClaudeMaxBudgetUsd: Number(process.env.LOCAL_CLAUDE_MAX_BUDGET_USD || 0.20),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    anthropicModel: process.env.ANTHROPIC_HTTP_MODEL || "",
    useClaude: process.env.USE_CLAUDE !== "false",
    useClaudeDraft: process.env.USE_CLAUDE_DRAFT !== "false",
    imageAnalysisMode: process.env.IMAGE_ANALYSIS_MODE || "local-ocr",
    maxRfqImages: Number(process.env.MAX_RFQ_IMAGES || 4),
    maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024),
    quotePort: process.env.QUOTE_PORT || "",
    pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS || 600),
    allowLiveSubmit: process.env.ALLOW_LIVE_SUBMIT === "true",
    autoContactMode: process.env.AUTO_CONTACT_MODE || "off",
    autoContactCategories: parseList(process.env.AUTO_CONTACT_CATEGORIES, []),
    autoContactMinConfidence: Number(process.env.AUTO_CONTACT_MIN_CONFIDENCE || 0.92),
    autoContactDailyLimit: Number(process.env.AUTO_CONTACT_DAILY_LIMIT || 3),
    autoContactMaxTotalUsd: Number(process.env.AUTO_CONTACT_MAX_TOTAL_USD || 2500),
    autoContactAck: process.env.AUTO_CONTACT_ACK || "",
    autoContactAllowFixtureUrls: false
  };
}
