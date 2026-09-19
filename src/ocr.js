import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectDir } from "./config.js";
import { sanitizeRfqText } from "./utils.js";

const execFileAsync = promisify(execFile);

async function ensureOcrBinary() {
  const sourcePath = path.join(projectDir, "scripts/ocr.m");
  const cacheDir = path.join(projectDir, "data/.cache");
  const binaryPath = path.join(cacheDir, "macos-vision-ocr");
  fs.mkdirSync(cacheDir, { recursive: true });
  const needsBuild = !fs.existsSync(binaryPath)
    || fs.statSync(binaryPath).mtimeMs < fs.statSync(sourcePath).mtimeMs;
  if (needsBuild) {
    await execFileAsync("/usr/bin/xcrun", [
      "clang", "-fobjc-arc", "-framework", "Foundation", "-framework", "AppKit", "-framework", "Vision",
      sourcePath, "-o", binaryPath
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  }
  return binaryPath;
}

export async function extractImageText(imagePath) {
  if (process.platform !== "darwin") {
    return { status: "unavailable", text: "", error: "Local Vision OCR currently requires macOS" };
  }
  try {
    const binaryPath = await ensureOcrBinary();
    const { stdout } = await execFileAsync(binaryPath, [path.resolve(imagePath)], {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8"
    });
    const text = sanitizeRfqText(stdout).trim();
    return { status: text ? "read" : "empty", text, error: "" };
  } catch (error) {
    return { status: "error", text: "", error: String(error.stderr || error.message).slice(0, 500) };
  }
}
