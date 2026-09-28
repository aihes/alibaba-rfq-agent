/** 旧版运行只记录阶段名称。若同一轮的草稿还在，可从已保存的业务证据
 * 还原该阶段实际使用或产生的内容；不能还原的逐页检索细节要明确说明。
 * 这里展示的是请求/决策记录，不把模型内部推理当成可见证据。
 */
export function stageEvidenceFromRecord(event, summary, record) {
  if (["detail", "analysis", "pricing", "draft", "save"].includes(event.stage) && !record)
    return { source: "旧版阶段记录", input: null, output: null,
      note: "本轮草稿未保存或已移走，无法从旧版阶段流水还原这一阶段。" };
  const rfq = record?.rfq || {};
  const analysis = record?.analysis || null;
  const quote = record?.quote || null;
  const draft = record?.draft || null;
  const audit = record?.agentInput || {};
  const runRecords = (summary?.records || []).map(({ id, title, quoteStatus, contactStatus }) => ({ id, title, quoteStatus, contactStatus }));
  const common = { source: "从本轮已保存的草稿还原", note: "旧版阶段流水未单独保存输入/输出；下列内容来自该轮最终草稿。" };
  switch (event.stage) {
    case "connect": return { source: "旧版阶段记录", input: { target: "应用内 Alibaba 浏览器" },
      output: { note: "连接诊断未单独保存；任务已进入后续阶段时才可确认曾继续运行。" } };
    case "search": return { source: "旧版阶段记录", input: { search: event.message?.replace(/^正在搜索[：:]\s*/, "") || "未记录" },
      output: { note: "本次每个搜索词的结果未单独保存。", runScannedTotal: summary?.scanned ?? null } };
    case "filter": return { source: "本轮运行摘要", input: { scanned: summary?.scanned ?? null },
      output: { newCandidates: summary?.newCandidates ?? null, savedRecords: runRecords } };
    case "detail": return { ...common, input: { rfqId: rfq.id, title: rfq.title, summary: rfq.summary, quantityText: rfq.quantityText },
      output: { detailText: rfq.detailText || "未保存详情正文", imageEvidence: (rfq.imageAssets || []).map(({ ocrStatus, ocrText, ocrProvider }) => ({ ocrStatus, ocrText, ocrProvider })) } };
    case "analysis": return { ...common, input: { provider: audit.provider, requestedModel: audit.requestedModel,
      prompt: audit.classifier?.prompt, inputJson: audit.classifier?.inputJson }, output: { analysis } };
    case "pricing": return { ...common, input: { rfqId: rfq.id, quantity: rfq.quantity, fields: analysis?.fields,
      missingRequired: analysis?.missingRequired, riskFlags: analysis?.riskFlags }, output: { quote } };
    case "draft": return { ...common, input: { rfqId: rfq.id, title: rfq.title, quote,
      buyerQuestions: analysis?.buyerQuestions }, output: { draft, note: draft ? "拟回复尚未代表发送" : "本轮未生成买家回复" } };
    case "save": return { ...common, input: { rfqId: rfq.id, quoteStatus: quote?.status },
      output: { fileName: rfq.id ? `${rfq.id}.json` : null, submissionStatus: record?.submission?.status,
        notificationStatus: record?.notification?.status || "未记录" } };
    case "complete": return { source: "本轮运行摘要", input: { scanned: summary?.scanned, newCandidates: summary?.newCandidates },
      output: { savedRecords: runRecords } };
    default: return { source: "旧版阶段记录", input: null, output: null, note: "这一阶段没有可还原的输入/输出。" };
  }
}
