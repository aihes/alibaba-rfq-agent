# 报价机会通知工具

## 用户使用

在「报价 Agent」开启「机会系统通知」，先点「发送测试通知」。macOS
询问时允许 RFQ 助手通知，在系统设置 → 通知 → RFQ 助手中选择横幅
和声音。专注模式可能隐藏横幅，收到测试通知后再启动持续监控。

扫描完成并保存新草稿后自动检查：当前确定性价格规则仍匹配、美元
数量/单价/总价可核对、无一次性费用、商品描述和交货地点完整、Agent
建议报价且置信度足够、无缺参/风险、仍有报价席位、没有已有报价动作。
合格时通知显示商品、数量、单价和总价，点击打开该草稿供人工复核。

关闭窗口仍在后台运行；退出应用或电脑休眠后无法继续扫描。同一 RFQ
只尝试通知一次，失败也会留下记录。导入历史 CASE 本身不触发提醒。
提醒不会回填、提交或开启浏览器控制。

## 可复用工具契约

工具定义使用标准 JSON Schema，可接入 MCP 或 Agent function calling。
本项目提供 JS、CLI 与本机 HTTP 入口；没有额外启用远程 MCP 服务。

| 工具名 | 参数 | 返回 |
| --- | --- | --- |
| `notifications.status` | `{}` | `enabled`、`last` |
| `notifications.test` | `{}` | `status`、`detail` |
| `notifications.opportunity` | `{ "draftId": "rfq-id" }` | `status`、可选 `detail` |

返回状态：`accepted` 系统接受请求；`requested` 尚未确认系统接受；
`failed` 发送失败；`unsupported` 系统不支持；`disabled` 开关关闭；
`not_opportunity` 未通过资格检查；`duplicate` 此 RFQ 已尝试过通知。
`accepted` 不等于用户看到了横幅，系统专注模式和通知设置仍会影响显示。

机会工具只接受草稿 ID，读取工作目录内的真实记录并重新检查当前价格
规则。不接受自定义通知 URL、命令、报价对象或调用者声明的 `quoted`。

### JavaScript

```js
import { createNotificationTools } from "./src/notification-tools.js";
const tools = createNotificationTools({ workspace: "/path/to/workspace" });
console.log(tools.definitions); // JSON Schema，可注册到已有工具系统
await tools.call("notifications.opportunity", { draftId: "rfq-id" });
```

业务流水线也可直接调用 `notifyOpportunity(record, config)`。
Electron 主进程使用 `createNativeNotifier({ Notification, openDraft })`
适配原生通知。`openDraft` 仅负责打开本机草稿；适配器不持有 shell
执行权。测试可注入 `send`，不需要真的弹通知或操作浏览器。

### 命令行

```bash
npm run notifications:tool -- --list
npm run notifications:tool -- --tool notifications.status
npm run notifications:tool -- --tool notifications.test
npm run notifications:tool -- --tool notifications.opportunity --draft rfq-id
```

外部工具复用正在运行的桌面版时，通过工作目录的连接文件调用：

```bash
npm run notifications:tool -- --connection "$HOME/Library/Application Support/RFQ 助手/workspace/data/case-catalog/ops/notification-tools-connection.json" --tool notifications.test
```

此命令由开发工具运行；普通用户只需应用按钮，无需 Node。Windows
工作目录显示在「应用设置」，连接文件的相对位置与 macOS 相同。
通过 `RFQ_WORKSPACE_DIR` 指定工作目录时 CLI 会自动发现连接文件。

### HTTP

- `GET /api/tools/notifications`：工具定义、当前开关与最近发送结果。
- `POST /api/tools/notifications`：`{"tool":"notifications.opportunity","arguments":{"draftId":"rfq-id"}}`。
- 仅绑定 `127.0.0.1`。桌面端端口由应用管理，无需用户记忆。
- 外部本地工具读取连接文件中的 `url` 与 `token`，以 `X-RFQ-Tool`
  请求头发送令牌；页面请求沿用同源与 `X-Case-Console: 1` 检查。
- 令牌只允许调用通知工具，不能用于浏览器控制、报价或模型设置接口。
  每次启动随机生成，连接文件仅本机用户可读，退出时移除，不对网页返回。

## 记录与运行边界

`data/case-catalog/ops/notification-status.json` 保存最近结果；
`notification-state.json` 是汇总索引；`notification-claims/<draftId>.json`
通过 exclusive-create 保证多个进程同时发现同一 RFQ 时仅一个发送。
通知失败不影响草稿保存与后续扫描。私有连接文件不进入安装包。

Electron 的 macOS 原生通知要求应用代码签名。本地包使用 ad-hoc
签名进行测试；正式分发仍需 Developer ID 签名、公证和系统授权。
Windows 版沿用同一工具接口及 Electron 原生通知，实际横幅和激活行为
需要在 Windows 实机验证。CLI 的离线通知助手目前仅支持 macOS。

[Electron Notification 官方说明](https://www.electronjs.org/docs/latest/api/notification)
