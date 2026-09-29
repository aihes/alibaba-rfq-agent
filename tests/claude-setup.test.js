import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { DesktopSettings } from "../src/desktop/settings.js";
import { readModelEnvironment, findLocalClaudeExecutable } from "../src/desktop/model-environment.js";
import { createCaseServer } from "../src/desktop/server.js";

const require = createRequire(import.meta.url);
const { configure } = require("../scripts/configure-local-claude.cjs");
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "rfq-claude-setup-"));
const fakeClaude = (home) => {
  const file = path.join(home, ".local/bin/claude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\necho 'Claude Code test version'\n", { mode: 0o755 });
  return file;
};

test("setup preserves Claude settings, backs them up, and makes the desktop detect the configured CLI", async () => {
  const home = temporary(), executable = fakeClaude(home);
  try {
    const file = path.join(home, ".claude/settings.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Read"] }, env: { KEEP_ME: "yes",
      ANTHROPIC_API_KEY: "old-api-key", ANTHROPIC_API_URL: "https://old.example/v1/messages" } }));
    const result = configure({ home, region: "zai", executable, key: "synthetic-secret-key" });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.permissions, { allow: ["Read"] });
    assert.equal(saved.env.KEEP_ME, "yes");
    assert.equal(saved.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, "synthetic-secret-key");
    assert.equal(saved.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(saved.env.ANTHROPIC_API_URL, undefined);
    assert.equal(saved.env.LOCAL_CLAUDE_EXECUTABLE, executable);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.backup, "utf8")), { permissions: { allow: ["Read"] }, env: { KEEP_ME: "yes",
      ANTHROPIC_API_KEY: "old-api-key", ANTHROPIC_API_URL: "https://old.example/v1/messages" } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
    const environment = await readModelEnvironment({ env: { GLM_API_KEY: "other-environment-key",
      ANTHROPIC_AUTH_TOKEN: "old-token", ANTHROPIC_BASE_URL: "https://other.example/api/anthropic" }, platform: "win32", claudeSettingsFile: file });
    const settings = new DesktopSettings(home, { decryptString: () => "" }, { localEnvironment: environment,
      detectClaude: (variables) => findLocalClaudeExecutable(variables, home) });
    settings.save({ modelConfigSource: "manual", agentProvider: "local-claude-sdk" });
    assert.equal(settings.info().claudeExecutableAvailable, true);
    assert.equal(settings.environment().ANTHROPIC_AUTH_TOKEN, "synthetic-secret-key");
    assert.equal(settings.environment().ANTHROPIC_API_KEY, undefined);
    assert.equal(settings.environment().ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("invalid Key or JSON leaves existing Claude settings untouched", () => {
  const home = temporary(), executable = fakeClaude(home);
  try {
    const directory = path.join(home, ".claude"), file = path.join(directory, "settings.json");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, '{"env":{"KEEP_ME":"yes"}}');
    const original = fs.readFileSync(file, "utf8");
    assert.throws(() => configure({ home, region: "china", executable, key: "bad key" }), /无效/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fs.writeFileSync(file, "broken json");
    assert.throws(() => configure({ home, region: "china", executable, key: "synthetic-key" }), /有效 JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "broken json");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("macOS setup uses an installed CLI and reads the Key from terminal input", { skip: process.platform !== "darwin" }, () => {
  const home = temporary(); fakeClaude(home);
  try {
    const script = path.resolve("scripts/setup-local-claude-macos.command");
    const result = spawnSync("/bin/bash", [script], { input: "y\n1\nsynthetic-script-key\n", encoding: "utf8",
      env: { ...process.env, HOME: home }, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /synthetic-script-key/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(saved.env.ANTHROPIC_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, "synthetic-script-key");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("macOS setup invokes only the official installer when Claude is absent", { skip: process.platform !== "darwin" }, () => {
  const home = temporary(), bin = path.join(home, "test-bin");
  fs.mkdirSync(bin);
  const mockCurl = path.join(bin, "curl");
  fs.writeFileSync(mockCurl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then shift; output="$1"; fi
  shift
done
cat > "$output" <<'INSTALL'
#!/bin/sh
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\necho "Claude Code test version"\\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
INSTALL
`, { mode: 0o755 });
  try {
    const script = path.resolve("scripts/setup-local-claude-macos.command");
    const result = spawnSync("/bin/bash", [script], { input: "y\n2\nsynthetic-new-key\n", encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8")).env.ANTHROPIC_BASE_URL,
      "https://api.z.ai/api/anthropic");
    assert.doesNotMatch(result.stdout, /synthetic-new-key/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the setup launcher requires a same-origin desktop action", async () => {
  const root = temporary();
  fs.mkdirSync(path.join(root, "data/case-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/case-catalog/cases.json"), '{"cases":[],"counts":{}}');
  const settings = new DesktopSettings(root, { decryptString: () => "" });
  let opened = 0;
  const service = await createCaseServer({ resources: path.resolve("."), workspace: root, desktop: true,
    desktopSettings: settings, openClaudeSetup: async () => { opened++; return { opened: true }; } });
  try {
    const route = service.url + "api/desktop/claude/setup", origin = new URL(service.url).origin;
    const request = (headers, body = "{}") => fetch(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    assert.equal((await request({ Origin: "https://example.invalid", "X-Case-Console": "1" })).status, 403);
    assert.equal((await request({ Origin: origin, "X-Case-Console": "1" }, '{"key":"secret"}')).status, 409);
    assert.equal(opened, 0);
    assert.equal((await request({ Origin: origin, "X-Case-Console": "1" })).status, 200);
    assert.equal(opened, 1);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
