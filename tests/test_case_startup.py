import errno
import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import scripts.serve_case_catalog as startup


class StartupTest(unittest.TestCase):
    def setUp(self):
        # 私有数据集不进入 Git；启动提示测试不能依赖开发者本机的 data/。
        patcher = mock.patch.object(startup, "CATALOG_FILE")
        self.catalog = patcher.start()
        self.catalog.exists.return_value = True
        self.addCleanup(patcher.stop)
        # 启动提示单测不解压到开发者正在使用的 Chrome 插件目录。
        patcher = mock.patch.object(startup, "BrowserExtension")
        self.extension = patcher.start().return_value
        self.addCleanup(patcher.stop)

    def test_default_startup_shows_address_usage_and_shutdown_instructions(self):
        server = mock.Mock(server_port=8888)
        server.serve_forever.side_effect = KeyboardInterrupt
        output = io.StringIO()
        with mock.patch.object(startup.CaseHandler, "refresh_catalog"), mock.patch.object(
                startup, "ThreadingHTTPServer", return_value=server) as constructor, mock.patch.object(
                startup, "OperatorConsole"), mock.patch.object(startup.signal, "signal"), redirect_stdout(output):
            result = startup.main([])
        constructor.assert_called_once_with(("127.0.0.1", 8888), startup.CaseHandler)
        self.assertEqual(result, 0)
        self.assertIn("http://localhost:8888/", output.getvalue())
        self.assertIn("数据集管理", output.getvalue())
        self.assertIn("Ctrl+C", output.getvalue())
        self.assertIn("已关闭", output.getvalue())
        server.console.close.assert_called_once()
        server.server_close.assert_called_once()
        self.extension.prepare.assert_called_once()
        self.assertIn("安装 Midscene 插件", output.getvalue())

    def test_occupied_port_returns_plain_instructions_instead_of_traceback(self):
        error = OSError(errno.EADDRINUSE, "Address already in use")
        output = io.StringIO()
        with mock.patch.object(startup.CaseHandler, "refresh_catalog"), mock.patch.object(
                startup, "ThreadingHTTPServer", side_effect=error), redirect_stderr(output):
            result = startup.main(["--port", "8889"])
        self.assertEqual(result, 1)
        self.assertIn("端口 8889 已被占用", output.getvalue())
        self.assertIn("http://localhost:8889/", output.getvalue())
        self.assertIn("Ctrl+C", output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())

    def test_missing_catalog_points_to_the_single_start_command(self):
        self.catalog.exists.return_value = False
        output = io.StringIO()
        with mock.patch.object(startup, "ThreadingHTTPServer") as constructor, redirect_stderr(output):
            self.assertEqual(startup.main([]), 1)
        self.assertIn("npm start", output.getvalue())
        constructor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
