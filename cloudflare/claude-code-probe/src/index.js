import { Container, getContainer } from "@cloudflare/containers";

const packageName = "@anthropic-ai/claude-code@2.1.284";
const decoder = new TextDecoder();
const model = "GLM-5.3[1m]";

export class ClaudeCodeProbe extends Container {
  // The public Node image avoids a local Docker build for this bounded test.
  // Its disk is ephemeral, so the official npm package is installed on first use.
  entrypoint = ["sleep", "infinity"];
  sleepAfter = "45s";

  async withClaude(run) {
    let started = this.ctx.container.running;
    try {
      if (!started) {
        await this.start();
        started = true;
      }
      let process = await this.ctx.container.exec(["sh", "-c", "claude --version"]);
      let result = await process.output();
      if (result.exitCode !== 0) {
        process = await this.ctx.container.exec(["npm", "install", "--global", "--no-audit", "--no-fund", packageName], { stdout: "ignore" });
        result = await process.output();
        if (result.exitCode !== 0) throw new Error(`Claude Code install failed: ${decoder.decode(result.stderr).slice(-1200)}`);
        process = await this.ctx.container.exec(["sh", "-c", "claude --version"]);
        result = await process.output();
      }
      if (result.exitCode !== 0) throw new Error(`Claude Code verification failed: ${decoder.decode(result.stderr).slice(-1200)}`);
      return await run(decoder.decode(result.stdout).trim());
    } finally {
      // Explicitly destroy the test instance after use to bound paid runtime.
      if (started) await this.destroy();
    }
  }

  async cliVersion() {
    return this.withClaude((version) => version);
  }

  async modelProbe(authToken, baseUrl) {
    return this.withClaude(async () => {
      const process = await this.ctx.container.exec(
        [
          "claude", "-p", "Reply exactly GLM_REMOTE_OK", "--model", model,
          "--output-format", "json", "--max-turns", "1", "--tools", "",
          "--disallowedTools", "mcp__*", "--restricted", "--no-session-persistence"
        ],
        {
          cwd: "/tmp",
          env: {
            ANTHROPIC_AUTH_TOKEN: authToken,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_MODEL: model,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
          }
        }
      );
      const output = await process.output();
      let response;
      try {
        response = JSON.parse(decoder.decode(output.stdout));
      } catch {
        response = null;
      }
      if (output.exitCode !== 0 || response?.is_error || typeof response?.result !== "string") {
        const detail = `${decoder.decode(output.stderr)}\n${response?.result ?? ""}`;
        const category = /401|403|unauthoriz|invalid.*key|authenticat/i.test(detail) ? "authentication"
          : /429|rate.limit|quota|balance|limit.exceed/i.test(detail) ? "limit"
          : /connect|timeout|network|fetch failed/i.test(detail) ? "network"
          : "cli_or_provider";
        return { ok: false, category, exitCode: output.exitCode };
      }
      return { ok: true, model, result: response.result.trim() };
    });
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/") {
      return Response.json({ service: "rfq-claude-code-probe", status: "worker-ready" }, { headers: { "Cache-Control": "no-store" } });
    }
    const isVersion = request.method === "GET" && pathname === "/version";
    const isModelProbe = request.method === "POST" && pathname === "/test-model";
    if (!isVersion && !isModelProbe) return new Response("Not found", { status: 404 });
    if (!env.PROBE_TOKEN) return new Response("Probe is not configured", { status: 503 });
    if (request.headers.get("Authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    if (isModelProbe && !env.GLM_API_KEY) return new Response("Model is not configured", { status: 503 });
    try {
      if (isVersion) {
        const version = await getContainer(env.CLAUDE_CODE_PROBE, "version-probe").cliVersion();
        return Response.json({ ok: true, version }, { headers: { "Cache-Control": "no-store" } });
      }
      const result = await getContainer(env.CLAUDE_CODE_PROBE, "model-probe").modelProbe(
        env.GLM_API_KEY,
        "https://open.bigmodel.cn/api/anthropic"
      );
      return Response.json(result, { status: result.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Claude Code probe failed", error?.name ?? "unknown");
      return Response.json({ ok: false, error: "Container or Claude Code execution failed" }, { status: 502 });
    }
  }
};
