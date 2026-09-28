/**
 * 工作台只展示确实有报价内容的草稿。needs_review 没有可核实价格；
 * conditional_quote 的金额依赖未确认条件，也不能当作明确报价。
 * 这里仅决定列表可见性，不授予浏览器回填或提交权限。
 */
export function hasDefiniteQuote(record) {
  const quote = record?.quote;
  const draft = record?.draft;
  if (quote?.status !== "quoted" || quote.currency !== "USD" || !draft) return false;
  const { quantity, unitPriceUsd, totalUsd } = quote;
  const setupUsd = quote.setupUsd ?? 0;
  if (![quantity, unitPriceUsd, totalUsd, setupUsd].every(Number.isFinite)
    || quantity <= 0 || unitPriceUsd <= 0 || totalUsd <= 0 || setupUsd < 0
    || Math.abs(quantity * unitPriceUsd + setupUsd - totalUsd) > 0.011) return false;
  return [quote.tradeTerm, draft.productName, draft.productDetails, draft.buyerMessage]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}
