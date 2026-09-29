import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const origin = "https://glm.knowflow.work";
const adminTokenFile = fileURLToPath(new URL("../../tmp/claude-probe-token", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../../tmp/remote-client-token", import.meta.url));
const name = process.argv[2];
const outputFile = process.argv[3] ? resolve(process.argv[3]) : defaultOutput;

if (!name || name.length > 64 || process.argv.length > 4) {
  console.error("Usage: npm run client:create -- <client-name> [token-output-file]");
  process.exit(2);
}

let handle;
try {
  await mkdir(dirname(outputFile), { recursive: true });
  handle = await open(outputFile, "wx", 0o600);
  const adminToken = (await readFile(adminTokenFile, "utf8")).trim();
  if (!adminToken) throw new Error("Admin probe token is empty.");
  const response = await fetch(`${origin}/v1/admin/clients`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status !== 201) throw new Error(`Client provisioning failed (HTTP ${response.status}).`);
  const client = await response.json();
  if (!/^rfq_[A-Za-z0-9_-]{43}$/.test(client.token || "")) {
    throw new Error("Server returned an invalid client token.");
  }
  await handle.writeFile(`${client.token}\n`);
  console.log(`Client ${client.client_id} created. Token saved to ${outputFile} (mode 0600).`);
} catch (error) {
  if (handle) {
    await handle.close();
    await unlink(outputFile).catch(() => {});
    handle = null;
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (handle) await handle.close();
}
