# 应用源码入口

| 从哪里开始 | 文件或目录 | 用途 |
|---|---|---|
| 桌面应用 | `desktop/main.js` | Electron 入口、内置浏览器、工作区和本机服务 |
| 工作台接口 | `desktop/server.js`、`desktop/console.js` | 页面 API、任务启动与运行状态 |
| 工作台页面 | `frontend/` | HTML、CSS 和浏览器端交互；只修改这里的源码 |
| RFQ 主流程 | `pipeline.js` | 搜索、筛选、详情、分析、定价、草稿与保存 |
| 页面采集 | `collector.js`、`browser.js` | RFQ 列表与详情、登录状态 |
| 模型调用 | `claude.js`、`prompt-templates.js`、`prompts/` | 模型请求、提示词模板和占位符 |
| 报价边界 | `pricing.js`、`form.js`、`auto-contact.js` | 确定性价格、表单回填和提交门禁 |

`config/`、`plugins/`、`scripts/`、`tests/` 等位于项目根目录。运行记录写入根目录的 `data/`，安装包生成在 `dist/`；这两个目录不作为功能源码编辑。
