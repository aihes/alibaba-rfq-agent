import { Container, getContainer } from "@cloudflare/containers";
import {
  ANTHROPIC_URL, ApiError, buildClaudeInput, callGlmOcr, readJson,
  selectAgentModel, validateAgent, validateOcr
} from "./service.js";

const packageName = "@anthropic-ai/claude-code@2.1.284";
const decoder = new TextDecoder();
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const CLAUDE_CONFIG_DIR = "/tmp/rfq-claude-config";
const transcriptPath = (nativeId) => `${CLAUDE_CONFIG_DIR}/projects/-tmp/${nativeId}.jsonl`;
const writeTranscriptScript = "const fs=require('fs'),p=require('path'),f=process.argv[1],parts=[];process.stdin.on('data',x=>parts.push(x));process.stdin.on('end',()=>{fs.mkdirSync(p.dirname(f),{recursive:true,mode:0o700});fs.writeFileSync(f,Buffer.concat(parts),{mode:0o600})})";

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

  async readTranscript(nativeId) {
    const process = await this.ctx.container.exec(["cat", transcriptPath(nativeId)]);
    const output = await process.output();
    if (output.exitCode !== 0 || !output.stdout.byteLength) {
      throw new Error("transcript_read_failed");
    }
    return new Uint8Array(output.stdout);
  }

  async runClaude(query, images, apiKey, model, nativeId, previousTranscript) {
    await this.ensureClaude();
    if (previousTranscript) await this.restoreTranscript(nativeId, previousTranscript);
    const input = new TextEncoder().encode(buildClaudeInput(query, images));
    const stdin = new ReadableStream({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      }
    });
    const process = await this.ctx.container.exec(
      ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", previousTranscript ? "--resume" : "--session-id", nativeId,
        "--model", model],
      {
        cwd: "/tmp",
        stdin,
        env: {
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: ANTHROPIC_URL,
          ANTHROPIC_MODEL: model,
          CLAUDE_CONFIG_DIR,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
        }
      }
    );
    const timer = setTimeout(() => process.kill(), 180_000);
    let output;
    try {
      output = await process.output();
    } finally {
      clearTimeout(timer);
    }
    const result = decoder.decode(output.stdout).trim().split("\n").reduce((last, line) => {
      try {
        const event = JSON.parse(line);
        return event.type === "result" ? event : last;
      } catch {
        return last;
      }
    }, null);
    if (output.exitCode !== 0 || !result || result.is_error || typeof result.result !== "string") {
      throw new Error("claude_upstream_error");
    }
    if (result.session_id !== nativeId) throw new Error("claude_session_mismatch");
    return { answer: result.result.trim().slice(0, 12_000),
      transcript: await this.readTranscript(nativeId) };
  }

  async modelProbe(authToken, baseUrl) {
    return this.exclusive(async () => {
      await this.ensureClaude();
      const process = await this.ctx.container.exec(
        ["claude", "-p", "Reply exactly GLM_REMOTE_OK", "--model", "GLM-5.3[1m]",
          "--output-format", "json", "--max-turns", "1", "--tools", "",
          "--disallowedTools", "mcp__*", "--restricted", "--no-session-persistence"],
        { cwd: "/tmp", env: { ANTHROPIC_AUTH_TOKEN: authToken,
          ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: "GLM-5.3[1m]",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }
      );
      const output = await process.output();
      let response;
      try { response = JSON.parse(decoder.decode(output.stdout)); } catch { response = null; }
      if (output.exitCode !== 0 || response?.is_error || typeof response?.result !== "string") {
        return { ok: false, category: "cli_or_provider", exitCode: output.exitCode };
      }
      return { ok: true, model: "GLM-5.3[1m]", result: response.result.trim() };
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

  async saveSessionTranscript(key, previous, nativeId, model, transcript) {
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
      await storage.put(key, { nativeId, model, chunks, updatedAt: Date.now() });
    });
  }

  async runAgent(clientId, sessionId, query, images, apiKey) {
    if (this.pendingRuns >= 5) return { ok: false, status: 429, code: "agent_busy" };
    this.pendingRuns += 1;
    const previous = this.runTail;
    let release;
    this.runTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const key = `session:${clientId}:${sessionId}`;
      const prior = await this.ctx.storage.get(key);
      const resumable = prior?.nativeId && Date.now() - prior.updatedAt < SESSION_LIFETIME_MS;
      const nativeId = resumable ? prior.nativeId : crypto.randomUUID();
      const transcript = resumable ? await this.loadSessionTranscript(prior) : null;
      const model = selectAgentModel(resumable ? prior.model : null, images);
      const result = await this.runClaude(query, images, apiKey, model, nativeId, transcript);
      await this.saveSessionTranscript(key, prior, nativeId, model, result.transcript);
      return { ok: true, session_id: sessionId, answer: result.answer, model,
        image_handling: images.length ? "claude-code-direct" : "none",
        image_count: images.length };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, status: error.status, code: error.code };
      const code = /^(?:claude|transcript)_[a-z_]+$/.test(error?.message || "")
        ? error.message : "agent_upstream_error";
      console.error("Agent execution failed", code);
      return { ok: false, status: 502, code };
    } finally {
      try {
        if (this.pendingRuns === 1 && this.ctx.container.running) await this.destroy();
      } catch (error) {
        console.error("Container shutdown failed", error?.name ?? "unknown");
      }
      this.pendingRuns -= 1;
      release();
    }
  }
}

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
      if (request.method === "GET" && pathname === "/version") {
        requireAdmin(request, env);
        return json({ ok: true, version: await service.cliVersion() });
      }
      if (request.method === "POST" && pathname === "/test-model") {
        requireAdmin(request, env);
        if (!env.GLM_API_KEY) throw new ApiError(503, "probe_unconfigured");
        const result = await service.modelProbe(
          env.GLM_API_KEY, "https://open.bigmodel.cn/api/anthropic");
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
        input.images, env.SERVICE_GLM_API_KEY);
      if (!result.ok) throw new ApiError(result.status, result.code);
      return json({ ...result, quota_remaining: charge.remaining });
    } catch (error) {
      if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status);
      console.error("Service request failed", error?.name ?? "unknown");
      return json({ ok: false, error: "internal_error" }, 500);
    }
  }
};
