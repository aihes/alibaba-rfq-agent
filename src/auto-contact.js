import fs from "node:fs";
import path from "node:path";
import { projectDir } from "./config.js";
import { fillQuoteForm, fillQuotePage, submissionToken } from "./form.js";
import { ensureDataDirs } from "./utils.js";

export const AUTO_CONTACT_ACK = "I_UNDERSTAND_AUTO_QUOTES_ARE_SENT";

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function defaultStatePath() {
  return path.join(projectDir, "data/auto-contact-state.json");
}

export function loadContactState(statePath = defaultStatePath()) {
  ensureDataDirs();
  if (!fs.existsSync(statePath)) return { attempts: {} };
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return { ...state, attempts: state.attempts || {} };
}

export function saveContactState(state, statePath = defaultStatePath()) {
  ensureDataDirs();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function allowedQuoteUrl(url, allowFixtureUrls) {
  try {
    const parsed = new URL(url);
    if (allowFixtureUrls && parsed.protocol === "file:") return true;
    return parsed.protocol === "https:"
      && (parsed.hostname === "sourcing.alibaba.com" || parsed.hostname.endsWith(".sourcing.alibaba.com")
        || parsed.hostname === "rfqposting.alibaba.com" || parsed.hostname.endsWith(".rfqposting.alibaba.com"));
  } catch {
    return false;
  }
}

export function evaluateAutoContact(config, record, contactState = { attempts: {} }, now = new Date()) {
  const reasons = [];
  const mode = config.autoContactMode || "off";
  if (!["fill", "submit"].includes(mode)) reasons.push("AUTO_CONTACT_MODE is off");
  if (!record?.rfq?.id || !record?.rfq?.quoteUrl) reasons.push("RFQ id or quote URL is missing");
  if (!allowedQuoteUrl(record?.rfq?.quoteUrl || "", config.autoContactAllowFixtureUrls)) reasons.push("Quote URL is outside the allowed Alibaba hosts");
  if (record?.quote?.status !== "quoted") reasons.push("Only non-conditional quoted records are eligible");
  if (!config.autoContactCategories?.includes(record?.analysis?.categoryId)) reasons.push("Category is not in AUTO_CONTACT_CATEGORIES");
  if (Number(record?.analysis?.confidence || 0) < config.autoContactMinConfidence) reasons.push("Analysis confidence is below the automatic-contact threshold");
  if (record?.analysis?.recommendation !== "quote") reasons.push("Agent recommendation is not quote");
  if ((record?.analysis?.missingRequired || []).length > 0) reasons.push("Required fields are missing");
  if ((record?.analysis?.riskFlags || []).length > 0) reasons.push("Risk flags require human review");
  if (!Number.isFinite(record?.rfq?.remainingQuotes) || record.rfq.remainingQuotes <= 0) reasons.push("Remaining quote slots are unknown or exhausted");
  if (!record?.draft?.buyerMessage) reasons.push("Buyer message is missing");
  if (!(record?.draft?.port || config.quotePort)) reasons.push("Verified QUOTE_PORT is missing");
  if (!Number.isFinite(record?.quote?.totalUsd) || record.quote.totalUsd > config.autoContactMaxTotalUsd) reasons.push("Quote total exceeds AUTO_CONTACT_MAX_TOTAL_USD");

  const prior = contactState.attempts?.[record?.rfq?.id];
  if (prior) reasons.push(`RFQ already has an automatic-contact state: ${prior.status}`);
  const today = shanghaiDate(now);
  const submittedToday = Object.values(contactState.attempts || {}).filter((attempt) => attempt.status === "submitted" && attempt.date === today).length;
  if (submittedToday >= config.autoContactDailyLimit) reasons.push("AUTO_CONTACT_DAILY_LIMIT reached");
  if (mode === "submit") {
    if (!config.allowLiveSubmit) reasons.push("ALLOW_LIVE_SUBMIT is false");
    if (config.autoContactAck !== AUTO_CONTACT_ACK) reasons.push("AUTO_CONTACT_ACK is missing or incorrect");
  }
  return { eligible: reasons.length === 0, mode, reasons, submittedToday, dailyLimit: config.autoContactDailyLimit };
}

export async function executeAutoContact(config, record, {
  page,
  statePath = defaultStatePath(),
  now = new Date()
} = {}) {
  const evaluatedAt = new Date().toISOString();
  const contactState = loadContactState(statePath);
  const policy = evaluateAutoContact(config, record, contactState, now);
  if (!policy.eligible) return { status: "skipped", evaluatedAt, policy };

  const invokeForm = (options) => page
    ? fillQuotePage(page, config, record, options)
    : fillQuoteForm(config, record, options);
  if (policy.mode === "fill") {
    const startedAt = new Date().toISOString();
    try {
      const result = await invokeForm({ submit: false });
      const completedAt = new Date().toISOString();
      return {
        ...result,
        evaluatedAt,
        startedAt,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(startedAt),
        policy
      };
    } catch (error) {
      const failedAt = new Date().toISOString();
      return {
        status: "fill_failed",
        evaluatedAt,
        startedAt,
        failedAt,
        durationMs: Date.parse(failedAt) - Date.parse(startedAt),
        error: error.message,
        policy
      };
    }
  }

  const attempt = {
    status: "attempting",
    date: shanghaiDate(now),
    startedAt: now.toISOString(),
    categoryId: record.analysis.categoryId,
    unitPriceUsd: record.quote.unitPriceUsd,
    quantity: record.quote.quantity,
    rulesVersion: record.quote.rulesVersion
  };
  contactState.attempts[record.rfq.id] = attempt;
  saveContactState(contactState, statePath);
  try {
    const result = await invokeForm({ submit: true, confirmation: submissionToken(record) });
    const completedAt = new Date().toISOString();
    contactState.attempts[record.rfq.id] = {
      ...attempt,
      status: "submitted",
      completedAt
    };
    saveContactState(contactState, statePath);
    return {
      ...result,
      evaluatedAt,
      startedAt: attempt.startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(attempt.startedAt),
      policy
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    contactState.attempts[record.rfq.id] = {
      ...attempt,
      status: "needs_manual_review",
      failedAt,
      error: error.message
    };
    saveContactState(contactState, statePath);
    return {
      status: "needs_manual_review",
      evaluatedAt,
      startedAt: attempt.startedAt,
      failedAt,
      durationMs: Date.parse(failedAt) - Date.parse(attempt.startedAt),
      error: error.message,
      policy
    };
  }
}
