import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_VISIBLE_EVENTS = 120;
const MAX_READ_BYTES = 1024 * 1024;

// 阶段证据只存任务明确传入的业务字段；限制层级和大小，防止异常网页正文
// 把轮询接口及本机事件文件撑满。浏览器令牌和认证数据不得传入这里。
function bounded(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 12000);
  if (depth >= 6) return "[层级过深]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => bounded(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40)
    .filter(([key]) => !/cookie|password|token|authorization|secret|api.?key/i.test(key))
    .map(([key, item]) => [key, bounded(item, depth + 1)]));
  return String(value).slice(0, 200);
}

/** 任务的阶段流水单独追加，最新状态文件仍供轻量轮询。阶段流水可包含
 * 买家需求、模型请求和业务结果，供本机工作台审阅；调用方不得传入浏览器
 * 身份数据或密钥，bounded() 也会过滤常见的敏感字段名。
 */
export function progressEventsFile(progressFile) { return `${progressFile}.events.jsonl`; }

export function readProgressEvents(progressFile, limit = MAX_VISIBLE_EVENTS) {
  const file = progressEventsFile(progressFile);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, MAX_READ_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      let lines = buffer.toString("utf8").split("\n");
      // 只读取尾部时，第一行可能从 JSON 中间开始；丢掉残缺行。
      if (size > length) lines = lines.slice(1);
      const raw = lines.filter(Boolean).flatMap((line) => {
        try { const value = JSON.parse(line); return value?.stage && Number.isFinite(Date.parse(value?.at)) ? [value] : []; }
        catch { return []; }
      });
      const events = [];
      const byId = new Map();
      for (const item of raw) {
        if (item.phase === "result") {
          const original = byId.get(item.eventId);
          if (original) { original.output = item.output; original.completedAt = item.at; }
        } else {
          events.push(item);
          if (item.eventId) byId.set(item.eventId, item);
        }
      }
      return { events: events.slice(-limit), truncated: size > length || events.length > limit };
    } finally { fs.closeSync(fd); }
  } catch { return { events: [], truncated: false }; }
}

/** 工作进程向本次运行的本机侧车文件报告阶段。业务输入可能包含模型
 * 提示词或买家正文；Cookie、令牌等认证数据不得作为输入。原子替换让
 * 工作台轮询时不会读到半截 JSON。
 * CLI 独立运行时没有 RFQ_PROGRESS_FILE，仍保持原有输出格式。
 */
export function reportProgress(stage, message, counts = {}, input = null) {
  const file = process.env.RFQ_PROGRESS_FILE;
  if (!file) return null;
  const clean = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").slice(0, 160);
  const number = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const progress = {
    eventId: crypto.randomUUID(), stage: clean(stage), message: clean(message), at: new Date().toISOString(),
    categoryIndex: number(counts.categoryIndex ?? process.env.RFQ_PROGRESS_CATEGORY_INDEX),
    categoryTotal: number(counts.categoryTotal ?? process.env.RFQ_PROGRESS_CATEGORY_TOTAL),
    itemIndex: number(counts.itemIndex), itemTotal: number(counts.itemTotal),
    ...(input == null ? {} : { input: bounded(input) })
  };
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(progress), { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.appendFileSync(progressEventsFile(file), `${JSON.stringify(progress)}\n`, { mode: 0o600 });
    return progress.eventId;
  } catch {
    // 进度展示不能中断扫描、分析或报价，也不能把文件路径写进客户数据。
    try { fs.rmSync(temp, { force: true }); } catch {}
    return null;
  }
}

/** 任务完成某一阶段后，把产出附在原阶段事件上；读取时按 eventId 合并，
 * 页面始终只显示一行阶段。写入失败不能改变扫描或报价的业务结果。
 */
export function reportProgressResult(eventId, output) {
  const file = process.env.RFQ_PROGRESS_FILE;
  if (!file || !eventId) return;
  try {
    fs.appendFileSync(progressEventsFile(file), `${JSON.stringify({ phase: "result", eventId,
      stage: "result", at: new Date().toISOString(), output: bounded(output) })}\n`, { mode: 0o600 });
  } catch {}
}
