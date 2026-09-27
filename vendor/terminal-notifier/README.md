# macOS 系统通知组件

使用官方 [terminal-notifier 3.1.0](https://github.com/julienXX/terminal-notifier/releases/tag/3.1.0) 发布包，无须额外安装 Homebrew 工具或 npm 通知依赖。

- 原始 ZIP：`terminal-notifier-3.1.0.zip`，未修改，400,096 字节。
- SHA-256：`e969d4ae20287da1ba55495ae31dcedd8e9069deb8ce4eed24f6561a5fc3e4d5`。
- 许可及图标版权说明：[LICENSE.md](LICENSE.md)，从 ZIP 内上游 README 的 License 部分原样保留。
- 支持 macOS 10.14+，官方通用二进制支持 Apple silicon 与 Intel；其他系统当前不发送系统通知。

在工作台「报价 Agent → 报价模式」开启「机会系统通知」，再点击「发送测试通知」。首次发出通知时由 macOS 请求授权，用户手动允许；若未看到横幅，在系统设置 → 通知 → terminal-notifier 中检查权限、横幅样式和专注模式。系统确认接受请求不等于横幅已显示。

通知程序第一次发送时校验归档并离线解压到 `data/notification-helper/v3.1.0/`。发送采用固定可执行文件和参数数组，不执行 shell，不改系统通知设置，不移除隔离属性、不绕过系统安全拦截。

监听任务在后台直接发送通知，工作台页面关闭仍有效；需保持启动终端、监听 Chrome 及持续监控任务运行。点击机会通知打开本机工作台对应草稿，不自动回填或提交。
