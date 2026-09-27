#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { projectDir } from "../src/paths.js";
import { createNotificationTools, notificationToolDefinitions } from "../src/notification-tools.js";

// 面向其他本地工具的 JSON CLI。输入范围固定，不接受自定义通知脚本、
// URL、金额或完整 RFQ 对象；机会必须来自 workspace 内的真实草稿。
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (flag === "--list" && process.argv.length === 3) { options.list = true; break; }
    if (!["--tool", "--draft", "--connection"].includes(flag) || !process.argv[i + 1] || options[flag]) throw new Error("参数无效：使用 --tool、--draft、--connection 或 --list");
    options[flag] = process.argv[i + 1];
  }
  let result;
  const tool = options["--tool"] || "notifications.status";
  const args = options["--draft"] ? { draftId: options["--draft"] } : {};
  if (options.list) result = { tools: notificationToolDefinitions };
  else {
    const file = options["--connection"] || path.join(projectDir, "data/case-catalog/ops/notification-tools-connection.json");
    if (options["--connection"] || fs.existsSync(file)) {
      const connection = JSON.parse(fs.readFileSync(file, "utf8"));
      const url = new URL(connection.url);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password
        || url.pathname !== "/api/tools/notifications" || url.search || url.hash
        || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error("通知工具连接信息无效");
      const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(25000),
        headers: { "Content-Type": "application/json", "X-RFQ-Tool": connection.token },
        body: JSON.stringify({ tool, arguments: args }) });
      result = await response.json();
      if (!response.ok) throw new Error(result.error || "通知工具调用失败");
    } else result = await createNotificationTools({ workspace: projectDir }).call(tool, args);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: error.code ? "通知工具连接或草稿文件无法读取" : error.message === "fetch failed" ? "RFQ 助手未运行或工具接口无法连接" : error.message }));
  process.exitCode = 1;
}
