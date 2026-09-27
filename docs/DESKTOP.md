# RFQ 助手桌面版

## 普通用户安装

当前生成两种 0.6.1 本地测试安装包：

- Apple Silicon macOS：`dist/desktop/RFQ-Assistant-0.6.1-mac-arm64.dmg`。
- Windows x64：`dist/desktop/RFQ-Assistant-0.6.1-win-x64.exe`。

Windows 双击 EXE 安装，无需管理员权限；会创建桌面与开始菜单快捷方式。
本次在 Mac 交叉生成 Windows 安装包，已检查发布资源与 x64 图片处理
模块，但未在 Windows 实机验证安装、浏览器控制、通知和退出行为。

1. 打开 DMG，把「RFQ助手」拖入 Applications，再打开应用。
2. 在「报价 Agent → 应用设置」填写模型名称和 API Key，保存后测试连接。
   默认是智谱 GLM 的 OpenAI 兼容接口；也可使用 Anthropic 官方 API。
3. 填写 GLM OCR Key。分析模型与 OCR 可使用同一智谱账号的 Key，应用
   不会自动复制密钥到其他服务。也可选择「关闭图片识别」。
   报价前填写已人工核实的交货地点/装运港；监控间隔默认 600 秒。
4. 按「首次使用：安装 Midscene 插件」加载随应用携带的官方插件。
   Chrome 加载的是应用数据目录内稳定的文件夹，升级应用不会移走它。
5. 在专用 Chrome 配置中登录 Alibaba、开启 Bridge，手动开启工作台
   浏览器控制，再检测、扫描或持续监控。报价仍需逐单核对和确认。

无需安装 Node.js、npm、Python、Claude CLI 或编译工具。仍需联网、
Chrome、模型账号/API 用量和 Alibaba 登录；应用不代替用户注册或授权。

当前 macOS 包使用 ad-hoc 本地签名，尚未完成 Developer ID 签名和
Apple 公证。Windows 包未完成发布者签名，系统可能拦截测试包。
对外分发前需要对应证书与签名流程；不建议让普通用户禁用系统安全保护。
本次未生成 Windows ARM64、32 位或 Intel Mac 安装包。

从旧未签名 Mac 测试包升级到本地签名包时，系统可能询问是否允许
RFQ 助手访问自己的钥匙串加密存储。请在系统弹窗完成授权；若要求
登录密码，由用户在系统弹窗中输入。应用不读取或记录系统密码。

## 数据和密钥

- macOS 默认目录：`~/Library/Application Support/RFQ 助手/workspace/`。
- CASE、截图、附件、运行日志、规则配置均在此目录，不写入 `.app`。
- 安装包不含开发项目的 `data/`、`.env`、用户密钥或私人报价样例。
- 「导入已有数据」选择原项目的 `data` 文件夹，仅导入 `drafts`、
  `rfqs`、`runs`、`reference-materials`，不迁移旧操作权限和自动提交状态。
- 密钥由 Electron `safeStorage` 使用系统加密保存，不回显给网页。
  系统密钥加密不可用时拒绝保存密钥；「清除已保存密钥」可移除它们。
- 需求文本发送到用户选择的分析模型；GLM OCR 会把图片发送到所配置
  的 HTTPS 识别服务，按供应商用量计费。它不是离线 OCR。
- JPG/PNG 直接识别，WebP/GIF 使用随包携带的 sharp 转 PNG 后识别。
  识别失败保留状态；不把 OCR 当作产品外观、认证或价格事实。

## 运行、通知和退出

关闭窗口后仍在菜单栏托盘运行。点击托盘可重开工作台；菜单中的
「退出并停止任务」或 ⌘Q 会停止应用创建的任务，不关闭用户 Chrome。
应用退出、监听 Chrome 关闭或电脑休眠后无法持续监听。

机会通知默认关闭，只提示人工复核，不自动报价。桌面版使用 Electron
原生通知，权限归「RFQ 助手」；macOS 要求代码签名。测试按钮
返回系统接受/拒绝/待核实状态，不代表已经看到横幅。CLI Web 版仍可
使用随项目携带的 terminal-notifier。

通知已提供可复用工具定义、JS、CLI 和本机 HTTP 入口，支持查询状态、
发送测试和按草稿 ID 检查机会，详见 [通知工具接口](NOTIFICATION-TOOLS.md)。

## 开发与构建

```bash
npm ci
npm run desktop:dev
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

入口：`desktop/main.js`；服务：`desktop/server.js`；任务控制：
`desktop/console.js`；真实前端源码：`frontend/src/`。旧 Python 服务
保留为兼容参考，默认 Web 和桌面启动均不使用它。

签名发布时将 `electron-builder.yml` 的 `mac.identity: '-'` 换为配置
好的 Developer ID 签名设置，再启用公证；Windows 设置发布者签名。
凭据由构建环境提供，不能
写进仓库。当前没有自动更新服务器，用户通过后续安装包升级，数据保留。

官方接口说明：
- [GLM OCR 文档解析](https://docs.bigmodel.cn/api-reference/模型-api/文档解析)
- [Electron 分发与签名](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
