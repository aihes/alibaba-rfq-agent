# Alibaba RFQ Agent（现有 Chrome + 本地 Claude Agent SDK + 确定性报价）

这是一个面向 `sourcing.alibaba.com` 的安全 PoC：

1. 通过 Midscene Chrome Bridge 复用用户日常 Chrome 中已经登录的 Alibaba 标签页，不创建或读取独立浏览器 Profile。
2. 定时搜索 RFQ，读取标题、描述、数量、国家、剩余报价席位、详情页和报价页 URL。
3. 下载详情正文中的产品图/附件图到 RFQ 独立目录，再用本地 Claude Agent SDK 调用已安装的 Claude Code，进行类目识别、图片规格抽取、缺参和风险判断。
4. **价格不由 Claude 生成**。价格只能来自版本化的确定性规则；规格不完整或偏离验证场景时返回 `needs_review`。
5. 生成英文报价草稿。默认只保存本地 JSON；`fill` 只回填页面并截图，不提交。
6. 真正提交需要同时设置 `ALLOW_LIVE_SUBMIT=true`，并提供针对 RFQ 和价格生成的精确确认令牌。

## 为什么不让 Claude 直接定价

RFQ 文本常常不完整，也可能包含与任务无关的指令。Claude 适合抽取和写作，不适合充当成本数据库。当前价格引擎只开放三种已经核过的场景和数量点；尺寸或数量不同都会进入人工复核：

- 方底防油牛皮食品袋：验证基准价 `USD 0.019/pc + USD 70 setup`。
- 40oz 304 保温杯：验证基准价 `USD 7.50/pc + USD 170 setup/testing`。
- 0201 瓦楞箱 310×235×165mm：500只条件价 `USD 0.99/pc`；1000只 `USD 0.60/pc`。

白卡纸手提袋、布袋和卡纸彩盒会被识别出来，但在它们的成本规则被标准化前不会自动出价。

## 初始化

当前开箱即用路径以 macOS 为基线（本地 OCR 使用 Vision）。前置条件：Node.js 20+、Google Chrome、Midscene Chrome Bridge 扩展，以及已安装并完成登录的 Claude Code。程序只连接用户现有的 Chrome 标签页；Linux/Windows 需要替换 OCR 适配层。

```bash
git clone <your-repository-url> alibaba-rfq-agent
cd alibaba-rfq-agent
npm ci
cp .env.example .env
npm test
npm run doctor
```

### 仓库自带的 Codex Skill

项目级 Skill 位于 `.agents/skills/alibaba-rfq-agent/SKILL.md`。Codex 在这个仓库中工作时会自动发现它；GitHub 用户只需克隆完整仓库并从仓库目录打开 Codex，不需要安装作者机器上的 `midscene-control-chrome` Skill。需要单独分发时，也可以使用 `skill-packages/alibaba-rfq-agent.skill`。

这个 Skill 调用仓库自己的 `npm run midscene:*` 命令，并通过项目依赖 `@midscene/web` 连接用户已经登录的 Chrome。它不会创建第二个 Chrome Profile，也不依赖作者机器上的绝对路径。

仓库还保留 `plugins/alibaba-rfq-midscene/`，用于需要 MCP 工具界面的 Codex 插件场景；其中也包含对应的插件 Skill。直接克隆运行时，以项目级 Skill 为入口即可。

`.env.example` 使用 `LOCAL_CLAUDE_EXECUTABLE=claude`，程序会从当前 `PATH` 自动解析可执行文件，也兼容 `~/.local/bin/claude`、Homebrew 和 `/usr/local/bin` 的常见安装位置。浏览器登录状态始终留在用户现有 Chrome 中，不复制进项目；真实密钥、买家 RFQ、报价草稿、截图和运行报告只保存在本机，并由 `.gitignore` 排除。

仓库中的 `demo-video/` 当前是独立 Remotion 工程，包含真实浏览器录屏和 RFQ 证据，因此不会进入主仓库。若需要公开演示工程，应先替换为脱敏素材，再单独发布或明确合并其 Git 历史。

默认不需要在项目里填写 API Key：`AGENT_PROVIDER=local-claude-sdk` 会启动 `LOCAL_CLAUDE_EXECUTABLE` 指向的本地 Claude Code，并继承当前 shell 已有的 `ANTHROPIC_BASE_URL`、认证和默认模型。密钥不会写入草稿或日志。无人值守进程默认使用 `LOCAL_CLAUDE_SETTING_SOURCES=none`，避免用户级 Stop Hook 或插件把一次请求反复续成多轮；这不会影响环境变量中的网关和认证。

项目不固定 Claude Code 或模型版本。`LOCAL_CLAUDE_MODEL` 默认留空并继承本地 Claude Code 的配置；如果你使用兼容网关或自定义模型，只填写该网关已经验证过的准确模型标识，不要直接复制其他机器的模型名。

不要仅凭名称假设图片能力。先运行本地无敏感数据的图片自检：

```bash
npm run doctor
```

自检默认用 macOS Vision 在本机做 OCR，再让 Agent SDK/GLM 结构化理解 OCR 结果；只有识别出 `EXW / 150 / 7.5` 才返回 `fixtureMatched: true`。结果会明确标记 `method=local-ocr`、`imageReadStatus=partial`；这类结果只能支持图片里的文字规格，不能推断产品外观。两条路径都失败时才回退到纯文本分类，不会猜图片内容。

不同模型和兼容网关的图片能力并不一致。若使用已经验证的多模态网关，可用下面的命令复测；通过后再为真实 RFQ 启用原图视觉分析：

```bash
IMAGE_ANALYSIS_MODE=agent-read npm run doctor
```

在执行页面回填前，还必须设置 `QUOTE_PORT`：EXW 应填已核实的工厂交货城市/地点，FOB 应填已核实的装运港。脚本不会猜这个值。

## 复用已登录的日常 Chrome（默认）

确保 Midscene Chrome Bridge 扩展已连接，并在 Chrome 中保留至少一个 `sourcing.alibaba.com` 或 `rfqposting.alibaba.com` 标签页。配置：

程序只选择并控制现有 Alibaba 标签页，不读取 Cookie、密码、Local Storage 或 Session Storage。一次扫描期间复用同一标签页，结束后解除控制但不关闭标签页。

## Midscene.js 插件版

独立插件位于 `plugins/alibaba-rfq-midscene/`，同时提供 Codex Skill、MCP 工具和本地 CLI。它把浏览器能力收敛成五个 RFQ 工具：状态、扫描、分析、仅回填、受控提交；不会把任意点击或 JavaScript 执行直接开放给报价 Agent。

```bash
npm run midscene:status
npm run midscene:scan -- --term "corrugated carton box" --max 10
```

每次扫描会自动创建 `data/runs/<run-id>/scan.json` 和 `RUN_REPORT.md`。后续使用该 `scan.json` 执行分析时，真实 RFQ、模型抽取、确定性价格、买家文案和提交状态会追加到同一份报告中。报告明确区分页面事实、模型判断与外部提交证据。

扫描结果保存为 JSON 后，可以分析其中一条：

```bash
npm run midscene:analyze -- --rfq-file /absolute/path/scan.json --index 0
```

真实回填与提交分别使用 `midscene:fill` 和 `midscene:submit`。提交仍要求 `.env` 中的三重开关、策略校验、即时确认布尔值，以及分析结果返回的精确 `submitToken`。

## 运行

单次扫描：

```bash
npm run once
```

每 10 分钟轮询一次：

```bash
npm run watch
```

若 Chrome Bridge 断开、登录失效或 Alibaba 出现 CAPTCHA/安全验证，守护程序会停止并保留已有状态，不会后台反复重试或绕过验证。

结果保存到：

- `data/rfqs/events.jsonl`：扫描事件流水。
- `data/rfqs/<rfq-id>/images/`：从 Alibaba 详情页下载的产品/附件图，最多 4 张、默认每张不超过 5MB。
- `data/drafts/<rfq-id>.json`：类目、抽取字段、报价结论和英文草稿。
- `data/state.json`：去重状态。

## 回填，但不提交

```bash
npm run fill -- --file data/drafts/<rfq-id>.json
```

它会打开该 RFQ 的真实报价表单，填写产品名称、产品详情、贸易条款、已核实的交货地/港口、有效期、数量、单价和买家消息，回读关键字段并保存全页截图，停在“提交报价”之前。

## 受控自动联系买家

自动联系指“提交初次报价并附带买家留言”，已经接入 `once/watch` 主循环。真实环境默认 `AUTO_CONTACT_MODE=off`，不会自行联系任何买家。

先使用只回填不发送的模式观察效果：

```bash
AUTO_CONTACT_MODE=fill
AUTO_CONTACT_CATEGORIES=tumbler_40oz,kraft_food_bag,corrugated_rsc
QUOTE_PORT=已核实的工厂城市或装运港
```

也可以针对一份现有草稿执行策略检查与回填：

```bash
npm run contact -- --file data/drafts/<rfq-id>.json
```

只有同时满足以下条件才会自动处理：

- 确定性价格引擎返回 `quoted`；`conditional_quote` 不允许自动发送。
- 类目在 `AUTO_CONTACT_CATEGORIES` 白名单中。
- Agent 建议报价、置信度达到阈值、无缺参、无风险标记。
- 页面显示还有报价名额，并且报价总额不超过配置上限。
- `QUOTE_PORT` 已核实，买家留言已经生成。
- 当日提交量未达到上限，且该 RFQ 从未尝试过自动提交。

真正自动发送还需要显式设置三重开关：

```bash
AUTO_CONTACT_MODE=submit
ALLOW_LIVE_SUBMIT=true
AUTO_CONTACT_ACK=I_UNDERSTAND_AUTO_QUOTES_ARE_SENT
```

每次提交前都会先写入 `data/auto-contact-state.json`。提交成功后记为 `submitted`；如果点击后无法验证成功，则记为 `needs_manual_review`，后续不会自动重试，避免重复报价。目前自动化覆盖初次 RFQ 报价；买家后续聊天回复仍保留人工发送边界。

## 受保护的真实提交

先执行 `fill` 并人工检查。运行不带确认令牌的 `submit` 时，CLI 只会打印本次所需的精确命令，不会点击：

```bash
npm run submit -- --file data/drafts/<rfq-id>.json
```

确认后，才使用 CLI 打印的完整命令。任何价格变化都会使旧令牌失效。脚本遇到 CAPTCHA、登录失效或无法验证成功页时会立即停止，不会绕过验证或盲目重试。

## 目前页面选择器（2026-09-17 实测）

- RFQ 卡片：`.alife-bc-brh-rfq-list__item`
- 标题：`.brh-rfq-item__subject-link`
- 描述：`.brh-rfq-item__detail`
- 数量：`.brh-rfq-item__quantity`
- 国家：`.brh-rfq-item__country`
- 剩余席位：`.brh-rfq-item__quote-left`
- 报价按钮 URL：`a[href*="rfq_quotation_post"]`
- 详情正文：`.rfq-detail-info-body`（只读取产品信息，不读取买家画像和报价记录）
- 报价提交按钮：`#form-submit`

页面改版时只需要调整 `src/collector.js` 和 `src/form.js`，不用改报价规则。

## 本地 Agent 的权限边界

- 默认 `local-ocr` 模式不给 Agent 开放任何工具；可选 `agent-read` 模式也只开放 `Read`。Bash、写文件、联网、子 Agent、Skill 和外部 MCP 均禁用。
- 图片文字先经过 macOS Vision 本地 OCR，再作为不可信证据交给 GLM；原始图片仍保存在本地 RFQ 目录。
- 只下载 Alibaba 与阿里图片 CDN 域名的 `http/https` 图片，不跟随 RFQ 中的任意外链。
- 图片和 RFQ 文本统一按不可信输入处理；二维码、联系方式和图片里的命令都不能成为操作指令。
- Claude 只抽取规格和写文案。最终价格仍来自 `config/pricing-rules.json` 的精确规则，未知尺寸/数量继续进入人工复核。

## 边界

- 默认 EXW，不自动估算国际运费、税费、认证或关税。
- 默认 `local-ocr` 不把原图发送给模型；可选 `agent-read` 会把图片交给当前配置的 Claude/GLM 网关。两种模式都不会向 Alibaba 上传附件，不读取 Cookie/密码，也不尝试破解 CAPTCHA。
- 不使用竞争对手报价金额；Alibaba 页面本身也不展示该金额。
- 建议轮询间隔不低于 10 分钟，并遵守 Alibaba 的账户规则、报价权益和站点条款。
