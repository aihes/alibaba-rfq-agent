#!/usr/bin/env python3
"""Serve the private case catalog on localhost, with allowlisted evidence files."""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import re
import signal
import sys
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from scripts.case_console import ConsoleError, OperatorConsole
    from scripts.browser_extension import BrowserExtension, ExtensionError
except ModuleNotFoundError:
    from case_console import ConsoleError, OperatorConsole
    from browser_extension import BrowserExtension, ExtensionError


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "src/frontend"
CATALOG_FILE = ROOT / "data/case-catalog/cases.json"
ARCHIVE = ROOT / "data/reference-materials/2026-09-23-dingtalk/9.23报价模版收集.zip"
DEFAULT_PORT = 8888


class CaseHandler(BaseHTTPRequestHandler):
    catalog = None
    case_by_id = None
    catalog_mtime_ns = None

    def log_request(self, code="-", size="-"):
        # 页面每两秒查询一次任务状态；成功请求不刷屏，让普通用户始终
        # 能看到启动地址和关闭方法。HTTP 错误仍输出，任务日志仍照常落盘。
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)

    @classmethod
    def refresh_catalog(cls):
        mtime_ns = CATALOG_FILE.stat().st_mtime_ns
        if mtime_ns != cls.catalog_mtime_ns:
            catalog = json.loads(CATALOG_FILE.read_text())
            cls.catalog = catalog
            cls.case_by_id = {case["id"]: case for case in catalog["cases"]}
            cls.catalog_mtime_ns = mtime_ns

    def respond(self, body: bytes, content_type: str, name: str | None = None):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        if name:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}")
        self.end_headers()
        self.wfile.write(body)

    def error(self, code: int, message: str):
        body = json.dumps({"error": message}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def local_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def respond_json(self, value):
        return self.respond(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        if not self.local_host():
            return self.error(403, "仅允许本机访问")
        route = urllib.parse.urlsplit(self.path)
        params = urllib.parse.parse_qs(route.query)
        path = route.path
        if path in {"/api/extension", "/api/extension/download"}:
            try:
                if not self.server.extension:
                    raise ExtensionError("项目内的 Midscene 插件资源缺失，请重新获取完整项目。")
                if path == "/api/extension":
                    return self.respond_json(self.server.extension.info())
                return self.respond(self.server.extension.archive_bytes(), "application/zip",
                                    self.server.extension.archive.name)
            except ExtensionError as error:
                return self.error(409, str(error))
        if path == "/api/ops/status":
            return self.respond_json(self.server.console.snapshot())
        if path == "/api/env/check":
            try:
                return self.respond_json(self.server.console.env_check(force=params.get("force", [""])[0] == "1"))
            except ConsoleError as error:
                return self.error(500, str(error))
        if path == "/api/quotes":
            try:
                return self.respond_json(self.server.console.list_quotes())
            except ConsoleError as error:
                return self.error(500, str(error))
        if path in {"/api/quote", "/api/quote/screenshot"}:
            try:
                review = self.server.console.review_quote(params.get("draft", [""])[0])
                if path == "/api/quote":
                    return self.respond_json(review)
                rfq_id = review["rfq"]["id"]
                if not review["screenshotAvailable"] or not re.fullmatch(r"[a-zA-Z0-9_-]+", rfq_id):
                    return self.error(404, "回填截图不存在")
                image = (ROOT / "data/drafts" / f"{rfq_id}-filled.png").resolve()
                image.relative_to((ROOT / "data/drafts").resolve())
                return self.respond(image.read_bytes(), "image/png")
            except (ConsoleError, OSError, ValueError, KeyError):
                return self.error(404, "报价草稿不存在")
        self.refresh_catalog()
        if path in ("/", "/app.js", "/styles.css"):
            target = FRONTEND / ("index.html" if path == "/" else path[1:])
            mime = "text/html" if path == "/" else mimetypes.guess_type(target)[0] or "text/plain"
            return self.respond(target.read_bytes(), mime + "; charset=utf-8")
        if path == "/api/catalog":
            return self.respond(json.dumps(self.catalog, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        case_id = params.get("case", [""])[0]
        case = self.case_by_id.get(case_id)
        if not case:
            return self.error(404, "CASE 不存在")
        if path == "/api/image":
            try:
                index = int(params.get("index", ["-1"])[0])
                relative = case["images"][index]
                if index < 0:
                    raise IndexError
                source = (ROOT / "data" / relative).resolve()
                source.relative_to((ROOT / "data/rfqs").resolve())
                return self.respond(source.read_bytes(), mimetypes.guess_type(source.name)[0] or "image/jpeg")
            except (IndexError, ValueError, OSError, KeyError):
                return self.error(404, "图片不存在")
        if path == "/api/source":
            source_id = params.get("source", [""])[0]
            source = next((item for item in case["sources"] if item["id"] == source_id), None)
            if not source:
                return self.error(404, "来源文件不存在")
            if source["kind"] == "archive_workbook":
                try:
                    with zipfile.ZipFile(ARCHIVE) as archive:
                        body = archive.read(archive.infolist()[source["archiveIndex"]])
                    return self.respond(body, "application/octet-stream", source["name"])
                except (OSError, KeyError, IndexError, TypeError):
                    return self.error(404, "来源文件已移动")
            if source["kind"] == "local_json":
                try:
                    target = (ROOT / source["path"]).resolve()
                    target.relative_to((ROOT / "data/drafts").resolve())
                    return self.respond(target.read_bytes(), "application/json; charset=utf-8", source["name"])
                except (OSError, ValueError):
                    return self.error(404, "来源文件已移动")
        return self.error(404, "页面不存在")

    def do_POST(self):
        if not self.local_host():
            return self.error(403, "仅允许本机访问")
        allowed_origin = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if self.headers.get("Origin") not in allowed_origin or self.headers.get("X-Case-Console") != "1":
            return self.error(403, "操作请求来源无效")
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.error(415, "仅接受 JSON 请求")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                return self.error(413, "请求过大或为空")
            payload = json.loads(self.rfile.read(length))
            path = urllib.parse.urlsplit(self.path).path
            if path == "/api/ops/start":
                result = self.server.console.start(payload)
            elif path == "/api/ops/stop":
                result = self.server.console.stop()
            elif path == "/api/ops/settings":
                result = self.server.console.update_settings(payload)
            elif path == "/api/ops/quote/start":
                result = self.server.console.start_quote(payload)
            elif path == "/api/notifications/test":
                if payload != {}:
                    return self.error(400, "通知测试不接受额外参数")
                result = self.server.console.test_notification()
            elif path == "/api/extension/prepare":
                # 安装准备也必须来自本机页面。仅接受空对象，不能通过 API
                # 指定下载地址或解压路径，更不能触发浏览器安装/授权。
                if payload != {}:
                    return self.error(400, "安装准备不接受额外参数")
                if not self.server.extension:
                    raise ExtensionError("项目内的 Midscene 插件资源缺失，请重新获取完整项目。")
                result = self.server.extension.prepare()
            else:
                return self.error(404, "操作不存在")
            return self.respond_json(result)
        except (ValueError, json.JSONDecodeError):
            return self.error(400, "请求 JSON 无效")
        except (ConsoleError, ExtensionError) as error:
            return self.error(409, str(error))


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动本地报价数据集与 Agent 操作台")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="访问端口，默认 8888")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("端口必须在 0–65535 之间")
    if not CATALOG_FILE.exists():
        print("尚未生成数据集。请在项目目录运行 npm start，系统会先整理数据再启动页面。", file=sys.stderr)
        return 1
    try:
        CaseHandler.refresh_catalog()
    except (OSError, ValueError):
        print("数据集无法读取。请重新运行 npm start 整理数据。", file=sys.stderr)
        return 1
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), CaseHandler)
    except OSError as error:
        # macOS 和 Linux 的“地址占用”错误码不同，用 errno 常量识别。
        # 固定地址比自动跳到随机端口更容易记，也不能擅自杀掉占用者。
        if error.errno == errno.EADDRINUSE:
            print(f"\n未启动：端口 {args.port} 已被占用。", file=sys.stderr)
            print(f"如果本项目已经启动，请直接打开 http://localhost:{args.port}/", file=sys.stderr)
            print("需要重启时，回到原来的启动终端按 Ctrl+C，再运行 npm start。", file=sys.stderr)
            print("如果是其他程序占用了端口，请先关闭该程序。", file=sys.stderr)
        else:
            print(f"无法启动本地页面：{error.strerror or error}。请检查端口设置后重试。", file=sys.stderr)
        return 1
    server.console = OperatorConsole()
    server.console.notifications_url = f"http://localhost:{server.server_port}/"
    server.extension = None
    try:
        server.extension = BrowserExtension()
        server.extension.prepare()
    except (ExtensionError, OSError, ValueError, KeyError) as error:
        # 插件资源问题不影响浏览 CASE；页面提供重试入口，终端只提示原因。
        print(f"Midscene 插件文件尚未就绪：{error}", file=sys.stderr)
    # 使用实际绑定端口：除默认入口外，也支持 --port 指定地址和测试端口 0。
    # 说明紧跟在数据构建输出后，用户无需理解 JSON 或后台模块即可开始。
    print(f"\n报价工作台已启动\n\n"
          f"  打开浏览器访问：http://localhost:{server.server_port}/\n\n"
          "  1. 先点「数据集管理」，浏览商品、价格记录和真实 CASE。\n"
          "  2. 首次运行 Agent，点「报价 Agent」→「首次使用：安装 Midscene 插件」。\n"
          "     插件已随项目提供；按页面步骤安装，再开启浏览器控制并检测环境。\n"
          "  3. 浏览器扫描需要 Chrome 的 Midscene Bridge 和 Alibaba 登录态。\n"
          "     浏览器报价须逐单确认；只浏览数据集无需连接 Alibaba。\n\n"
          "  请保持这个终端窗口打开。关闭服务：在这里按 Ctrl+C。\n"
          "  下次启动：在项目目录运行 npm start（npm run cases:up 也可以）。\n", flush=True)
    def stop_server(_signal, _frame):
        raise KeyboardInterrupt

    previous_sigterm = signal.signal(signal.SIGTERM, stop_server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.console.close()
        server.server_close()
        signal.signal(signal.SIGTERM, previous_sigterm)
        print("\n报价工作台已关闭。下次运行 npm start 即可重新打开。", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        # npm 的多层启动脚本可能在 main 已清理服务后再次转发 SIGINT。
        # CLI 最外层也接住它，避免正常 Ctrl+C 关闭被显示为异常堆栈。
        raise SystemExit(0)
