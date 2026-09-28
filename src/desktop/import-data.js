import fs from "node:fs";
import path from "node:path";

/** 迁移指定证据目录，不迁移开发环境或操作权限。旧绝对路径仅在已知
 * 路径字段中转换，买家文字和报价依据原样保留。先核对所有冲突，再写
 * 新文件；重复导入可复用相同内容，不修改已有 CASE。
 */
export function importCaseData(sourceDirectory, workspace) {
  const source = fs.realpathSync(sourceDirectory), dest = path.join(workspace, "data");
  const checkDestination = (file) => {
    let current = file;
    while (current !== workspace && current.startsWith(workspace + path.sep)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("目标数据目录包含符号链接，无法安全导入");
      current = path.dirname(current);
    }
  };
  checkDestination(dest);
  if (source === dest || source.startsWith(workspace + path.sep) || workspace.startsWith(source + path.sep)) throw new Error("请选择原项目的 data 文件夹");
  const selected = ["drafts", "rfqs", "runs", "reference-materials"].filter((name) => fs.existsSync(path.join(source, name)));
  if (!selected.length) throw new Error("此文件夹没有可导入的 RFQ 或报价材料");
  const files = [];
  const relocate = (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.replaceAll("\\", "/"), index = normalized.lastIndexOf("/data/");
    if (index < 0 || /^https?:/i.test(normalized)) return value;
    const tail = normalized.slice(index + 6), candidate = path.resolve(dest, tail);
    return candidate.startsWith(dest + path.sep) && fs.existsSync(path.resolve(source, tail)) ? candidate : value;
  };
  const draftBytes = (bytes) => {
    try {
      const record = JSON.parse(bytes.toString("utf8"));
      if (record.rfq?.imagePaths) record.rfq.imagePaths = record.rfq.imagePaths.map(relocate);
      for (const asset of record.rfq?.imageAssets || []) asset.filePath = relocate(asset.filePath);
      if (record.submission?.screenshotPath) record.submission.screenshotPath = relocate(record.submission.screenshotPath);
      if (record.submission?.submittedScreenshotPath) record.submission.submittedScreenshotPath = relocate(record.submission.submittedScreenshotPath);
      return Buffer.from(JSON.stringify(record, null, 2));
    } catch { return bytes; }
  };
  const walk = (directory, relative) => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("数据目录包含符号链接，请先移除再导入");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const from = path.join(directory, entry.name), rel = path.join(relative, entry.name), to = path.join(dest, rel);
      checkDestination(to);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("数据包含符号链接或特殊文件，请先移除再导入");
      if (entry.isDirectory()) walk(from, rel);
      else {
        let bytes = fs.readFileSync(from);
        if (rel.startsWith(`drafts${path.sep}`) && rel.endsWith(".json")) bytes = draftBytes(bytes);
        if (fs.existsSync(to)) {
          if (fs.lstatSync(to).isSymbolicLink() || !bytes.equals(fs.readFileSync(to))) throw new Error(`已有同名数据，未覆盖：${rel}`);
        } else files.push({ to, bytes });
      }
    }
  };
  for (const name of selected) walk(path.join(source, name), name);
  for (const { to, bytes } of files) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes, { flag: "wx" }); }
  return { importedFiles: files.length };
}
