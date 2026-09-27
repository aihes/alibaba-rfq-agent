import fs from "node:fs";
import path from "node:path";
import { notifyOpportunity, testNotification, sendNativeNotification } from "./notifications.js";

/** 标准 JSON 工具定义，可直接映射为 MCP/Agent function calling。
 * 调用方只提交草稿 ID；工具从本地读取真实记录，不接受调用方伪造的
 * quoted 状态、报价金额或通知跳转链接。
 */
export const notificationToolDefinitions = [
  { name: "notifications.status", description: "读取通知开关和最近发送结果，不操作浏览器", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "notifications.test", description: "在通知开关开启时发送系统测试通知", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "notifications.opportunity", description: "核验本地报价草稿，合格且未提醒过时发送复核通知", inputSchema: {
    type: "object", properties: { draftId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" } }, required: ["draftId"], additionalProperties: false } }
];

export function createNotificationTools({ workspace, file = path.join(workspace, "data/case-catalog/ops/settings.json"),
  send = sendNativeNotification, config = () => ({
    ...JSON.parse(fs.readFileSync(path.join(workspace, "config/default.json"))),
    pricing: JSON.parse(fs.readFileSync(path.join(workspace, "config/pricing-rules.json"))) }) }) {
  const read = (name, fallback) => fs.existsSync(name) ? JSON.parse(fs.readFileSync(name, "utf8")) : fallback;
  return {
    definitions: notificationToolDefinitions,
    status() { return { enabled: read(file, {}).notificationsEnabled === true,
      last: read(path.join(path.dirname(file), "notification-status.json"), null) }; },
    async call(name, args = {}) {
      if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("工具参数必须是 JSON 对象");
      const definition = notificationToolDefinitions.find((tool) => tool.name === name);
      if (!definition || Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) throw new Error("通知工具或参数无效");
      if (name === "notifications.status") return this.status();
      if (name === "notifications.test") return testNotification({ file, send });
      if (typeof args.draftId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(args.draftId)) throw new Error("草稿 ID 无效");
      const dir = path.join(workspace, "data/drafts");
      const target = fs.realpathSync(path.join(dir, `${args.draftId}.json`));
      if (!target.startsWith(fs.realpathSync(dir) + path.sep)) throw new Error("草稿超出允许目录");
      const record = read(target);
      if (record?.rfq?.id !== args.draftId) throw new Error("草稿 ID 与文件不一致");
      return notifyOpportunity(record, typeof config === "function" ? config() : config, { file, send });
    }
  };
}
