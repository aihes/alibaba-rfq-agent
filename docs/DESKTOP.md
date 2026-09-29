# RFQ 助手桌面版

## 普通用户安装

0.7.21 使用内置 Chromium，提供两种本地测试安装包：

- Apple Silicon macOS：`dist/desktop/RFQ-Assistant-0.7.21-mac-arm64.dmg`。
- Windows x64：`dist/desktop/RFQ-Assistant-0.7.21-win-x64.exe`。

Windows 双击 EXE 安装，无需管理员权限；会创建桌面与开始菜单快捷方式。
本次在 Mac 交叉生成 Windows 安装包，已检查发布资源与 x64 图片处理
模块，但未在 Windows 实机验证安装、浏览器控制、通知和退出行为。

1. 打开 DMG，把「RFQ助手」拖入 Applications，再打开应用。
2. 在左侧「设置 → 模型服务」填写云端服务授权令牌并保存，然后点击「测试模型连接」。
   默认由 `glm.knowflow.work` 上的 Claude Code 处理需求分析和话术，文字使用 GLM-5.3，
   图片使用 GLM-5.3-Flash。令牌必须单独签发，不包含在安装包中；本机使用系统加密保存。
   也可手动选择本机 Claude 或 GLM HTTP 接口。
3. 云端 OCR 默认复用同一服务令牌，可点击「测试 OCR」。也可选择 GLM OCR 直连并填写自己的
   GLM Key，或关闭图片识别。
   报价前填写已人工核实的交货地点/装运港；监控间隔默认 600 秒。
4. 在「报价 Agent」的运行准备区域点击「打开浏览器」，在应用自带的窗口中手动登录。
   窗口顶部显示当前标签、后退、前进、地址和「复制链接」；左侧「浏览器」也提供导航、刷新和页面管理。
   此会话与个人 Chrome 分开；也可在「浏览器」导入 Chrome 导出的 Alibaba 登录文件，
   减少重复登录。迁移后仍要检查登录是否有效。
5. 登录后打开 RFQ 列表，账号状态会自动检查并更新，无需开启 Agent；可点击「刷新状态」立即检查。
   浏览器操作默认可用，准备运行时直接启动扫描或持续监控。
   报价仍需逐单核对和确认；出现验证码或登录失效时先停止任务，再手动处理。

任务状态区按时间追加每个阶段的记录，显示搜索、读取详情、模型分析、价格核对和草稿保存等步骤。点击阶段可展开该步的输入与输出；新运行完成步骤时直接记录结果，旧版运行可从本轮保存的草稿还原需求、模型请求、分析、报价和回复，但未逐项保存的搜索结果不会伪造。长时间运行只展示最近记录。红色提醒标有「上次运行」时，是那次任务的历史结果，不表示当前浏览器已经退出登录。扫描遇到 RFQ 页面登录提示会短暂等待页面稳定；仍无法确认时停下并提示查看该页面。原始调用栈位于默认收起的「查看技术日志」。

报价 Agent 底部只显示明确规则报价：价格状态为 `quoted`，美元数量、单价、总价能对上，且已生成商品规格与拟回复。`needs_review` 没有明确价格，`conditional_quote` 的金额仍依赖未确认条件，两者保留在本地分析记录中，但不进入底部报价列表。当前状态筛选区分全部明确报价、未提交、已回填未提交、已验证提交；页面的「这些状态是什么意思？」逐项解释。可按商品/RFQ/原始需求/拟回复全文、品类与生成日期筛选。详情依次展示买家原始需求、抽取规格与待确认项、确定性价格判断、准备给买家的完整回复。买家原始需求可跳转 Alibaba 原始 RFQ；已保存的买家图片可在详情中点击放大，没有保存图片时会提示前往原始页面核对。明确报价仍需人工核对供货条件，未提交的报价不能视为已发送。对无需保留在当前工作台的未提交明确报价，可在详情中确认「移出当前草稿列表」，之后从「已移出草稿」恢复；此操作不会删除原始文件。已有提交、回填或提交状态不明的记录不能移出。

无需安装 Node.js、npm、Python、Claude CLI 或编译工具；只有手动选用本机 Claude 时才需安装并配置 CLI。仍需联网、
云端服务授权和 Alibaba 登录。无需安装 Chrome 或浏览器插件；应用不代替用户注册或授权。
仅从已有 Chrome 迁移登录时，可使用随项目提供的导出扩展。

## 云端服务与其他模型配置

云端模式调用 `POST https://glm.knowflow.work/v1/agent` 和 `POST /v1/ocr`。
每台安装实例应使用独立客户端令牌；令牌仅在本机加密设置中保存，界面不回显。
分类、话术和报价理由分别发起独立 Agent 请求；分类时前两张图片直接发送给 Claude Code，
其他图片只提供 OCR 文字。云端接口有请求次数、图片大小和输入长度限制；
超限会显示失败或保留本地规则分析，不会自动换用另一个模型。
旧版「自动」本机 Claude 设置升级后改用云端默认；用户明确选过「手动」或「环境变量」模式时保留原选择。

### 安装与配置本机 Claude

在桌面版「设置 → 模型服务」点击「安装并配置本机 Claude」。应用会打开
随安装包提供的 macOS/Windows 脚本；用户确认后，脚本从 Anthropic 官方
`claude.ai` 下载原生 Claude Code 安装程序（已经安装时跳过），然后让用户
选择智谱国内或 Z.AI 并在终端中隐式输入自己的 API Key。无需另装
Node.js、npm 或 Git；需要联网和对应平台的 Key。脚本仅在用户主动点击后运行。

配置会合并到用户的 `~/.claude/settings.json`，保留其他 Claude 设置，
替换原有的 Anthropic API Key、认证与接口，避免旧 Key 抢占新 Key；原文件会备份为同目录下的
`settings.json.before-rfq-*.bak`。Key 不进入命令行参数、仓库或安装包，
但按 Claude/智谱的配置方式，它会以**明文**保存在该设置文件及备份中
（macOS 权限为 0600；Windows 依赖用户目录的访问权限）。已有其他 Claude 服务配置的用户应先了解这一变化；
希望避免修改 Claude 全局设置时，可以改选本应用的 HTTP 模式，在应用中
加密保存模型 Key。脚本不会替用户创建账号或购买用量。

macOS 使用 `scripts/setup-local-claude-macos.command`，Windows 使用
`scripts/setup-local-claude-windows.cmd` 启动 PowerShell 脚本；Key 交给
`scripts/configure-local-claude.cjs` 合并配置。Windows 脚本还需在真实
Windows 机器上验证安装流程。安装后点击「重新读取本机环境变量」和
「测试模型连接」；CLI 存在只代表找到了程序，不代表 Key 已可用。
官方安装方式：[Anthropic Claude Code 安装说明](https://code.claude.com/docs/en/setup)；
Z.AI 配置方式：[Z.AI Claude Code 指南](https://docs.z.ai/devpack/tool/claude)。

「自动」使用云端 Claude；令牌可在应用中保存，也可用本机 `RFQ_CLOUD_TOKEN` 环境变量提供。
「使用本机模型环境变量」强制使用环境配置；「手动选择调用方式」
按界面指定的本机 Claude 或 HTTP 模式运行，不自动切换供应商。
设置页显示来源、接口、模型名称和密钥变量名，不显示密钥。点击「重新读取本机环境变量」
可在不重启应用的情况下刷新；现有任务运行时不允许修改配置。

读取顺序：进程环境变量 → `~/.claude/settings.json` 中官方配置工具写入的 `env`
→ macOS / Linux 标准登录 shell 的环境变量。Finder/Dock 启动也支持后两种来源。
Windows 使用进程环境和本机 Claude env；修改系统环境后需重启应用。
只读取模型认证和接口白名单，不加载 Claude 用户级 hooks、插件或额外指令，
不导入自动提交权限或浏览器令牌，也不读取项目 `.env`。

- 通用配置：`MODEL_API_KEY`、`MODEL_API_URL`、`MODEL_NAME`、`AGENT_PROVIDER`。
- GLM 配置：`GLM_API_KEY` / `ZHIPU_API_KEY` / `ZHIPUAI_API_KEY` / `ZAI_API_KEY` / `ZAI_APIKEY`，
  配合 `GLM_MODEL` 和 `GLM_BASE_URL` / `ZAI_BASE_URL`。
- GLM Anthropic 兼容配置：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、
  `ANTHROPIC_MODEL` / `ANTHROPIC_HTTP_MODEL`。凭据与兼容接口成对使用。
- OCR：优先使用界面单独保存的 OCR Key，其次是 `GLM_OCR_API_KEY`；未配置时复用已保存的智普模型 Key，或上述本机智普环境变量。也支持与官方智普接口成对配置的 `MODEL_API_KEY`、`ANTHROPIC_AUTH_TOKEN`。Z.AI Key 默认请求 `api.z.ai` 的 OCR 接口，国内智普 Key 默认请求 `open.bigmodel.cn`；自定义 OCR 地址必须与复用 Key 的平台一致。

环境变量密钥仅留在主进程内存并交给应用内任务，不复制到设置文件。
本机 Claude 模式由应用调用用户已安装的 Claude CLI；模型分析仍通过其配置的联网服务请求。
设置页显示的模型名就是实际请求的模型，默认 `glm-5.3`。报价金额由固定规则计算，
分析模型只处理需求理解和话术；浏览器回填及提交仍需逐单确认。
本机 Claude 配置说明见 [智谱官方指南](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)。

## 从 Chrome 迁移 Alibaba 登录

1. 在 RFQ 助手的「浏览器」展开导出工具说明，下载 ZIP 并解压。
2. 在原 Chrome 打开 `chrome://extensions`，开启开发者模式，
   选择「加载已解压的扩展程序」，选解压后的文件夹。
3. 原 Chrome 确认 Alibaba 已登录，打开「RFQ助手 · Alibaba 登录导出」扩展，
   点击导出，得到 `rfq-alibaba-login.json`。
4. 回到 RFQ 助手「浏览器」，点击「选择登录文件并导入」。
   导入后打开 RFQ 列表检查账号；失效或网站要求验证时，仍需手动登录。

扩展源码随仓库和安装包提供，只申请 Alibaba 域名的 Cookie 权限，
仅在点击按钮时导出，不发送到网络。文件含登录凭据，请妥善保管。
导入只支持 Alibaba Cookie JSON，不导入整个 Chrome 配置目录、密码、历史或书签。
文件先完整校验再替换应用专用会话；失败尝试恢复原记录，任务或页面加载中拒绝导入。
忽略其他域名、过期记录及不支持的分区 Cookie；部分会话迁移后可能要求重新验证。
导入不会启动 Agent 任务、报价或自动提交。

当前 macOS 包使用 ad-hoc 本地签名，尚未完成 Developer ID 签名和
Apple 公证。Windows 包未完成发布者签名，系统可能拦截测试包。
对外分发前需要对应证书与签名流程；不建议让普通用户禁用系统安全保护。
本次未生成 Windows ARM64、32 位或 Intel Mac 安装包。

保存模型 API Key 时，系统可能询问是否允许 RFQ 助手访问钥匙串。
请在系统弹窗完成授权；应用不读取或记录系统密码。浏览器登录会话
备份不再依赖启动时查询钥匙串，避免本地签名包卡在无窗口状态。

## 数据和密钥

- macOS 默认目录：`~/Library/Application Support/RFQ 助手/workspace/`。
- 内置浏览器的 Alibaba 会话位于同一应用数据目录的专用 Chromium 分区。
  没有过期时间的 session Cookie 另存为 AES-GCM 加密文件
  `alibaba-session-v2.bin`，密钥在 `alibaba-session.key`；两个文件
  权限均为 `0600`，仅当前系统用户可读。升级安装包不会删除应用数据。
  网站主动注销或服务端会话失效时仍需重新登录。旧版退出时已经丢失的
  session Cookie 无法从新版本恢复，升级后可能需要最后一次手动登录。
- CASE、截图、附件、运行日志、规则配置均在此目录，不写入 `.app`。
- 安装包不含开发项目的 `data/`、`.env`、用户密钥或私人报价样例。
- 「导入已有数据」选择原项目的 `data` 文件夹，仅导入 `drafts`、
  `rfqs`、`runs`、`reference-materials`，不迁移旧操作权限和自动提交状态。
- 模型 API Key 仍由 Electron `safeStorage` 使用系统加密保存，不回显给网页。
  系统密钥加密不可用时拒绝保存；「清除已保存密钥」可移除它们。
- 需求文本发送到用户选择的分析模型；GLM OCR 会把图片发送到所配置
  的 HTTPS 识别服务，按供应商用量计费。它不是离线 OCR。
- JPG/PNG 直接识别，WebP/GIF 使用随包携带的 sharp 转 PNG 后识别。
  识别失败保留状态；不把 OCR 当作产品外观、认证或价格事实。

## 运行、通知和退出

关闭窗口后仍在菜单栏托盘运行。点击托盘可重开工作台；菜单中的
「退出并停止任务」或 ⌘Q 会停止应用创建的任务并结束内置浏览器。
内置浏览器的关闭按钮只隐藏窗口，可以从工作台/托盘/应用菜单重新打开。
应用退出或电脑休眠后无法持续监听；个人 Chrome 不受影响。

机会通知默认关闭，只提示人工复核，不自动报价。桌面版使用 Electron
原生通知，并在应用内弹出提醒、保留「最近提醒」记录；真实机会出现时
会唤出工作台。macOS 系统横幅取决于 RFQ 助手的通知权限和专注模式；
测试按钮返回系统接受/拒绝/待核实状态，不代表已经看到横幅。CLI Web
版仍可使用随项目携带的 terminal-notifier。

通知已提供可复用工具定义、JS、CLI 和本机 HTTP 入口，支持查询状态、
发送测试和按草稿 ID 检查机会，详见 [通知工具接口](NOTIFICATION-TOOLS.md)。

## 开发与构建

```bash
npm ci
npm run desktop:dev
npm run desktop:test:browser
npm run desktop:dist
npm run desktop:dist:win
npm run desktop:check
```

Electron 44 的 npm 包需要显式运行安装器，脚本已自动处理。开发机
需要 Node 22.19+（打包工具依赖要求），普通用户无需安装 Node。

`desktop:dist` 在 macOS 生成 arm64 DMG/ZIP。`desktop:pack` 仅生成
应用目录。`desktop:dist:win` 生成 x64 NSIS 安装包，在 Mac 构建时
自动隔离安装 Windows sharp 预编译模块并写入 Windows 构建目录；
不会把 Mac 原生模块误装进 Windows 包。仍需在 Windows 完成真实系统验证。

入口：`src/desktop/main.js`；服务：`src/desktop/server.js`；任务控制：
`src/desktop/console.js`；真实前端源码：`src/frontend/`。旧 Python 服务
保留为兼容参考，默认 Web 和桌面启动均不使用它。

内置浏览器由 `src/desktop/embedded-browser.js` 管理，工作进程经临时私有令牌
连接 `src/electron-browser.js`，不开放 Chromium 调试端口，不向工作台网页
提供任意脚本执行权限。详细接口、边界和验证见 [内置浏览器说明](EMBEDDED-BROWSER.md)。

签名发布时将 `electron-builder.yml` 的 `mac.identity: '-'` 换为配置
好的 Developer ID 签名设置，再启用公证；Windows 设置发布者签名。
凭据由构建环境提供，不能
写进仓库。当前没有自动更新服务器，用户通过后续安装包升级，数据保留。

官方接口说明：
- [GLM OCR 文档解析](https://docs.bigmodel.cn/api-reference/模型-api/文档解析)
- [Electron 分发与签名](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
