import { createCaseServer } from "../src/desktop/server.js";
import { projectDir, resourceDir } from "../src/config.js";

const i = process.argv.indexOf("--port");
const port = i < 0 ? 8888 : Number(process.argv[i + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须在 0–65535 之间");
try {
  const app = await createCaseServer({ resources: resourceDir, workspace: projectDir, port });
  console.log(`\n报价工作台已启动\n\n打开浏览器访问：${app.url.replace("127.0.0.1", "localhost")}\n首次使用请在「报价 Agent」中按引导安装插件。\n关闭服务：Ctrl+C；下次启动：npm start。\n`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); console.log("报价工作台已关闭"); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
} catch (error) {
  console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用。如果已启动本项目，请打开 http://localhost:${port}/；需要重启时在原终端按 Ctrl+C。` : `无法启动工作台：${error.message}`);
  process.exitCode = 1;
}
