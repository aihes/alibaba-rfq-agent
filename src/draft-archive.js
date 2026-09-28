import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
const archiveFile = (workspace) => path.join(workspace, "data/case-catalog/ops/archived-drafts.json");
export const canArchiveDraft = (status) => ["not_submitted", "skipped", "plugin_prepared_not_submitted", "dry_run_not_submitted"].includes(status);

/** 把不再需要的草稿移出工作台，而不是删除 RFQ、报价依据、截图或事件。
 * submitted / 回填 / 状态不明的记录仍可能是对外动作证据，禁止移出。
 */
export function readDraftArchive(workspace) {
  const file = archiveFile(workspace);
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data?.version !== 1 || !data.drafts || typeof data.drafts !== "object" || Array.isArray(data.drafts))
    throw new Error("草稿整理记录格式无效，请检查 archived-drafts.json");
  return Object.fromEntries(Object.entries(data.drafts).filter(([id, entry]) => validId(id) &&
    typeof entry?.archivedAt === "string" && Number.isFinite(Date.parse(entry.archivedAt))));
}

export function setDraftArchived(workspace, id, archived) {
  if (!validId(id) || typeof archived !== "boolean") throw new Error("草稿整理参数无效");
  const directory = path.join(workspace, "data/drafts");
  const resolved = fs.realpathSync(path.join(directory, `${id}.json`));
  if (!resolved.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error("草稿文件不在允许范围内");
  const record = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (archived && !canArchiveDraft(record.submission?.status))
    throw new Error("这条记录涉及浏览器报价动作或状态不明，请保留在列表中核对");
  const drafts = readDraftArchive(workspace);
  if (archived) drafts[id] = { archivedAt: new Date().toISOString() };
  else delete drafts[id];
  const file = archiveFile(workspace);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, drafts }, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
  return { id, archived, archivedAt: drafts[id]?.archivedAt || null };
}
