"""Local, allowlisted process control for the CASE archive UI."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OPS_DIR = ROOT / "data/case-catalog/ops"
SETTINGS_FILE = OPS_DIR / "settings.json"
LAST_RUN_FILE = OPS_DIR / "last-run.json"
SEARCH_TERMS = json.loads((ROOT / "config/default.json").read_text())["searchTerms"]
ALL_TERMS = "__all__"
ENV_CHECK_TTL_SECONDS = 20
ENV_CHECK_TIMEOUT_SECONDS = 30
HUMAN_ATTENTION = re.compile(r"CAPTCHA|verification challenge|login is required|Cannot attach to the existing Chrome session|Chrome Bridge or Alibaba requires human attention|needs_manual_review|Submit was clicked, but success could not be verified", re.I)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


class ConsoleError(Exception):
    pass


class OperatorConsole:
    def __init__(self, root=ROOT, ops_dir=OPS_DIR, popen=subprocess.Popen):
        self.root = Path(root)
        self.ops_dir = Path(ops_dir)
        self.popen = popen
        self.lock = threading.RLock()
        self.process = None
        self.current = None
        self.settings_file = self.ops_dir / "settings.json"
        self.last_run_file = self.ops_dir / "last-run.json"
        self.settings = {"browserEnabled": False, "quoteEnabled": False, "alertsEnabled": True}
        if self.settings_file.exists():
            try:
                saved = json.loads(self.settings_file.read_text())
                self.settings.update({key: saved[key] for key in ("browserEnabled", "alertsEnabled") if type(saved.get(key)) is bool})
            except (OSError, ValueError):
                pass
        self.last_run = None
        if self.last_run_file.exists():
            try:
                self.last_run = json.loads(self.last_run_file.read_text())
                if self.last_run.get("status") in {"running", "stopping", "indexing"}:
                    self.last_run.update(status="interrupted", finishedAt=now(), alert="服务重启，原任务状态无法继续追踪")
            except (OSError, ValueError):
                pass
        self._env_cache = None

    def env_check(self, force=False):
        if not force and self._env_cache and (datetime.now(timezone.utc) - self._env_cache[0]).total_seconds() < ENV_CHECK_TTL_SECONDS:
            return self._env_cache[1]
        node = shutil.which("node")
        cli = self.root / "plugins/alibaba-rfq-midscene/scripts/cli.mjs"
        checks = [
            {"key": "node", "ok": bool(node), "label": "Node.js 运行环境", "detail": node or "未找到 Node.js，请先安装 Node 20+"},
            {"key": "plugin", "ok": cli.exists(), "label": "Midscene 插件脚本", "detail": "已安装" if cli.exists() else "plugins/alibaba-rfq-midscene 缺失，请检查插件目录"},
            {"key": "bridge", "ok": False, "label": "Chrome Bridge 连接", "detail": "未检测"},
            {"key": "login", "ok": False, "label": "Alibaba 登录态", "detail": "未检测"},
        ]
        by_key = {item["key"]: item for item in checks}
        if node and cli.exists():
            try:
                result = subprocess.run([node, str(cli), "status"], cwd=self.root, capture_output=True,
                                        text=True, timeout=ENV_CHECK_TIMEOUT_SECONDS, check=False)
                stdout = result.stdout or ""
                start = stdout.find("{")
                payload = json.loads(stdout[start:]) if start >= 0 else None
            except (OSError, subprocess.TimeoutExpired, ValueError):
                payload = None
            if not isinstance(payload, dict):
                by_key["bridge"]["detail"] = "检测超时或无输出；请确认 Chrome 已启动并启用 Midscene 扩展"
            elif payload.get("connected"):
                by_key["bridge"].update(ok=True, detail=f"已连接（tab {payload.get('tabId')}）")
                by_key["login"].update(ok=bool(payload.get("loggedIn")),
                                       detail="已登录 sourcing.alibaba.com" if payload.get("loggedIn") else "未登录；需人工在 Chrome 中完成登录")
            else:
                by_key["bridge"]["detail"] = "未连接；请在 Chrome 中启用 Midscene 扩展并开启 Bridge"
        report = {"ok": all(item["ok"] for item in checks), "checks": checks, "checkedAt": now()}
        self._env_cache = (datetime.now(timezone.utc), report)
        return report

    def _tail(self, run):
        if not run:
            return ""
        path = self.ops_dir / f"{run['id']}.log"
        try:
            with path.open("rb") as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell() - 24000))
                return stream.read().decode("utf-8", errors="replace")[-20000:]
        except OSError:
            return ""

    def snapshot(self):
        with self.lock:
            run = dict(self.current or self.last_run or {})
            settings = dict(self.settings)
        return {"settings": settings, "searchTerms": SEARCH_TERMS, "run": run or None,
                "log": self._tail(run), "serverTime": now()}

    def update_settings(self, changes):
        if not isinstance(changes, dict) or not changes or any(key not in self.settings or type(value) is not bool for key, value in changes.items()):
            raise ConsoleError("开关参数无效")
        with self.lock:
            if changes.get("quoteEnabled") and not changes.get("browserEnabled", self.settings["browserEnabled"]):
                raise ConsoleError("请先开启浏览器操作")
            self.settings.update(changes)
            if not self.settings["browserEnabled"]:
                self.settings["quoteEnabled"] = False
            atomic_json(self.settings_file, self.settings)
            stop_browser = not self.settings["browserEnabled"] and self.current and self.current["kind"] != "refresh"
            stop_quote = not self.settings["quoteEnabled"] and self.current and self.current["kind"] in {"quote_fill", "quote_submit"}
            if (stop_browser or stop_quote) and self.process and self.current["status"] != "indexing":
                self._stop_locked()
        return self.snapshot()

    def _quote_cli(self, *args):
        node = shutil.which("node")
        if not node:
            raise ConsoleError("未找到 Node.js")
        try:
            result = subprocess.run([node, str(self.root / "scripts/console-quote.mjs"), *args],
                                    cwd=self.root, capture_output=True, text=True, timeout=12, check=False,
                                    env={**os.environ, "AUTO_CONTACT_MODE": "off", "ALLOW_LIVE_SUBMIT": "false"})
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ConsoleError("报价草稿读取超时或无法启动") from error
        if result.returncode:
            raise ConsoleError("报价草稿读取失败，请检查本机日志")
        try:
            return json.loads(result.stdout)
        except ValueError as error:
            raise ConsoleError("报价草稿结果格式无效") from error

    def list_quotes(self):
        return self._quote_cli("list")

    def review_quote(self, draft_id):
        if type(draft_id) is not str or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}", draft_id):
            raise ConsoleError("草稿 ID 无效")
        return self._quote_cli("review", draft_id)

    def start_quote(self, request):
        if not isinstance(request, dict) or request.get("kind") not in {"fill", "submit"}:
            raise ConsoleError("报价操作无效")
        draft_id = request.get("draftId")
        if type(request.get("approved")) is not bool or request["approved"] is not True:
            raise ConsoleError("请先核对该 RFQ 的报价字段")
        with self.lock:
            if self.current is not None:
                raise ConsoleError("已有任务正在运行，请先停止")
            if not self.settings["browserEnabled"] or not self.settings["quoteEnabled"]:
                raise ConsoleError("请先开启浏览器操作和浏览器报价")
            review = self.review_quote(draft_id)
            if request.get("reviewHash") != review["reviewHash"]:
                raise ConsoleError("草稿已变化，请重新审阅")
            if request.get("confirmation") != review["rfq"]["id"]:
                raise ConsoleError("请输入当前 RFQ 的完整 ID 作为确认")
            eligible_key = "fillEligible" if request["kind"] == "fill" else "submitEligible"
            reasons_key = "fillReasons" if request["kind"] == "fill" else "submitReasons"
            if not review[eligible_key]:
                raise ConsoleError("当前草稿不允许报价：" + "；".join(review[reasons_key]))
            kind = "quote_" + request["kind"]
            run = {"id": uuid.uuid4().hex[:12], "kind": kind, "draftId": draft_id,
                   "rfqId": review["rfq"]["id"], "term": None, "limit": None,
                   "status": "running", "startedAt": now(), "finishedAt": None, "exitCode": None, "alert": None}
            self.ops_dir.mkdir(parents=True, exist_ok=True)
            environment = os.environ.copy()
            environment.update({"AUTO_CONTACT_MODE": "off", "ALLOW_LIVE_SUBMIT": "false", "AUTO_CONTACT_ACK": ""})
            if request["kind"] == "submit":
                environment.update({"AUTO_CONTACT_MODE": "submit", "ALLOW_LIVE_SUBMIT": "true",
                                    "AUTO_CONTACT_ACK": "I_UNDERSTAND_AUTO_QUOTES_ARE_SENT",
                                    "AUTO_CONTACT_CATEGORIES": review["quote"]["categoryId"],
                                    "QUOTE_PORT": review["draft"]["port"]})
            node = shutil.which("node")
            command = [node, str(self.root / "scripts/console-quote.mjs"), request["kind"], draft_id,
                       review["reviewHash"], review["rfq"]["id"]]
            log_file = (self.ops_dir / f"{run['id']}.log").open("wb")
            try:
                process = self.popen(command, cwd=self.root, env=environment, stdout=log_file,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            except OSError as error:
                log_file.close()
                raise ConsoleError(f"启动失败：{error.strerror or error}") from error
            log_file.close()
            self.process = process
            self.current = run
            atomic_json(self.last_run_file, run)
            threading.Thread(target=self._watch, args=(process, run), daemon=True).start()
        return self.snapshot()

    def _command(self, kind, term, limit):
        node = shutil.which("node")
        if not node:
            raise ConsoleError("未找到 Node.js")
        if kind == "refresh":
            return [node, str(self.root / "scripts/build_case_catalog.mjs")]
        cli = str(self.root / "plugins/alibaba-rfq-midscene/scripts/cli.mjs")
        if kind == "scan":
            if term == ALL_TERMS:
                script = "; ".join(f'"{node}" "{cli}" scan --term "{item}" --max 10' for item in SEARCH_TERMS)
                return ["/bin/sh", "-c", script]
            return [node, cli, "scan", "--term", term, "--max", "10"]
        if kind in ("once", "watch"):
            return [node, str(self.root / "src/cli.js"), kind]
        raise ConsoleError("不支持的操作")

    def start(self, request):
        if not isinstance(request, dict):
            raise ConsoleError("请求格式无效")
        kind = request.get("kind")
        if kind not in {"refresh", "scan", "once", "watch"}:
            raise ConsoleError("不支持的操作")
        term = request.get("term", SEARCH_TERMS[0])
        if type(term) is not str or term not in [*SEARCH_TERMS, ALL_TERMS]:
            raise ConsoleError("搜索词必须来自已配置品类")
        limit = request.get("limit", 1)
        if type(limit) is not int or not 1 <= limit <= 3:
            raise ConsoleError("每轮新 RFQ 数量仅支持 1–3")
        with self.lock:
            if self.current is not None:
                raise ConsoleError("已有任务正在运行，请先停止")
            if kind != "refresh" and not self.settings["browserEnabled"]:
                raise ConsoleError("请先开启浏览器操作")
            command = self._command(kind, term, limit)
            run = {"id": uuid.uuid4().hex[:12], "kind": kind, "term": term if kind in {"scan", "once", "watch"} else None,
                   "limit": limit if kind in {"once", "watch"} else None, "status": "running", "startedAt": now(),
                   "finishedAt": None, "exitCode": None, "alert": None}
            self.ops_dir.mkdir(parents=True, exist_ok=True)
            environment = os.environ.copy()
            environment.update({"AUTO_CONTACT_MODE": "off", "ALLOW_LIVE_SUBMIT": "false", "AUTO_CONTACT_ACK": "",
                                "MAX_NEW_RFQS_PER_CYCLE": str(limit), "MAX_CARDS_PER_SEARCH": "10"})
            if term != ALL_TERMS:
                environment["SEARCH_TERMS"] = term
            log_file = (self.ops_dir / f"{run['id']}.log").open("wb")
            try:
                process = self.popen(command, cwd=self.root, env=environment, stdout=log_file,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            except OSError as error:
                log_file.close()
                raise ConsoleError(f"启动失败：{error.strerror or error}") from error
            log_file.close()
            self.process = process
            self.current = run
            atomic_json(self.last_run_file, run)
            threading.Thread(target=self._watch, args=(process, run), daemon=True).start()
        return self.snapshot()

    def _watch(self, process, run):
        exit_code = process.wait()
        with self.lock:
            if self.process is not process:
                return
            stopped = run["status"] == "stopping"
            if run["kind"] in {"once", "watch", "quote_fill", "quote_submit"}:
                run["status"] = "indexing"
                atomic_json(self.last_run_file, run)
        index_error = None
        if run["kind"] in {"once", "watch", "quote_fill", "quote_submit"}:
            with (self.ops_dir / f"{run['id']}.log").open("ab") as log_file:
                log_file.write(b"\n[case-console] Updating CASE catalog...\n")
                log_file.flush()
                try:
                    node = shutil.which("node")
                    if not node:
                        raise OSError("node not found")
                    result = subprocess.run([node, str(self.root / "scripts/build_case_catalog.mjs")],
                                            cwd=self.root, stdout=log_file, stderr=subprocess.STDOUT, timeout=120,
                                            check=False)
                    if result.returncode:
                        index_error = "CASE 列表更新失败，请查看日志"
                except (OSError, subprocess.TimeoutExpired):
                    index_error = "CASE 列表更新超时或无法启动"
        with self.lock:
            if self.process is not process:
                return
            run["exitCode"] = exit_code
            run["finishedAt"] = now()
            if stopped:
                run["status"] = "attention" if run["kind"] == "quote_submit" else "stopped"
                if run["kind"] == "quote_submit":
                    run["alert"] = "提交过程被中断；请核对页面与记录，不要直接重试"
            else:
                log = self._tail(run)
                run["status"] = "attention" if HUMAN_ATTENTION.search(log) else ("completed" if exit_code == 0 else "failed")
                if run["status"] == "attention":
                    run["alert"] = "浏览器登录、验证码或连接需要人工处理"
                elif run["status"] == "failed":
                    run["alert"] = "任务运行失败，请查看日志"
                if exit_code == 0 and run["kind"] in {"quote_fill", "quote_submit"}:
                    expected = "filled_not_submitted" if run["kind"] == "quote_fill" else "submitted"
                    if not re.search(r'"status"\s*:\s*"' + expected + r'"', log):
                        run["status"] = "attention"
                        run["alert"] = "报价动作没有可验证的完成状态；请人工核对，不要直接重试"
            if index_error:
                run["alert"] = index_error if not run["alert"] else f"{run['alert']}；{index_error}"
                if run["status"] == "completed":
                    run["status"] = "failed"
            self.process = None
            self.current = None
            self.last_run = run
            atomic_json(self.last_run_file, run)

    def _stop_locked(self):
        if not self.process or not self.current:
            raise ConsoleError("当前没有运行中的任务")
        if self.current["status"] == "indexing":
            raise ConsoleError("正在更新 CASE 列表，稍后即可完成")
        self.current["status"] = "stopping"
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        return self.snapshot()

    def stop(self):
        with self.lock:
            return self._stop_locked()

    def close(self):
        with self.lock:
            if self.process and self.current and self.current["status"] != "indexing":
                self._stop_locked()
