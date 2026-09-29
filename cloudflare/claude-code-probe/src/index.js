import { Container, getContainer } from "@cloudflare/containers";

const packageName = "@anthropic-ai/claude-code@2.1.284";
const decoder = new TextDecoder();

export class ClaudeCodeProbe extends Container {
  // The public Node image avoids a local Docker build for this bounded test.
  // Its disk is ephemeral, so the official npm package is installed on first use.
  entrypoint = ["sleep", "infinity"];
  sleepAfter = "45s";

  async cliVersion() {
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
      return decoder.decode(result.stdout).trim();
    } finally {
      // Explicitly destroy the test instance after use to bound paid runtime.
      if (started) await this.destroy();
    }
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/") {
      return Response.json({ service: "rfq-claude-code-probe", status: "worker-ready" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method !== "GET" || pathname !== "/version") return new Response("Not found", { status: 404 });
    if (!env.PROBE_TOKEN) return new Response("Probe is not configured", { status: 503 });
    if (request.headers.get("Authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    try {
      const version = await getContainer(env.CLAUDE_CODE_PROBE, "version-probe").cliVersion();
      return Response.json({ ok: true, version }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Claude Code probe failed", error);
      return Response.json({ ok: false, error: "Container setup or version check failed" }, { status: 502 });
    }
  }
};
