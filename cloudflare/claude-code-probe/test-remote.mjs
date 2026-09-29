import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const origin = "https://glm.knowflow.work";
const tokenFile = fileURLToPath(new URL("../../tmp/claude-probe-token", import.meta.url));
const healthOnly = process.argv[2] === "--health-only";

if (process.argv.length > 3 || (process.argv[2] && !healthOnly)) {
  console.error("Usage: npm run test:remote [-- --health-only]");
  process.exit(2);
}

async function jsonResponse(path, options = {}, timeoutMs = 15_000) {
  const response = await fetch(new URL(path, origin), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    if (!response.ok) return { status: response.status, body: null };
    throw new Error(`${path}: expected a JSON response (HTTP ${response.status})`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path}: expected a JSON response (HTTP ${response.status})`);
  }
  return { status: response.status, body };
}

try {
  const health = await jsonResponse("/");
  if (health.status !== 200 || health.body.status !== "worker-ready") {
    throw new Error(`Worker health check failed (HTTP ${health.status})`);
  }
  console.log(`${origin}/ → HTTP 200, worker-ready`);

  if (!healthOnly) {
    const denied = await fetch(new URL("/test-model", origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
    if (denied.status !== 401) {
      throw new Error(`Authorization check failed (HTTP ${denied.status})`);
    }
    console.log("POST /test-model without token → HTTP 401");

    let token = process.env.PROBE_TOKEN?.trim();
    if (!token) {
      try {
        token = (await readFile(tokenFile, "utf8")).trim();
      } catch {
        throw new Error("Probe token not found. Set PROBE_TOKEN or use the local tmp/claude-probe-token file.");
      }
    }
    if (!token) throw new Error("Probe token is empty.");

    const model = await jsonResponse(
      "/test-model",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      180_000
    );
    if (model.status !== 200 || model.body?.ok !== true || model.body.result !== "GLM_REMOTE_OK") {
      throw new Error(`Model probe failed (HTTP ${model.status}, category: ${model.body?.category ?? "unknown"})`);
    }
    console.log(`POST /test-model with token → HTTP 200, ${model.body.model}: ${model.body.result}`);
  }
} catch (error) {
  console.error(`Remote probe failed: ${error.message}`);
  process.exitCode = 1;
}
