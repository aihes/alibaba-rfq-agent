#!/usr/bin/env node
/**
 * 控制台的“全部配置品类”扫描入口。
 *
 * 每次只启动一个扫描器，沿用它的日志和退出码。登录、验证码或 Bridge
 * 错误会让扫描器失败，此处必须立即停止，不能继续打开下一个品类。
 * 所有品类均通过 argv 传递；含空格、引号或 shell 字符的词也不会被执行。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectDir } from "../src/paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function scanAllTerms({ run = spawnSync, log = console.log, error = console.error } = {}) {
  // 直接读取配置，避免 shell/.env 的 SEARCH_TERMS 把“全部”缩成子集。
  const { searchTerms } = JSON.parse(fs.readFileSync(path.join(projectDir, "config/default.json"), "utf8"));
  const cli = path.join(root, "plugins/alibaba-rfq-midscene/scripts/cli.mjs");
  for (const term of searchTerms) {
    log(`[case-console] Scanning category: ${term}`);
    const result = run(process.execPath, [cli, "scan", "--term", term, "--max", "10"], {
      cwd: root,
      stdio: "inherit",
      // 子进程继承父进程组，总开关关闭时 Python 可以一次停止整组。
      // 再次固定只读模式，也保证直接运行此脚本不会继承自动提交设置。
      env: { ...process.env, AUTO_CONTACT_MODE: "off", ALLOW_LIVE_SUBMIT: "false", AUTO_CONTACT_ACK: "" }
    });
    if (result.error || result.signal || result.status !== 0) {
      error(`[case-console] Category failed; remaining scans stopped: ${term}`);
      if (result.error) error(result.error.message);
      return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    }
  }
  return 0;
}

// 导入函数做隔离测试时不连接浏览器；只有作为 CLI 执行才开始扫描。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = scanAllTerms();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
