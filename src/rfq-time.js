/** Alibaba shows publication time as both relative and localized text. Keep the
 * original string on every RFQ; this parser only adds a best-effort ISO value.
 * An unknown value must never be treated as a recent publication. */
export function parsePublishedAt(value, now = new Date()) {
  const text = String(value || "").trim();
  if (!text) return null;
  // Alibaba's Chinese list cards use “发布日期:7 小时前”. Strip the whole
  // label before parsing; leaving “日期” in front hides every relative time.
  const normalized = text.replace(/^(?:posted|published|发布(?:日期|时间|于)?)\s*(?:on|at)?\s*[:：]?\s*/i, "").trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) {
    const iso = Date.parse(normalized);
    return Number.isFinite(iso) ? new Date(iso).toISOString() : null;
  }
  if (/^(?:just now|刚刚|现在)$/i.test(normalized)) return now.toISOString();
  const relative = normalized.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|秒钟?|分钟?|小时|天|周)\s*(?:ago|前)?/i);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const seconds = /^(?:sec|秒)/.test(unit) ? 1 : /^(?:min|分)/.test(unit) ? 60
      : /^(?:hour|hr|小)/.test(unit) ? 3600 : /^(?:week|周)/.test(unit) ? 604800 : 86400;
    return new Date(now.getTime() - Number(relative[1]) * seconds * 1000).toISOString();
  }
  const dayLabel = normalized.match(/^(today|yesterday|今天|昨天)(?:\s*(?:at)?\s*(\d{1,2}):(\d{2}))?/i);
  if (dayLabel) {
    if (!dayLabel[2]) return null;
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (/^(yesterday|昨天)/i.test(dayLabel[1]) ? 1 : 0),
      Number(dayLabel[2] || 0), Number(dayLabel[3] || 0));
    return date.toISOString();
  }
  const numeric = normalized.match(/^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (numeric) {
    if (!numeric[4]) return null;
    const date = new Date(Number(numeric[1] || now.getFullYear()), Number(numeric[2]) - 1, Number(numeric[3]),
      Number(numeric[4] || 0), Number(numeric[5] || 0), Number(numeric[6] || 0));
    return Number.isFinite(date.getTime()) && date.getMonth() === Number(numeric[2]) - 1
      && date.getDate() === Number(numeric[3]) ? date.toISOString() : null;
  }
  const absolute = Date.parse(normalized);
  return Number.isFinite(absolute) ? new Date(absolute).toISOString() : null;
}

export function publishedWithinMinutes(rfq, minutes, now = new Date()) {
  if (minutes === 0) return true;
  const published = Date.parse(rfq.publishedAt || "");
  if (!Number.isFinite(published)) return false;
  const age = now.getTime() - published;
  return age >= -5 * 60_000 && age <= minutes * 60_000;
}

export function parseRecentMinutes(value) {
  const minutes = Number(value);
  if (value === "" || value == null || !Number.isInteger(minutes) || minutes < 0 || minutes > 525600) {
    throw new Error("最近发布时间必须是 0 至 525600 的整数分钟；0 表示不限时间");
  }
  return minutes;
}
