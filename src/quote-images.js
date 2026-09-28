import fs from "node:fs";
import path from "node:path";

const DRAFT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export function buyerRfqUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "sourcing.alibaba.com" && url.pathname === "/rfq_detail.htm"
      && !url.username && !url.password && !url.port ? url.href : "";
  } catch { return ""; }
}

function entries(record) {
  const rfq = record?.rfq || {};
  return Array.isArray(rfq.imageAssets) && rfq.imageAssets.length ? rfq.imageAssets
    : Array.isArray(rfq.imagePaths) ? rfq.imagePaths.map((filePath) => ({ filePath })) : [];
}

/** 只用保存的图片文件名，在当前工作区相应 RFQ 的 images 目录中定位。
 * 旧草稿可能来自另一个电脑，不能直接使用其中记录的绝对路径；realpath
 * 检查同时挡住符号链接跳出目录。返回值只供本地服务读取，不发给网页。
 */
export function quoteImageFile(workspace, record, index) {
  const rfqId = record?.rfq?.id;
  if (!DRAFT_ID.test(rfqId || "") || !Number.isInteger(index) || index < 0 || index >= 32) return null;
  const asset = entries(record)[index];
  if (!asset || typeof asset.filePath !== "string") return null;
  const name = path.basename(asset.filePath);
  const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (!type || name === "." || name === "..") return null;
  try {
    const directory = fs.realpathSync(path.join(workspace, "data/rfqs", rfqId, "images"));
    const file = fs.realpathSync(path.join(directory, name));
    if (!file.startsWith(`${directory}${path.sep}`) || !fs.statSync(file).isFile()) return null;
    return { file, type };
  } catch { return null; }
}

export function quoteImages(workspace, record) {
  return entries(record).slice(0, 32).flatMap((asset, index) => quoteImageFile(workspace, record, index)
    ? [{ index, label: asset.capture === "element-screenshot" ? "附件截图" : "买家图片" }] : []);
}

/** 图片请求只接受草稿 ID 和图片序号，不接受前端传入的本机路径。 */
export function readQuoteImage(workspace, draftId, index) {
  if (!DRAFT_ID.test(draftId || "")) return null;
  try {
    const drafts = fs.realpathSync(path.join(workspace, "data/drafts"));
    const recordFile = fs.realpathSync(path.join(drafts, `${draftId}.json`));
    if (!recordFile.startsWith(`${drafts}${path.sep}`)) return null;
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    return quoteImageFile(workspace, record, index);
  } catch { return null; }
}
