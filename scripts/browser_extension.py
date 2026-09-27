"""Prepare the bundled official Chrome extension without network or browser access."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import stat
import tempfile
import threading
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]


class ExtensionError(Exception):
    pass


class BrowserExtension:
    def __init__(self, vendor_dir=None, install_root=None):
        self.vendor_dir = Path(vendor_dir or ROOT / "vendor/midscene")
        self.install_root = Path(install_root or ROOT / "data/browser-extension")
        self.metadata = json.loads((self.vendor_dir / "extension.json").read_text())
        self.archive = self.vendor_dir / self.metadata["archive"]
        self.directory = self.install_root / f"midscene-v{self.metadata['releaseVersion']}"
        self.lock = threading.Lock()

    def _ready(self):
        if self.directory.is_symlink():
            return False
        try:
            marker = json.loads((self.directory / ".bundle.json").read_text())
            manifest = json.loads((self.directory / "manifest.json").read_text())
            return (marker["sha256"] == self.metadata["sha256"]
                    and manifest["version"] == self.metadata["manifestVersion"]
                    and bool(marker["files"])
                    and all((self.directory / name).is_file() for name in marker["files"]))
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def info(self):
        return {"name": self.metadata["name"], "releaseVersion": self.metadata["releaseVersion"],
                "manifestVersion": self.metadata["manifestVersion"], "ready": self._ready(),
                "installPath": str(self.directory.resolve()), "downloadUrl": "/api/extension/download"}

    def archive_bytes(self):
        # 固定文件由项目提供，HTTP 调用者不能指定本机路径。准备和下载都校验
        # 官方发布的摘要，损坏资源不会被当成可安装文件交给用户。
        try:
            body = self.archive.read_bytes()
        except OSError as error:
            raise ExtensionError("项目内的 Midscene 安装包无法读取，请重新获取完整项目。") from error
        if hashlib.sha256(body).hexdigest() != self.metadata["sha256"]:
            raise ExtensionError("Midscene 安装包校验失败，请重新获取完整项目。")
        return body

    def prepare(self):
        # 页面与启动流程可能同时准备；只操作本项目固定目录，不启动 Chrome、
        # 不修改浏览器配置，也不替用户授予插件或报价权限。
        with self.lock:
            body = self.archive_bytes()
            if self._ready():
                return self.info()
            if self.directory.exists() or self.directory.is_symlink():
                raise ExtensionError("插件目录不完整。请关闭该插件，删除页面显示的插件目录，再点击准备安装文件。")
            staging = None
            try:
                self.install_root.mkdir(parents=True, exist_ok=True)
                staging = Path(tempfile.mkdtemp(prefix=".midscene-", dir=self.install_root))
                with zipfile.ZipFile(io.BytesIO(body)) as archive:
                    entries = archive.infolist()
                    if sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
                        raise ExtensionError("Midscene 安装包解压大小异常。")
                    for entry in entries:
                        path = PurePosixPath(entry.filename)
                        # ZIP 使用 POSIX 路径；拒绝逃逸路径、Windows 分隔符和符号
                        # 链接，防止未来更换安装包时写到目标目录以外。
                        if (path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                                or ":" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16)):
                            raise ExtensionError("Midscene 安装包包含不安全的文件路径。")
                        (staging / path).resolve().relative_to(staging.resolve())
                    archive.extractall(staging)
                manifest = json.loads((staging / "manifest.json").read_text())
                if (manifest.get("name") != self.metadata["name"]
                        or manifest.get("version") != self.metadata["manifestVersion"]
                        or manifest.get("manifest_version") != 3):
                    raise ExtensionError("Midscene 插件版本与本地资源记录不一致。")
                marker = {"sha256": self.metadata["sha256"],
                          "files": [entry.filename for entry in entries if not entry.is_dir()]}
                (staging / ".bundle.json").write_text(json.dumps(marker))
                # 先完整解压到临时目录，再落到稳定路径。Chrome 会持续引用这里，
                # 因此后续启动复用原目录，不能在每次启动时删除/换到临时路径。
                staging.rename(self.directory)
                return self.info()
            except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
                raise ExtensionError("无法准备 Midscene 插件文件，请检查项目目录的写入权限或重新获取项目。") from error
            finally:
                if staging and staging.exists():
                    shutil.rmtree(staging)
