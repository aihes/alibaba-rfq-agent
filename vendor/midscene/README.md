# 本地 Midscene Chrome 插件资源

本目录随项目提供官方 Chrome 扩展安装包。用户不需要访问 Chrome 商店或另行搜索下载地址。

| 项目 | 内容 |
|---|---|
| 上游项目 | [web-infra-dev/midscene](https://github.com/web-infra-dev/midscene) |
| 固定发布版本 | [v1.12.9](https://github.com/web-infra-dev/midscene/releases/tag/v1.12.9) |
| 官方原始文件 | `midscene-extension-v1.12.9.zip`，10,048,522 字节，未修改 |
| 插件 manifest 版本 | `1.99`（上游扩展版本号，与 SDK 发布版本号不同） |
| SHA-256 | `efb02bf28535b09ec9bb05cb248a9e8959214b5772942bb1d9d1e21efeb2dff1` |
| 许可 | MIT，原文见 [LICENSE](LICENSE)；ZIP 内其他组件的许可证保持原样 |

## 普通用户安装

1. 在项目目录运行 `npm start`，打开 http://localhost:8888/。
2. 进入「报价 Agent」→「首次使用：安装 Midscene 插件」。服务会在本机校验 ZIP 并自动解压至 `data/browser-extension/midscene-v1.12.9/`，该过程无需联网。
3. 复制页面提供的 `chrome://extensions` 到 Chrome 地址栏，打开「开发者模式」，点击「加载已解压的扩展程序」，选择页面显示的插件文件夹。
   Mac 选择文件夹时按 **⌘⇧G**，粘贴插件目录并回车，再点击「选择」。
4. 固定并打开 Midscene.js，进入「Bridge Mode」。开启工作台的浏览器开关并重新检测；在插件的连接提示中点击「Allow」，确认 Alibaba 已登录。

Chrome 的扩展安装需由用户手动完成；工作台只准备文件，不修改 Chrome 配置或授予权限。安装后保留解压目录，Chrome 会持续从这里读取插件。清理 `data/` 前先在 Chrome 中移除该扩展，下次启动后按同样步骤加载。

页面还可以下载本目录的官方 ZIP。手动使用时将 ZIP 解压到固定文件夹，选择其中含 `manifest.json` 的文件夹加载，不能直接加载 ZIP。

## 维护者更新

当前归档对应 `package-lock.json` 固定的 `@midscene/web` 1.12.9。升级 SDK 时，应从相同官方发布下载扩展，核对 GitHub release 的摘要，更新 ZIP、`extension.json` 和此文档，并保留对应的上游许可证。运行 `python3 -m unittest discover -s tests -p 'test_*.py'` 验证资源和安装准备流程。

安装目录包含发布版本号。更新后会准备新目录，旧扩展须在 Chrome 中移除再加载新目录；工作台不会擅自替换已经加载的扩展。
