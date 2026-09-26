import http.client
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import scripts.case_console as case_console
from scripts.case_console import ConsoleError, OperatorConsole
from scripts.serve_case_catalog import CaseHandler


class ImmediateProcess:
    pid = 99999999

    def wait(self):
        return 0


class ConsoleTest(unittest.TestCase):
    def wait_for_completion(self, console):
        # start() 会另起 watcher 写最后状态；先等它收尾，再删除临时目录。
        # 否则 rmtree 与 atomic_json 并发写入会偶发报 Directory not empty。
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            run = console.snapshot()["run"]
            if run and run["status"] not in {"running", "stopping", "indexing"}:
                return run
            time.sleep(0.01)
        self.fail("task did not finish")

    def test_allowlist_and_safe_browser_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            captured = {}

            def fake_popen(command, **kwargs):
                captured.update(command=command, **kwargs)
                return ImmediateProcess()

            console = OperatorConsole(ops_dir=Path(temp), popen=fake_popen)
            with self.assertRaisesRegex(ConsoleError, "开启浏览器操作"):
                console.start({"kind": "once"})
            console.update_settings({"browserEnabled": True})
            with self.assertRaisesRegex(ConsoleError, "不支持"):
                console.start({"kind": "submit"})
            with self.assertRaisesRegex(ConsoleError, "已配置"):
                console.start({"kind": "scan", "term": "$(malicious)"})
            console.start({"kind": "scan", "term": "paper shopping bag", "limit": 2})
            self.assertEqual(captured["command"][-5:], ["scan", "--term", "paper shopping bag", "--max", "10"])
            self.assertEqual(captured["env"]["AUTO_CONTACT_MODE"], "off")
            self.assertEqual(captured["env"]["ALLOW_LIVE_SUBMIT"], "false")
            self.assertEqual(captured["env"]["SEARCH_TERMS"], "paper shopping bag")
            self.assertEqual(captured["env"]["MAX_NEW_RFQS_PER_CYCLE"], "2")
            for _ in range(100):
                if console.snapshot()["run"]["status"] != "running":
                    break
                time.sleep(0.02)

    def test_all_terms_overrides_inherited_search_terms(self):
        with tempfile.TemporaryDirectory() as temp:
            captured = {}

            def fake_popen(command, **kwargs):
                captured.update(command=command, **kwargs)
                return ImmediateProcess()

            console = OperatorConsole(ops_dir=Path(temp), popen=fake_popen)
            console.update_settings({"browserEnabled": True})
            # 即使服务启动的 shell 限定了子集，页面“全部”仍必须覆盖它。
            with mock.patch.dict(case_console.os.environ, {"SEARCH_TERMS": "cloth bag"}):
                console.start({"kind": "scan", "term": "__all__"})
            self.assertEqual(Path(captured["command"][1]).name, "scan_all_terms.mjs")
            self.assertEqual(captured["env"]["SEARCH_TERMS"], ",".join(case_console.SEARCH_TERMS))
            self.assertEqual(self.wait_for_completion(console)["status"], "completed")

            # once/watch 共用同一个环境构造路径，也不能回退到 shell 子集。
            # 不启动真实 Agent；只捕获 start() 交给进程的环境。
            with mock.patch.object(case_console.threading, "Thread"), mock.patch.dict(
                    case_console.os.environ, {"SEARCH_TERMS": "cloth bag"}):
                for kind in ("once", "watch"):
                    console.start({"kind": kind, "term": "__all__"})
                    self.assertEqual(captured["env"]["SEARCH_TERMS"], ",".join(case_console.SEARCH_TERMS))
                    self.assertEqual(captured["env"]["AUTO_CONTACT_MODE"], "off")
                    console.current = console.process = None

    def test_env_check_parses_bridge_status(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            console.update_settings({"browserEnabled": True})
            process = mock.Mock(returncode=0)
            process.communicate.return_value = ('{"connected": true, "loggedIn": true, "tabId": 42}\n', '')
            console.popen = mock.Mock(return_value=process)
            report = console.env_check()
            by_key = {item["key"]: item for item in report["checks"]}
            self.assertTrue(report["ok"])
            self.assertTrue(by_key["node"]["ok"])
            self.assertTrue(by_key["plugin"]["ok"])
            self.assertTrue(by_key["bridge"]["ok"])
            self.assertIn("42", by_key["bridge"]["detail"])
            self.assertTrue(by_key["login"]["ok"])
            cached = console.env_check()
            self.assertEqual(cached["checkedAt"], report["checkedAt"])
            console.popen.assert_called_once()

            # force 和成功缓存都不能绕过已关闭的浏览器授权。
            console.update_settings({"browserEnabled": False})
            self.assertEqual(console.env_check(force=True)["status"], "skipped")
            self.assertFalse(console.env_check()["ok"])
            console.popen.assert_called_once()

    def test_env_check_reports_disconnected_bridge(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            console.update_settings({"browserEnabled": True})
            process = mock.Mock(returncode=1)
            process.communicate.return_value = ('', '')
            console.popen = mock.Mock(return_value=process)
            report = console.env_check()
            by_key = {item["key"]: item for item in report["checks"]}
            self.assertFalse(report["ok"])
            self.assertFalse(by_key["bridge"]["ok"])
            self.assertFalse(by_key["login"]["ok"])

    def test_env_check_never_connects_when_disabled_or_task_is_running(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp), popen=mock.Mock())
            self.assertEqual(console.env_check(force=True)["status"], "skipped")
            console.update_settings({"browserEnabled": True})
            console.current = {"kind": "scan", "status": "running"}
            self.assertEqual(console.env_check(force=True)["status"], "skipped")
            console.popen.assert_not_called()

    def test_env_check_owns_browser_until_probe_completes(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            console.update_settings({"browserEnabled": True, "quoteEnabled": True})

            def communicate(**_kwargs):
                self.assertTrue(console.snapshot()["envChecking"])
                self.assertEqual(console.env_check(force=True)["status"], "skipped")
                with self.assertRaisesRegex(ConsoleError, "环境检测正在进行"):
                    console.start({"kind": "scan"})
                with self.assertRaisesRegex(ConsoleError, "环境检测正在进行"):
                    console.start_quote({"kind": "fill", "approved": True})
                return ('{"connected":true,"loggedIn":true}', '')

            process = mock.Mock(returncode=0)
            process.communicate.side_effect = communicate
            console.popen = mock.Mock(return_value=process)
            self.assertTrue(console.env_check()["ok"])
            self.assertFalse(console.snapshot()["envChecking"])
            console.popen.assert_called_once()

    def test_disabling_browser_cancels_live_probe_and_discards_result(self):
        with tempfile.TemporaryDirectory() as temp:
            started = threading.Event()
            children = []

            def fake_status(_command, **kwargs):
                # 用休眠的本地 Python 子进程验证真实进程组终止，不碰 Chrome。
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                         **{key: value for key, value in kwargs.items() if key != "env"})
                children.append(child)
                started.set()
                return child

            console = OperatorConsole(ops_dir=Path(temp), popen=fake_status)
            console.update_settings({"browserEnabled": True})
            result = {}
            thread = threading.Thread(target=lambda: result.update(console.env_check()))
            thread.start()
            try:
                self.assertTrue(started.wait(2))
                self.assertTrue(console.snapshot()["envChecking"])
                console.update_settings({"browserEnabled": False})
                console.update_settings({"browserEnabled": True})
                thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertLess(children[0].returncode, 0)
                self.assertEqual(result["status"], "skipped")
                self.assertIsNone(console._env_cache)
            finally:
                console.close()
                thread.join(2)

    def test_env_timeout_kills_and_reaps_owned_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            children = []

            def fake_status(_command, **kwargs):
                child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
                children.append(child)
                return child

            console = OperatorConsole(ops_dir=Path(temp), popen=fake_status)
            console.update_settings({"browserEnabled": True})
            with mock.patch.object(case_console, "ENV_CHECK_TIMEOUT_SECONDS", 0.03):
                report = console.env_check()
            self.assertFalse(report["ok"])
            self.assertLess(children[0].returncode, 0)
            self.assertFalse(console.snapshot()["envChecking"])

    def test_disabling_browser_stops_owned_process(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            console._command = lambda *_: [sys.executable, "-c", "import time; time.sleep(30)"]
            console.update_settings({"browserEnabled": True})
            try:
                console.start({"kind": "scan"})
                self.assertEqual(console.snapshot()["run"]["status"], "running")
                console.update_settings({"browserEnabled": False})
                for _ in range(50):
                    if console.snapshot()["run"]["status"] == "stopped":
                        break
                    time.sleep(0.02)
                self.assertEqual(console.snapshot()["run"]["status"], "stopped")
            finally:
                console.close()

    def test_analysis_completion_refreshes_case_index(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            (root / "scripts/build_case_catalog.mjs").write_text("import fs from 'node:fs'; fs.writeFileSync('indexed', 'ok');\n")
            console = OperatorConsole(root=root, ops_dir=root / "ops", popen=lambda *_args, **_kwargs: ImmediateProcess())
            console.update_settings({"browserEnabled": True})
            console.start({"kind": "once"})
            for _ in range(100):
                if console.snapshot()["run"]["status"] == "completed":
                    break
                time.sleep(0.02)
            self.assertEqual(console.snapshot()["run"]["status"], "completed")
            self.assertEqual((root / "indexed").read_text(), "ok")

    def test_quote_submit_requires_switch_review_and_exact_rfq(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            (root / "scripts/build_case_catalog.mjs").write_text("import fs from 'node:fs'; fs.writeFileSync('indexed', 'ok');\n")
            captured = {}

            def fake_popen(command, **kwargs):
                output_status = captured.get("output_status", "submitted")
                captured.update(command=command, **kwargs)
                kwargs["stdout"].write(json.dumps({"status": output_status}).encode() + b"\n")
                kwargs["stdout"].flush()
                return ImmediateProcess()

            console = OperatorConsole(root=root, ops_dir=root / "ops", popen=fake_popen)
            console.review_quote = lambda _draft_id: {
                "reviewHash": "a" * 64, "rfq": {"id": "rfq-exact"}, "quote": {"categoryId": "tumbler_40oz"},
                "draft": {"port": "verified port"}, "fillEligible": True, "fillReasons": [],
                "submitEligible": True, "submitReasons": []
            }
            request = {"kind": "submit", "draftId": "rfq-exact", "reviewHash": "a" * 64,
                       "confirmation": "rfq-exact", "approved": True}
            with self.assertRaisesRegex(ConsoleError, "开启浏览器操作和浏览器报价"):
                console.start_quote(request)
            console.update_settings({"browserEnabled": True, "quoteEnabled": True})
            with self.assertRaisesRegex(ConsoleError, "重新审阅"):
                console.start_quote({**request, "reviewHash": "b" * 64})
            with self.assertRaisesRegex(ConsoleError, "完整 ID"):
                console.start_quote({**request, "confirmation": "wrong"})
            console.start_quote(request)
            self.assertEqual(captured["command"][-4:], ["submit", "rfq-exact", "a" * 64, "rfq-exact"])
            self.assertEqual(captured["env"]["AUTO_CONTACT_MODE"], "submit")
            self.assertEqual(captured["env"]["ALLOW_LIVE_SUBMIT"], "true")
            self.assertEqual(captured["env"]["AUTO_CONTACT_CATEGORIES"], "tumbler_40oz")
            self.assertEqual(captured["env"]["QUOTE_PORT"], "verified port")
            for _ in range(100):
                if console.snapshot()["run"]["status"] == "completed":
                    break
                time.sleep(0.02)
            self.assertEqual(console.snapshot()["run"]["status"], "completed")
            captured["output_status"] = "skipped"
            console.start_quote(request)
            for _ in range(100):
                if console.snapshot()["run"]["status"] == "attention":
                    break
                time.sleep(0.02)
            self.assertEqual(console.snapshot()["run"]["status"], "attention")

    def test_http_post_requires_same_origin_and_custom_header(self):
        with tempfile.TemporaryDirectory() as temp:
            server = ThreadingHTTPServer(("127.0.0.1", 0), CaseHandler)
            server.console = OperatorConsole(ops_dir=Path(temp))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                payload = json.dumps({"browserEnabled": True})
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                connection.request("POST", "/api/ops/settings", payload,
                                   {"Content-Type": "application/json", "X-Case-Console": "1", "Origin": "https://other.example"})
                self.assertEqual(connection.getresponse().status, 403)
                connection.close()
                self.assertFalse(server.console.snapshot()["settings"]["browserEnabled"])
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                connection.request("POST", "/api/ops/settings", payload,
                                   {"Content-Type": "application/json", "X-Case-Console": "1",
                                    "Origin": f"http://127.0.0.1:{server.server_port}"})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["settings"]["browserEnabled"])
                connection.close()
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
