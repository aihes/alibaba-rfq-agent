import { requireAccessAdmin, clientConfig, publicClient } from "./admin-auth.js";
import { adminHtml, adminCss, adminJs } from "./admin-page.js";
import { Container, getContainer } from "@cloudflare/containers";
export { ContainerProxy } from "@cloudflare/containers";
import quoteSkill from "../../../src/skills/rfq-quote-advisor/SKILL.md";
import agentSdkRunner from "./agent-sdk-runner.txt";
import sdkProbeRunner from "./sdk-probe-runner.txt";
import { AGENT_WORKSPACE, CLAUDE_CONFIG_DIR, SKILL_FILE, SKILL_NAME,
  PROBE_MODEL_URL, PROXY_AUTH_TOKEN, RUN_TIMEOUT_MS, SERVICE_MODEL_URL, TOOL_BOUNDARY,
  agentPrompt, dropToNode, runAsNodeScript,
  modelRequestAllowed, writeSkillScript } from "./agent-runtime.js";
import {
  ApiError, callGlmOcr, readJson,
  selectAgentModel, validateAgent, validateOcr
} from "./service.js";

const packageName = "@anthropic-ai/claude-code@2.1.284";
const sdkPackageName = "@anthropic-ai/claude-agent-sdk@0.3.285";
const decoder = new TextDecoder();
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const transcriptPath = (nativeId) => `${CLAUDE_CONFIG_DIR}/projects/-tmp-rfq-agent/${nativeId}.jsonl`;
const writeTranscriptScript = `${dropToNode}const fs=require('fs'),p=require('path'),f=process.argv[1],parts=[];process.stdin.on('data',x=>parts.push(x));process.stdin.on('end',()=>{fs.mkdirSync(p.dirname(f),{recursive:true,mode:0o700});fs.writeFileSync(f,Buffer.concat(parts),{mode:0o600})})`;

async function forwardModelRequest(request, env, ctx, provider) {
  let body;
  try {
    body = await readJson(request.clone(), 16 * 1024 * 1024);
  } catch {
    return new Response("Invalid model request", { status: 400 });
  }
  const stub = env.CLAUDE_CODE_PROBE.get(
    env.CLAUDE_CODE_PROBE.idFromString(ctx.containerId));
  const authorization = await stub.authorizeModelRequest({
    url: request.url, method: request.method, model: body.model,
    maxTokens: body.max_tokens
  });
  if (!authorization.allowed) return new Response("Model request denied", { status: 403 });
  const key = provider === "service" ? env.SERVICE_GLM_API_KEY : env.GLM_API_KEY;
  if (!key) return new Response("Model service unavailable", { status: 503 });
  const headers = new Headers(request.headers);
  headers.delete("x-api-key");
  headers.set("Authorization", `Bearer ${key}`);
  headers.delete("Cookie");
  headers.delete("Host");
  const upstreamHost = provider === "service" ? "api.z.ai" : "open.bigmodel.cn";
  const upstreamUrl = new URL(request.url);
  upstreamUrl.protocol = "https:";
  upstreamUrl.hostname = upstreamHost;
  return fetch(new Request(upstreamUrl, { method: request.method, headers,
    body: await request.arrayBuffer(), redirect: "manual" }));
}

const json = (body, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ClaudeCodeProbe extends Container {
  // The public Node image avoids a local Docker build. Claude is installed on
  // first use of each ephemeral container lifetime.
  entrypoint = ["sleep", "infinity"];
  sleepAfter = "45s";
  runTail = Promise.resolve();
  pendingRuns = 0;
  activeRun = null;
  lastAgentDiagnostic = null;
  agentStage = null;

  async agentDiagnostic() {
    return await this.ctx.storage.get("agent-diagnostic") ?? null;
  }

  async authorizeModelRequest(requestInfo) {
    if (!modelRequestAllowed(requestInfo, this.activeRun)) {
      if (this.activeRun) this.activeRun.lastDenial =
        `route_or_budget:${requestInfo.method}:${requestInfo.url}:${this.activeRun.provider}:${this.activeRun.calls}`;
      return { allowed: false };
    }
    const modelMatches = requestInfo.model === this.activeRun.model ||
      (this.activeRun.provider === "probe" && this.activeRun.model === "GLM-5.3[1m]" &&
        requestInfo.model === "GLM-5.3");
    if (!modelMatches ||
        !Number.isInteger(requestInfo.maxTokens) || requestInfo.maxTokens < 1 ||
        requestInfo.maxTokens > 32_000) {
      this.activeRun.lastDenial = `model_or_tokens:${String(requestInfo.model).slice(0, 40)}:${requestInfo.maxTokens}`;
      return { allowed: false };
    }
    this.activeRun.calls += 1;
    return { allowed: true };
  }

  async exclusive(run) {
    const previous = this.runTail;
    let release;
    this.runTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      try {
        if (this.pendingRuns === 0 && this.ctx.container.running) await this.destroy();
      } catch (error) {
        console.error("Container shutdown failed", error?.name ?? "unknown");
      }
      release();
    }
  }

  async ensureClaude() {
    if (!this.ctx.container.running) await this.start();
    let process = await this.ctx.container.exec(["sh", "-c", "claude --version"]);
    let result = await process.output();
    if (result.exitCode !== 0) {
      process = await this.ctx.container.exec(
        ["npm", "install", "--global", "--no-audit", "--no-fund", packageName],
        { stdout: "ignore" }
      );
      result = await process.output();
      if (result.exitCode !== 0) throw new Error("claude_install_failed");
      process = await this.ctx.container.exec(["sh", "-c", "claude --version"]);
      result = await process.output();
    }
    if (result.exitCode !== 0) throw new Error("claude_version_failed");
    return decoder.decode(result.stdout).trim();
  }

  async ensureSdk() {
    if (!this.ctx.container.running) await this.start();
    const install = await this.ctx.container.exec(
      ["npm", "install", "--prefix", "/tmp/rfq-agent-sdk", "--no-audit", "--no-fund",
        "--no-save", sdkPackageName], { stdout: "ignore" });
    if ((await install.output()).exitCode !== 0) throw new Error("sdk_install_failed");
  }

  async cliVersion() {
    return this.exclusive(() => this.ensureClaude());
  }

  async restoreTranscript(nativeId, bytes) {
    const stdin = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    const process = await this.ctx.container.exec(
      ["node", "-e", writeTranscriptScript, transcriptPath(nativeId)],
      { stdin, stdout: "ignore" }
    );
    if ((await process.output()).exitCode !== 0) throw new Error("transcript_restore_failed");
  }

  async installSkill() {
    const bytes = new TextEncoder().encode(quoteSkill);
    const stdin = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); }
    });
    const process = await this.ctx.container.exec(
      ["node", "-e", writeSkillScript, SKILL_FILE],
      { stdin, stdout: "ignore" });
    if ((await process.output()).exitCode !== 0) throw new Error("skill_install_failed");
  }

  async readTranscript(nativeId) {
    const process = await this.ctx.container.exec(["cat", transcriptPath(nativeId)]);
    const output = await process.output();
    if (output.exitCode !== 0 || !output.stdout.byteLength) {
      throw new Error("transcript_read_failed");
    }
    return new Uint8Array(output.stdout);
  }

  async runAgentSdk(query, images, model, nativeId, previousTranscript, skill) {
    this.agentStage = "ensure_sdk";
    await this.ensureSdk();
    this.agentStage = "prepare_workspace";
    if (skill === SKILL_NAME) await this.installSkill();
    else {
      const directory = await this.ctx.container.exec(
        ["node", "-e", `${dropToNode}require('fs').mkdirSync(process.argv[1],{recursive:true,mode:0o700})`, AGENT_WORKSPACE],
        { stdout: "ignore" });
      if ((await directory.output()).exitCode !== 0) throw new Error("workspace_create_failed");
    }
    this.agentStage = "restore_transcript";
    if (previousTranscript) await this.restoreTranscript(nativeId, previousTranscript);
    const input = new TextEncoder().encode(JSON.stringify({
      prompt: agentPrompt(query, skill), images, model, nativeId, cwd: AGENT_WORKSPACE,
      resume: Boolean(previousTranscript), skill, toolBoundary: TOOL_BOUNDARY
    }));
    const stdin = new ReadableStream({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      }
    });
    this.activeRun = { provider: "service", model, calls: 0,
      expiresAt: Date.now() + RUN_TIMEOUT_MS };
    let output;
    let proxyStats;
    try {
      this.agentStage = "start_agent";
      const process = await this.ctx.container.exec(
        ["node", "-e", runAsNodeScript, "node", "--input-type=module", "-e", agentSdkRunner],
        {
          cwd: AGENT_WORKSPACE,
          stdin,
          env: {
            HOME: "/home/node",
            ANTHROPIC_AUTH_TOKEN: PROXY_AUTH_TOKEN,
            ANTHROPIC_BASE_URL: SERVICE_MODEL_URL,
            ANTHROPIC_MODEL: model,
            CLAUDE_CONFIG_DIR,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
          }
        }
      );
      const timer = setTimeout(() => process.kill(), RUN_TIMEOUT_MS);
      try {
        this.agentStage = "wait_agent";
        output = await process.output();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      proxyStats = { calls: this.activeRun?.calls ?? 0,
        last_denial: this.activeRun?.lastDenial ?? null };
      this.activeRun = null;
    }
    let result;
    try { result = JSON.parse(decoder.decode(output.stdout).trim().split("\n").at(-1)); }
    catch { result = null; }
    if (output.exitCode !== 0 || result?.error || typeof result?.answer !== "string") {
      this.lastAgentDiagnostic = {
        exit_code: output.exitCode, sdk_error: result?.error ?? null,
        proxy: proxyStats,
        stderr: decoder.decode(output.stderr).trim().slice(-1200)
          .replaceAll(PROXY_AUTH_TOKEN, "[placeholder]")
      };
      throw new Error("sdk_upstream_error");
    }
    this.lastAgentDiagnostic = null;
    if (result.session_id !== nativeId) throw new Error("claude_session_mismatch");
    this.agentStage = "read_transcript";
    return { answer: result.answer.trim().slice(0, 12_000), toolsUsed: result.tools_used,
      transcript: await this.readTranscript(nativeId) };
  }

  async modelProbe() {
    return this.exclusive(async () => {
      await this.ensureClaude();
      this.activeRun = { provider: "probe", model: "GLM-5.3[1m]", calls: 0,
        expiresAt: Date.now() + RUN_TIMEOUT_MS };
      let output;
      let proxyStats;
      try {
        const process = await this.ctx.container.exec(
          ["claude", "-p", "Reply exactly GLM_REMOTE_OK", "--model", "GLM-5.3[1m]",
            "--output-format", "json", "--max-turns", "1", "--tools", "",
            "--disallowedTools", "mcp__*", "--restricted", "--no-session-persistence"],
          { cwd: "/tmp", env: { ANTHROPIC_AUTH_TOKEN: PROXY_AUTH_TOKEN,
            ANTHROPIC_BASE_URL: PROBE_MODEL_URL,
            ANTHROPIC_MODEL: "GLM-5.3[1m]",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }
        );
        const timer = setTimeout(() => process.kill(), 90_000);
        try {
          output = await process.output();
        } finally {
          clearTimeout(timer);
        }
      } finally {
        proxyStats = { calls: this.activeRun?.calls ?? 0,
          last_denial: this.activeRun?.lastDenial ?? null };
        this.activeRun = null;
      }
      let response;
      try { response = JSON.parse(decoder.decode(output.stdout)); } catch { response = null; }
      if (output.exitCode !== 0 || response?.is_error || typeof response?.result !== "string") {
        const detail = decoder.decode(output.stderr).trim().slice(-1200) ||
          decoder.decode(output.stdout).trim().slice(-1200);
        return { ok: false, category: "cli_or_provider", exitCode: output.exitCode,
          proxy: proxyStats,
          detail: detail.replaceAll(PROXY_AUTH_TOKEN, "[placeholder]") };
      }
      return { ok: true, model: "GLM-5.3[1m]", result: response.result.trim() };
    });
  }

  async sdkProbe() {
    return this.exclusive(async () => {
      // Keep the experiment away from any previous client's filesystem.
      if (this.ctx.container.running) await this.destroy();
      await this.start();
      await this.installSkill();
      await this.ensureSdk();
      this.activeRun = { provider: "service", model: "glm-5.3", calls: 0,
        expiresAt: Date.now() + RUN_TIMEOUT_MS };
      let output;
      let proxy;
      try {
        const process = await this.ctx.container.exec(
          ["node", "-e", runAsNodeScript, "node", "--input-type=module", "-e", sdkProbeRunner],
          { cwd: AGENT_WORKSPACE, env: {
            HOME: "/home/node", ANTHROPIC_AUTH_TOKEN: PROXY_AUTH_TOKEN,
            ANTHROPIC_BASE_URL: SERVICE_MODEL_URL, ANTHROPIC_MODEL: "glm-5.3",
            CLAUDE_CONFIG_DIR: "/tmp/rfq-sdk-config",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
          } });
        const timer = setTimeout(() => process.kill(), RUN_TIMEOUT_MS);
        try { output = await process.output(); } finally { clearTimeout(timer); }
      } finally {
        proxy = { calls: this.activeRun?.calls ?? 0,
          last_denial: this.activeRun?.lastDenial ?? null };
        this.activeRun = null;
      }
      let result;
      try { result = JSON.parse(decoder.decode(output.stdout).trim().split("\n").at(-1)); }
      catch { result = null; }
      return {
        ok: output.exitCode === 0 && result?.skill_loaded === true &&
          result?.tools_used?.includes("Bash") &&
          result?.answer?.includes("SDK_PROBE_OK"),
        sdk: sdkPackageName, exit_code: output.exitCode,
        skill_loaded: result?.skill_loaded ?? false,
        tools_used: result?.tools_used ?? [],
        answer: result?.answer?.slice(0, 1000) ?? null,
        error: result?.error ?? decoder.decode(output.stderr).trim().slice(-1000)
          .replaceAll(PROXY_AUTH_TOKEN, "[placeholder]"),
        proxy
      };
    });
  }

  async createClient(name, dailyAgentLimit, dailyOcrLimit) {
    const id = crypto.randomUUID();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const token = `rfq_${btoa(String.fromCharCode(...raw)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
    const hash = await tokenHash(token);
    const record = { id, name, dailyAgentLimit, dailyOcrLimit, revoked: false,
      createdAt: new Date().toISOString(), usage: null };
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put(`client:${hash}`, record);
      await storage.put(`client-id:${id}`, hash);
    });
    return { client_id: id, name, token, daily_agent_limit: dailyAgentLimit,
      daily_ocr_limit: dailyOcrLimit };
  }

  async revokeClient(id) {
    return this.ctx.storage.transaction(async (storage) => {
      const hash = await storage.get(`client-id:${id}`);
      if (!hash) return false;
      const record = await storage.get(`client:${hash}`);
      if (!record) return false;
      record.revoked = true;
      await storage.put(`client:${hash}`, record);
      return true;
    });
  }

  async listClients(cursor) {
    const options = { prefix: "client-id:", limit: 101 };
    if (cursor) options.startAfter = `client-id:${cursor}`;
    const entries = [...await this.ctx.storage.list(options)];
    const page = entries.slice(0, 100);
    const clients = [];
    for (const [, hash] of page) {
      const record = await this.ctx.storage.get(`client:${hash}`);
      if (record) clients.push(publicClient(record));
    }
    return { clients, next_cursor: entries.length > 100 ? page.at(-1)[0].slice(10) : null };
  }

  async updateClient(id, name, agent, ocr) {
    return this.ctx.storage.transaction(async storage => {
      const hash = await storage.get(`client-id:${id}`);
      const record = hash && await storage.get(`client:${hash}`);
      if (!record) return { error: "client_not_found", status: 404 };
      if (record.revoked) return { error: "client_revoked", status: 409 };
      record.name = name;
      record.dailyAgentLimit = agent;
      record.dailyOcrLimit = ocr;
      await storage.put(`client:${hash}`, record);
      return { client: publicClient(record) };
    });
  }

  async authenticate(token) {
    if (typeof token !== "string" || !/^rfq_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const record = await this.ctx.storage.get(`client:${await tokenHash(token)}`);
    return record && !record.revoked ? { client_id: record.id } : null;
  }

  async charge(clientId, agentCount, ocrCount) {
    return this.ctx.storage.transaction(async (storage) => {
      const hash = await storage.get(`client-id:${clientId}`);
      const record = hash && await storage.get(`client:${hash}`);
      if (!record || record.revoked) return { ok: false, status: 401, code: "unauthorized" };
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const minute = now.toISOString().slice(0, 16);
      const global = await storage.get("global-usage");
      const globalUsage = global?.day === day ? { ...global } : { day, agent: 0, ocr: 0 };
      const usage = record.usage?.day === day ? { ...record.usage }
        : { day, agent: 0, ocr: 0, minute, agentMinute: 0, ocrMinute: 0 };
      if (usage.minute !== minute) {
        usage.minute = minute;
        usage.agentMinute = 0;
        usage.ocrMinute = 0;
      }
      if (globalUsage.agent + agentCount > 100 || globalUsage.ocr + ocrCount > 500 ||
          usage.agent + agentCount > record.dailyAgentLimit ||
          usage.ocr + ocrCount > record.dailyOcrLimit ||
          usage.agentMinute + agentCount > 3 || usage.ocrMinute + ocrCount > 10) {
        return { ok: false, status: 429, code: "client_rate_limit" };
      }
      usage.agent += agentCount;
      usage.ocr += ocrCount;
      usage.agentMinute += agentCount;
      usage.ocrMinute += ocrCount;
      globalUsage.agent += agentCount;
      globalUsage.ocr += ocrCount;
      record.usage = usage;
      await storage.put(`client:${hash}`, record);
      await storage.put("global-usage", globalUsage);
      return { ok: true, remaining: { agent_today: record.dailyAgentLimit - usage.agent,
        ocr_today: record.dailyOcrLimit - usage.ocr } };
    });
  }

  async loadSessionTranscript(record) {
    const chunks = [];
    let size = 0;
    for (let index = 0; index < record.chunks; index += 1) {
      const part = await this.ctx.storage.get(`transcript:${record.nativeId}:${index}`);
      if (!(part instanceof Uint8Array)) throw new Error("transcript_chunk_missing");
      chunks.push(part);
      size += part.byteLength;
      if (size > MAX_SESSION_BYTES) throw new ApiError(413, "session_too_large");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async saveSessionTranscript(key, previous, nativeId, model, skill, transcript) {
    if (transcript.byteLength > MAX_SESSION_BYTES) throw new ApiError(413, "session_too_large");
    const chunks = Math.ceil(transcript.byteLength / SESSION_CHUNK_BYTES);
    await this.ctx.storage.transaction(async (storage) => {
      for (let index = 0; index < chunks; index += 1) {
        await storage.put(`transcript:${nativeId}:${index}`,
          transcript.slice(index * SESSION_CHUNK_BYTES, (index + 1) * SESSION_CHUNK_BYTES));
      }
      if (previous?.nativeId) {
        const firstStale = previous.nativeId === nativeId ? chunks : 0;
        for (let index = firstStale; index < previous.chunks; index += 1) {
          await storage.delete(`transcript:${previous.nativeId}:${index}`);
        }
      }
      await storage.put(key, { nativeId, model, skill, chunks, updatedAt: Date.now() });
    });
  }

  async runAgent(clientId, sessionId, query, images, skill) {
    if (this.pendingRuns >= 5) return { ok: false, status: 429, code: "agent_busy" };
    this.pendingRuns += 1;
    const previous = this.runTail;
    let release;
    this.runTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      // A failed prior shutdown must never expose another client's workspace.
      if (this.ctx.container.running) await this.destroy();
      const key = `session:${clientId}:${sessionId}`;
      const prior = await this.ctx.storage.get(key);
      const resumable = prior?.nativeId && prior.skill === skill &&
        Date.now() - prior.updatedAt < SESSION_LIFETIME_MS;
      const nativeId = resumable ? prior.nativeId : crypto.randomUUID();
      const transcript = resumable ? await this.loadSessionTranscript(prior) : null;
      const model = selectAgentModel(resumable ? prior.model : null, images);
      this.lastAgentDiagnostic = null;
      const result = await this.runAgentSdk(query, images, model, nativeId, transcript, skill);
      await this.saveSessionTranscript(key, prior, nativeId, model, skill, result.transcript);
      await this.ctx.storage.delete("agent-diagnostic");
      return { ok: true, session_id: sessionId, answer: result.answer, model,
        skill, tools_used: result.toolsUsed,
        image_handling: images.length ? "claude-code-direct" : "none",
        image_count: images.length };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, status: error.status, code: error.code };
      if (!this.lastAgentDiagnostic) this.lastAgentDiagnostic = {
        stage: this.agentStage ?? "container_execution", name: error?.name ?? "unknown",
        message: String(error?.message ?? "unknown").slice(0, 800)
          .replaceAll(PROXY_AUTH_TOKEN, "[placeholder]")
      };
      await this.ctx.storage.put("agent-diagnostic", this.lastAgentDiagnostic);
      const code = /^(?:claude|sdk|transcript)_[a-z_]+$/.test(error?.message || "")
        ? error.message : "agent_upstream_error";
      console.error("Agent execution failed", code);
      return { ok: false, status: 502, code };
    } finally {
      try {
        if (this.ctx.container.running) await this.destroy();
      } catch (error) {
        console.error("Container shutdown failed", error?.name ?? "unknown");
      }
      this.pendingRuns -= 1;
      release();
    }
  }
}

// Assign through the base class setter. A static class field would shadow the
// accessor and leave ContainerProxy's handler registry empty.
ClaudeCodeProbe.outboundByHost = {
  "rfq-service.internal": async (request, env, ctx) => forwardModelRequest(request, env, ctx, "service"),
  "rfq-probe.internal": async (request, env, ctx) => forwardModelRequest(request, env, ctx, "probe")
};

function requireAdmin(request, env) {
  if (!env.PROBE_TOKEN) throw new ApiError(503, "admin_unconfigured");
  if (request.headers.get("Authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
    throw new ApiError(401, "unauthorized");
  }
}

function clientToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer (rfq_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) throw new ApiError(401, "unauthorized");
  return match[1];
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/") {
      return json({ service: "rfq-claude-code-probe", status: "worker-ready" });
    }
    const service = getContainer(env.CLAUDE_CODE_PROBE, "service");
    try {
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        const email = await requireAccessAdmin(request, env);
        const assets = { "/admin": [adminHtml, "text/html"], "/admin/": [adminHtml, "text/html"],
          "/admin/style.css": [adminCss, "text/css"], "/admin/app.js": [adminJs, "text/javascript"] };
        if (request.method === "GET" && assets[pathname]) {
          const [body, type] = assets[pathname];
          return new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8`,
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
        }
        if (pathname === "/admin/api/clients") {
          if (request.method === "GET") {
            const cursor = new URL(request.url).searchParams.get("cursor");
            if (cursor && !/^[a-f0-9-]{36}$/.test(cursor)) throw new ApiError(400, "invalid_cursor");
            return json({ ...await service.listClients(cursor), email, day: new Date().toISOString().slice(0, 10) });
          }
          if (request.method === "POST") {
            const { name, agent, ocr } = clientConfig(await readJson(request, 2048));
            return json(await service.createClient(name, agent, ocr), 201);
          }
        }
        const match = /^\/admin\/api\/clients\/([a-f0-9-]{36})$/.exec(pathname);
        if (match && request.method === "PATCH") {
          const { name, agent, ocr } = clientConfig(await readJson(request, 2048));
          const result = await service.updateClient(match[1], name, agent, ocr);
          return json(result, result.status || 200);
        }
        if (match && request.method === "DELETE") {
          const revoked = await service.revokeClient(match[1]);
          return json({ revoked }, revoked ? 200 : 404);
        }
        return json({ error: "not_found" }, 404);
      }
      if (request.method === "GET" && pathname === "/version") {
        requireAdmin(request, env);
        return json({ ok: true, version: await service.cliVersion() });
      }
      if (request.method === "GET" && pathname === "/v1/admin/agent-diagnostic") {
        requireAdmin(request, env);
        return json({ diagnostic: await service.agentDiagnostic() });
      }
      if (request.method === "POST" && pathname === "/test-model") {
        requireAdmin(request, env);
        if (!env.GLM_API_KEY) throw new ApiError(503, "probe_unconfigured");
        const result = await service.modelProbe();
        return json(result, result.ok ? 200 : 502);
      }
      if (request.method === "POST" && pathname === "/test-agent-sdk") {
        requireAdmin(request, env);
        if (!env.SERVICE_GLM_API_KEY) throw new ApiError(503, "service_unconfigured");
        const result = await service.sdkProbe();
        return json(result, result.ok ? 200 : 502);
      }
      if (request.method === "POST" && pathname === "/v1/admin/clients") {
        requireAdmin(request, env);
        const body = await readJson(request, 2_048);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const dailyAgent = body.daily_agent_limit ?? 20;
        const dailyOcr = body.daily_ocr_limit ?? 100;
        if (!name || name.length > 64 || !Number.isInteger(dailyAgent) || dailyAgent < 1 || dailyAgent > 500 ||
            !Number.isInteger(dailyOcr) || dailyOcr < 1 || dailyOcr > 2000) {
          throw new ApiError(400, "invalid_client_config");
        }
        return json(await service.createClient(name, dailyAgent, dailyOcr), 201);
      }
      const revoke = /^\/v1\/admin\/clients\/([a-f0-9-]{36})$/.exec(pathname);
      if (request.method === "DELETE" && revoke) {
        requireAdmin(request, env);
        const revoked = await service.revokeClient(revoke[1]);
        return json({ revoked }, revoked ? 200 : 404);
      }
      const isAgent = request.method === "POST" && pathname === "/v1/agent";
      const isOcr = request.method === "POST" && pathname === "/v1/ocr";
      if (!isAgent && !isOcr) return new Response("Not found", { status: 404 });
      if (!env.SERVICE_GLM_API_KEY) throw new ApiError(503, "service_unconfigured");
      const identity = await service.authenticate(clientToken(request));
      if (!identity) throw new ApiError(401, "unauthorized");
      const body = await readJson(request);
      const input = isAgent ? validateAgent(body) : validateOcr(body);
      const charge = await service.charge(identity.client_id, isAgent ? 1 : 0,
        isAgent ? 0 : 1);
      if (!charge.ok) throw new ApiError(charge.status, charge.code);
      if (isOcr) {
        const result = await callGlmOcr(input.image, env.SERVICE_GLM_API_KEY);
        return json({ ...result, model: "glm-ocr", quota_remaining: charge.remaining });
      }
      const result = await service.runAgent(identity.client_id, input.sessionId, input.query,
        input.images, input.skill);
      if (!result.ok) throw new ApiError(result.status, result.code);
      return json({ ...result, quota_remaining: charge.remaining });
    } catch (error) {
      if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status);
      console.error("Service request failed", error?.name ?? "unknown");
      return json({ ok: false, error: "internal_error" }, 500);
    }
  }
};
