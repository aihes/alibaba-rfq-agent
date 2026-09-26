#!/usr/bin/env python3
"""Serve the private case catalog on localhost, with allowlisted evidence files."""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import signal
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from scripts.case_console import ConsoleError, OperatorConsole
except ModuleNotFoundError:
    from case_console import ConsoleError, OperatorConsole


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend/src"
CATALOG_FILE = ROOT / "data/case-catalog/cases.json"
ARCHIVE = ROOT / "data/reference-materials/2026-09-23-dingtalk/9.23报价模版收集.zip"


class CaseHandler(BaseHTTPRequestHandler):
    catalog = None
    case_by_id = None
    catalog_mtime_ns = None

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
            else:
                return self.error(404, "操作不存在")
            return self.respond_json(result)
        except (ValueError, json.JSONDecodeError):
            return self.error(400, "请求 JSON 无效")
        except ConsoleError as error:
            return self.error(409, str(error))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not CATALOG_FILE.exists():
        raise SystemExit("缺少 CASE 数据；先运行 npm run cases:build")
    CaseHandler.refresh_catalog()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), CaseHandler)
    server.console = OperatorConsole()
    print(f"CASE 页面：http://127.0.0.1:{args.port}/", flush=True)
    def stop_server(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.console.close()
        server.server_close()


if __name__ == "__main__":
    main()
