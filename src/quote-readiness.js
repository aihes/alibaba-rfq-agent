const categoryNames = {
  kraft_food_bag: "牛皮纸食品袋", tumbler_40oz: "40oz 保温杯", corrugated_rsc: "瓦楞运输箱",
  paper_shopping_bag: "纸质购物袋", cloth_bag: "布袋", folding_carton: "折叠纸盒"
};
const fieldNames = {
  quantity: "采购数量", widthMm: "宽度 mm", heightMm: "高度 mm", bottomMm: "底宽 mm",
  lengthMm: "长度 mm", capacityOz: "容量 oz", gsm: "克重 gsm", material: "材质",
  greaseproof: "防油要求", printing: "印刷工艺", flute: "楞型", color: "颜色"
};

function line(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function priceBlockReason(quote) {
  if (quote?.status === "quoted") return "已形成明确报价，仍需逐单审核。";
  if (quote?.status === "conditional_quote") return "本地规则只给出了条件价格；工艺、材质或数量条件尚待核实。";
  const reason = String(quote?.reason || "");
  if (reason.includes("no normalized deterministic pricing rule")) return "这个品类尚无可执行的当前价格规则。";
  if (reason.includes("outside the validated food-bag scenario")) return "食品袋的尺寸、材料、防油要求或工艺未与已核价场景完全匹配。";
  if (reason.includes("validated quantity")) return "采购数量不在已核价的数量档中。";
  if (reason.includes("does not explicitly match the validated 40oz")) return "保温杯的材质、印刷或容量未与已核价场景完全匹配。";
  if (reason.includes("Only the validated 310x235x165mm")) return "纸箱的尺寸、楞型、印刷或数量未与已核价场景完全匹配。";
  if (reason.includes("Quantity is missing")) return "采购数量尚未确认。";
  return "这条需求尚无适用的已核实价格。";
}

/** Buyer/model text is evidence for a human inquiry, never a price source.
 * The copyable request contains only extracted product facts and asks a
 * supplier for a fresh price; no historical or operator quote is reused. */
export function assessQuoteReadiness(record) {
  const { rfq = {}, analysis = {}, quote = {} } = record || {};
  const missing = (Array.isArray(analysis.missingRequired) ? analysis.missingRequired : [])
    .map((value) => line(value, 100)).filter(Boolean).slice(0, 12);
  const risks = (Array.isArray(analysis.riskFlags) ? analysis.riskFlags : [])
    .map((value) => line(value, 250)).filter(Boolean).slice(0, 12);
  const buyerQuestions = (Array.isArray(analysis.buyerQuestions) ? analysis.buyerQuestions : [])
    .map((value) => line(value, 300)).filter(Boolean).slice(0, 3);
  const categoryId = analysis.categoryId;
  const quantity = Number(analysis.fields?.quantity || rfq.quantity);
  const supported = Boolean(categoryNames[categoryId]);
  const reason = priceBlockReason(quote);
  const state = !supported ? "unsupported" : quote.status === "quoted" ? "priced"
    : missing.length || !Number.isSafeInteger(quantity) || quantity <= 0 ? "buyer_details_needed"
      : "current_price_needed";
  const fields = Object.entries(fieldNames).flatMap(([key, label]) => {
    if (key === "quantity") return [];
    const value = analysis.fields?.[key];
    if (value == null || value === "") return [];
    return [`- ${label}：${typeof value === "boolean" ? value ? "是" : "否" : line(value)}`];
  });
  const supplierInquiry = supported && quote.status !== "quoted" ? [
    "供应商询价草稿（发送前请核对买家原文及附件）",
    `产品：${line(rfq.title || categoryNames[categoryId])}`,
    `品类：${categoryNames[categoryId]}`,
    `采购数量：${Number.isSafeInteger(quantity) && quantity > 0 ? `${quantity} 件` : "待买家确认"}`,
    "已提取的需求（待核对）：",
    ...(fields.length ? fields : ["- 尚无可核对的规格"]),
    ...(missing.length ? ["待确定规格（可由买家确认，或由供应商提出明确方案供买家选择）：", ...missing.map((value) => `- ${value}`)] : []),
    "请按上述规格和数量确认可销售的 USD EXW 单价、MOQ、一次性费用、价格有效期、交期，以及印刷、配件、包装和认证是否包含。请说明报价来源和确认日期。"
  ].join("\n") : "";
  return { state, reason, missing, risks, buyerQuestions, supplierInquiry };
}
