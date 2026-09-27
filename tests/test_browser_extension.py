import hashlib
import http.client
import json
import stat
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from scripts.browser_extension import BrowserExtension, ExtensionError, ROOT
from scripts.case_console import OperatorConsole
from scripts.serve_case_catalog import CaseHandler


class ExtensionTest(unittest.TestCase):
    def make_bundle(self, root, unsafe=None, symlink=False):
        vendor = root / "vendor"
        vendor.mkdir()
        archive_path = vendor / "extension.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"name": "Test Extension", "version": "1.0", "manifest_version": 3}))
            archive.writestr("scripts/worker.js", "// fixture")
            if unsafe:
                entry = zipfile.ZipInfo(unsafe)
                if symlink:
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, "../../outside")
        metadata = {"name": "Test Extension", "releaseVersion": "1.0", "manifestVersion": "1.0",
                    "archive": "extension.zip", "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest()}
        (vendor / "extension.json").write_text(json.dumps(metadata))
        return BrowserExtension(vendor_dir=vendor, install_root=root / "installed")

    def test_official_bundle_is_complete_and_matches_locked_sdk(self):
        # 实际官方归档也进入测试；SDK 或 ZIP 被单独替换时必须更新配套资源。
        with tempfile.TemporaryDirectory() as temp:
            extension = BrowserExtension(install_root=Path(temp))
            lock = json.loads((ROOT / "package-lock.json").read_text())
            self.assertEqual(extension.metadata["releaseVersion"], lock["packages"]["node_modules/@midscene/web"]["version"])
            self.assertEqual(len(extension.archive_bytes()), extension.metadata["size"])
            with mock.patch("scripts.browser_extension.zipfile.ZipFile", wraps=zipfile.ZipFile) as reader:
                self.assertTrue(extension.prepare()["ready"])
                marker_time = (extension.directory / ".bundle.json").stat().st_mtime_ns
                self.assertTrue(extension.prepare()["ready"])
                self.assertEqual(reader.call_count, 1)
                self.assertEqual(marker_time, (extension.directory / ".bundle.json").stat().st_mtime_ns)
            manifest = json.loads((extension.directory / "manifest.json").read_text())
            self.assertEqual(manifest["version"], "1.99")
            self.assertTrue((extension.directory / manifest["background"]["service_worker"]).is_file())
            self.assertTrue((extension.directory / manifest["side_panel"]["default_path"]).is_file())
            self.assertTrue((extension.directory / "fonts/open-sans/Apache License.txt").is_file())

    def test_tampered_zip_is_rejected_even_when_directory_was_prepared(self):
        with tempfile.TemporaryDirectory() as temp:
            extension = self.make_bundle(Path(temp))
            extension.prepare()
            extension.archive.write_bytes(b"corrupted")
            with self.assertRaisesRegex(ExtensionError, "校验失败"):
                extension.prepare()
            with self.assertRaisesRegex(ExtensionError, "校验失败"):
                extension.archive_bytes()

    def test_unsafe_entries_never_escape_or_leave_an_installable_directory(self):
        for name, symlink in [("../../outside", False), ("/outside", False),
                              ("..\\outside", False), ("link", True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                extension = self.make_bundle(root, name, symlink)
                with self.assertRaises(ExtensionError):
                    extension.prepare()
                self.assertFalse(extension.directory.exists())
                self.assertEqual(list(extension.install_root.iterdir()), [])
                self.assertFalse((root / "outside").exists())

    def test_incomplete_existing_directory_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            extension = self.make_bundle(Path(temp))
            extension.directory.mkdir(parents=True)
            custom = extension.directory / "user-file"
            custom.write_text("preserve")
            with self.assertRaisesRegex(ExtensionError, "目录不完整"):
                extension.prepare()
            self.assertEqual(custom.read_text(), "preserve")

    def test_install_routes_work_without_catalog_or_browser_and_require_local_origin(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            extension = self.make_bundle(root)
            server = ThreadingHTTPServer(("127.0.0.1", 0), CaseHandler)
            server.extension = extension
            server.console = OperatorConsole(ops_dir=root / "ops")
            threading.Thread(target=server.serve_forever, daemon=True).start()

            def request(method, path, origin=None, payload="{}"):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                headers = {"Content-Type": "application/json", "X-Case-Console": "1"}
                if origin:
                    headers["Origin"] = origin
                connection.request(method, path, payload if method == "POST" else None, headers)
                response = connection.getresponse()
                result = (response.status, response.read(), response.getheader("Content-Disposition"))
                connection.close()
                return result

            try:
                # 不读取私有 CASE，不运行任何浏览器检测命令。
                with mock.patch.object(CaseHandler, "refresh_catalog", side_effect=AssertionError("catalog not needed")), mock.patch.object(
                        server.console, "popen", side_effect=AssertionError("browser not needed")):
                    self.assertFalse(json.loads(request("GET", "/api/extension")[1])["ready"])
                    self.assertEqual(request("POST", "/api/extension/prepare", "https://other.example")[0], 403)
                    self.assertEqual(request("POST", "/api/extension/prepare")[0], 403)
                    self.assertFalse(extension.directory.exists())
                    origin = f"http://127.0.0.1:{server.server_port}"
                    self.assertEqual(request("POST", "/api/extension/prepare", origin, '{"path":"/tmp"}')[0], 400)
                    status, body, _ = request("POST", "/api/extension/prepare", origin)
                    self.assertEqual(status, 200)
                    self.assertTrue(json.loads(body)["ready"])
                    self.assertEqual(json.loads(body)["installPath"], str(extension.directory.resolve()))
                    status, body, disposition = request("GET", "/api/extension/download")
                    self.assertEqual(status, 200)
                    self.assertEqual(body, extension.archive_bytes())
                    self.assertIn("extension.zip", disposition)
                    self.assertFalse(server.console.snapshot()["settings"]["browserEnabled"])
                    self.assertFalse(server.console.snapshot()["settings"]["quoteEnabled"])
            finally:
                server.shutdown()
                server.console.close()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
