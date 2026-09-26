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

    def test_scan_all_terms_runs_each_category_without_term_override(self):
        with tempfile.TemporaryDirectory() as temp:
            captured = {}

            def fake_popen(command, **kwargs):
                captured.update(command=command, **kwargs)
                return ImmediateProcess()

            console = OperatorConsole(ops_dir=Path(temp), popen=fake_popen)
            console.update_settings({"browserEnabled": True})
            console.start({"kind": "scan", "term": "__all__"})
            self.assertEqual(captured["command"][:2], ["/bin/sh", "-c"])
            script = captured["command"][2]
            for term in case_console.SEARCH_TERMS:
                self.assertIn(f'--term "{term}"', script)
            self.assertNotIn("SEARCH_TERMS", captured["env"])

    def test_env_check_parses_bridge_status(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            fake = subprocess.CompletedProcess([], 0, stdout='{"connected": true, "loggedIn": true, "tabId": 42}\n')
            with mock.patch.object(case_console.subprocess, "run", return_value=fake):
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

    def test_env_check_reports_disconnected_bridge(self):
        with tempfile.TemporaryDirectory() as temp:
            console = OperatorConsole(ops_dir=Path(temp))
            fake = subprocess.CompletedProcess([], 1, stdout="")
            with mock.patch.object(case_console.subprocess, "run", return_value=fake):
                report = console.env_check()
            by_key = {item["key"]: item for item in report["checks"]}
            self.assertFalse(report["ok"])
            self.assertFalse(by_key["bridge"]["ok"])
            self.assertFalse(by_key["login"]["ok"])

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
