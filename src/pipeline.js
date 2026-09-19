import path from "node:path";
import { buildAgentInputAudit } from "./agent-audit.js";
import { executeAutoContact } from "./auto-contact.js";
import { connectBrowser } from "./browser.js";
import { classifyRfq } from "./classifier.js";
import { collectSearchPage, hydrateDetail, keywordPrefilter } from "./collector.js";
import { createDraft } from "./drafter.js";
import { priceRfq } from "./pricing.js";
import { appendJsonl, loadState, saveState, sleep, writeJson } from "./utils.js";

export async function runCycle(config) {
  const cycleStartedAt = new Date().toISOString();
  const state = loadState();
  const { browser, page, createdPage } = await connectBrowser(config);
  const collected = [];
  try {
    for (const searchTerm of config.searchTerms) {
      const cards = await collectSearchPage(page, config, searchTerm);
      collected.push(...cards);
      await sleep(config.navigationDelayMs);
    }

    const unique = [...new Map(collected.map((rfq) => [rfq.id, rfq])).values()];
    const candidates = unique
      .filter((rfq) => !state.seen[rfq.id])
      .map((rfq) => ({ rfq, prefilter: keywordPrefilter(rfq, config.supportedCategories) }))
      .filter((entry) => entry.prefilter.length > 0)
      .slice(0, config.maxNewRfqsPerCycle);

    const records = [];
    for (const { rfq, prefilter } of candidates) {
      const processingStartedAt = new Date().toISOString();
      const detailStartedAt = new Date().toISOString();
      const hydrated = await hydrateDetail(page, rfq, config);
      const detailCompletedAt = new Date().toISOString();
      const analysisStartedAt = new Date().toISOString();
      const analysis = await classifyRfq(config, hydrated);
      const analysisCompletedAt = new Date().toISOString();
      const quote = priceRfq(hydrated, analysis, config.pricing);
      const pricingCompletedAt = new Date().toISOString();
      const draftStartedAt = new Date().toISOString();
      const draft = await createDraft(config, hydrated, analysis, quote);
      const draftCompletedAt = new Date().toISOString();
      const record = {
        createdAt: new Date().toISOString(),
        rfq: hydrated,
        prefilter,
        analysis,
        quote,
        draft,
        agentInput: buildAgentInputAudit(config, hydrated, analysis, quote, draft),
        timing: {
          discoveredAt: hydrated.collectedAt,
          processingStartedAt,
          detailStartedAt,
          detailCompletedAt,
          analysisStartedAt,
          analysisCompletedAt,
          pricingCompletedAt,
          draftStartedAt,
          draftCompletedAt,
          discoveryToDraftMs: Date.parse(draftCompletedAt) - Date.parse(hydrated.collectedAt),
          analysisDurationMs: Date.parse(analysisCompletedAt) - Date.parse(analysisStartedAt)
        },
        submission: { status: "not_submitted" }
      };
      const relativePath = `data/drafts/${hydrated.id}.json`;
      const outputPath = writeJson(relativePath, record);
      record.submission = await executeAutoContact(config, record, { page });
      record.timing.autoContactEvaluatedAt = record.submission.evaluatedAt || null;
      record.timing.submissionStartedAt = record.submission.startedAt || null;
      record.timing.submissionCompletedAt = record.submission.completedAt || null;
      record.timing.submissionFailedAt = record.submission.failedAt || null;
      record.timing.submissionDurationMs = record.submission.durationMs ?? null;
      record.timing.discoveryToSubmissionMs = record.submission.completedAt
        ? Date.parse(record.submission.completedAt) - Date.parse(hydrated.collectedAt)
        : null;
      writeJson(relativePath, record);
      appendJsonl("data/rfqs/events.jsonl", { ...record, agentInput: undefined, rfq: { ...record.rfq, detailText: undefined } });
      state.seen[hydrated.id] = {
        at: record.createdAt,
        status: quote.status,
        contactStatus: record.submission.status,
        draftPath: path.relative(process.cwd(), outputPath)
      };
      records.push({
        id: hydrated.id,
        title: hydrated.title,
        categoryId: analysis.categoryId,
        quoteStatus: quote.status,
        contactStatus: record.submission.status,
        outputPath
      });
    }
    saveState(state);
    const cycleCompletedAt = new Date().toISOString();
    return {
      cycleStartedAt,
      cycleCompletedAt,
      cycleDurationMs: Date.parse(cycleCompletedAt) - Date.parse(cycleStartedAt),
      scanned: unique.length,
      newCandidates: candidates.length,
      records
    };
  } finally {
    if (createdPage) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
