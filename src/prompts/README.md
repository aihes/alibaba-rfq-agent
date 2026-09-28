# RFQ 模型提示词

这里是运行时唯一的模型提示词模板目录，安装包也会包含这些文件。`*.system.md` 是任务规则，`input.md` 承载结构化输入，`image-*.md` 是图片处理分支，`vision-*.md` 和 `vision-probe.md` 用于本地 OCR/视觉探针。

模板使用 `{{name}}` 占位符；`src/prompt-templates.js` 只替换调用方显式提供的值，缺失或多余字段会报错。RFQ 正文、图片 OCR 和报价规则通过 JSON 输入传给模型，不要把买家内容拼成系统规则。修改模板后运行 `npm test`，并确认 Electron 安装包包含 `src/prompts/`。
