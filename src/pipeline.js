import path from "node:path";
import { buildAgentInputAudit } from "./agent-audit.js";
import { executeAutoContact } from "./auto-contact.js";
import { connectBrowser } from "./browser.js";
import { classifyRfq } from "./classifier.js";
import { collectSearchPage, hydrateDetail, keywordPrefilter } from "./collector.js";
import { createDraft } from "./drafter.js";
import { priceRfq } from "./pricing.js";
import { notifyOpportunity } from "./notifications.js";
import { reportProgress, reportProgressResult } from "./progress.js";
import { appendJsonl, loadState, saveState, sleep, writeJson } from "./utils.js";
import { publishedWithinMinutes } from "./rfq-time.js";

export async function runCycle(config) {
  const cycleStartedAt = new Date().toISOString();
  const state = loadState();
  const connectStage = reportProgress("connect", "正在连接应用内浏览器", {}, { target: "应用内 Alibaba 浏览器", task: "读取 RFQ；不提交报价" });
  const { browser, page, createdPage } = await connectBrowser(config);
  reportProgressResult(connectStage, { connected: true, pageReady: true });
  const collected = [];
  try {
    for (const [index, searchTerm] of config.searchTerms.entries()) {
      const searchStage = reportProgress("search", `正在搜索：${searchTerm}`, { categoryIndex: index + 1, categoryTotal: config.searchTerms.length },
        { searchTerm, recentRfqMinutes: config.recentRfqMinutes });
      const cards = await collectSearchPage(page, config, searchTerm);
      reportProgressResult(searchStage, { count: cards.length, cards: cards.map(({ id, title, summary, quantityText, country, publishedText, publishedAt }) =>
        ({ id, title, summary, quantityText, country, publishedText, publishedAt })) });
      collected.push(...cards);
      await sleep(config.navigationDelayMs);
    }

    const unique = [...new Map(collected.map((rfq) => [rfq.id, rfq])).values()];
    // 每张卡片的相对发布时间以它被读取的时刻为基准；跨多个品类的
    // 一轮扫描可能持续很久，不能再用整轮开始时间判断它是否够新。
    const recent = unique.filter((rfq) => publishedWithinMinutes(rfq, config.recentRfqMinutes, new Date(rfq.collectedAt)));
    const candidates = recent
      .filter((rfq) => !state.seen[rfq.id])
      .map((rfq) => ({ rfq, prefilter: keywordPrefilter(rfq, config.supportedCategories) }))
      .filter((entry) => entry.prefilter.length > 0);
    const filterStage = reportProgress("filter", `扫描到 ${unique.length} 条 RFQ，${candidates.length} 条进入分析`,
      { itemIndex: 0, itemTotal: candidates.length },
      { scanned: collected.length, unique: unique.length, recent: recent.length,
        unknownPublishedAt: unique.filter((rfq) => !rfq.publishedAt).length,
        recentRfqMinutes: config.recentRfqMinutes, previouslySeen: Object.keys(state.seen).length });
    reportProgressResult(filterStage, { candidates: candidates.map(({ rfq, prefilter }) =>
      ({ id: rfq.id, title: rfq.title, summary: rfq.summary, publishedText: rfq.publishedText,
        publishedAt: rfq.publishedAt, prefilter })) });

    const records = [];
    for (const [index, { rfq, prefilter }] of candidates.entries()) {
      const processingStartedAt = new Date().toISOString();
      const detailStartedAt = new Date().toISOString();
      const detailStage = reportProgress("detail", "正在读取 RFQ 详情与附件", { itemIndex: index + 1, itemTotal: candidates.length },
        { rfqId: rfq.id, title: rfq.title, summary: rfq.summary, quantityText: rfq.quantityText, country: rfq.country });
      const hydrated = await hydrateDetail(page, rfq, config);
      reportProgressResult(detailStage, { rfqId: hydrated.id, detailText: hydrated.detailText,
        images: (hydrated.imageAssets || []).map(({ ocrStatus, ocrText, ocrProvider }) => ({ ocrStatus, ocrText, ocrProvider })) });
      const detailCompletedAt = new Date().toISOString();
      const analysisStartedAt = new Date().toISOString();
      const classifierAudit = buildAgentInputAudit(config, hydrated);
      const analysisStage = reportProgress("analysis", "正在调用模型分析需求", { itemIndex: index + 1, itemTotal: candidates.length },
        { rfqId: hydrated.id, provider: classifierAudit.provider, requestedModel: classifierAudit.requestedModel,
          prompt: classifierAudit.classifier.prompt, inputJson: classifierAudit.classifier.inputJson });
      const analysis = await classifyRfq(config, hydrated);
      reportProgressResult(analysisStage, { rfqId: hydrated.id, analysis });
      const analysisCompletedAt = new Date().toISOString();
      const pricingStage = reportProgress("pricing", "正在按本地规则核对价格", { itemIndex: index + 1, itemTotal: candidates.length },
        { rfqId: hydrated.id, quantity: hydrated.quantity, categoryId: analysis.categoryId, fields: analysis.fields,
          missingRequired: analysis.missingRequired, riskFlags: analysis.riskFlags });
      const quote = priceRfq(hydrated, analysis, config.pricing);
      reportProgressResult(pricingStage, { rfqId: hydrated.id, quote });
      const pricingCompletedAt = new Date().toISOString();
      const draftStartedAt = new Date().toISOString();
      const draftStage = reportProgress("draft", "正在生成报价草稿", { itemIndex: index + 1, itemTotal: candidates.length },
        { rfqId: hydrated.id, title: hydrated.title, quote, buyerQuestions: analysis.buyerQuestions });
      const draft = await createDraft(config, hydrated, analysis, quote);
      reportProgressResult(draftStage, { rfqId: hydrated.id, draft,
        note: draft ? "已生成拟回复；仍需逐单核对，未发送" : "价格或规格未达生成条件，未编写买家回复" });
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
      const saveStage = reportProgress("save", "正在保存草稿与运行记录", { itemIndex: index + 1, itemTotal: candidates.length },
        { rfqId: hydrated.id, quoteStatus: quote.status, draftPrepared: Boolean(draft) });
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
      // 草稿已落盘后才发送系统通知。通知失败只记录状态，不中断扫描，
      // 也不会绕过控制台的逐单回填/提交确认。
      record.notification = await notifyOpportunity(record, config);
      writeJson(relativePath, record);
      reportProgressResult(saveStage, { rfqId: hydrated.id, fileName: `${hydrated.id}.json`,
        submissionStatus: record.submission.status, notificationStatus: record.notification?.status || "not_sent" });
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
    const completeStage = reportProgress("complete", `本轮完成：扫描 ${unique.length} 条，生成 ${records.length} 份记录`,
      { itemIndex: records.length, itemTotal: candidates.length }, { scanned: unique.length, candidates: candidates.length });
    reportProgressResult(completeStage, { records: records.map(({ id, title, quoteStatus, contactStatus }) =>
      ({ id, title, quoteStatus, contactStatus })) });
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
