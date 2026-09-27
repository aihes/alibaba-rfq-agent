import path from "node:path";
import { fileURLToPath } from "node:url";

// 安装包资源只读，用户数据可写。开发模式仍使用仓库目录；桌面版由
// Electron 在加载业务模块前指定 workspace，不能向 .app 内写入 CASE。
export const resourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const projectDir = process.env.RFQ_WORKSPACE_DIR
  ? path.resolve(process.env.RFQ_WORKSPACE_DIR) : resourceDir;
