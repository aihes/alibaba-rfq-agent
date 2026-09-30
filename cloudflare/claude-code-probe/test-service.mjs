import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const origin = "https://glm.knowflow.work";
const tokenFile = fileURLToPath(new URL("../../tmp/remote-client-token", import.meta.url));
const imagePath = process.argv[2];
if (process.argv.length > 3) {
  console.error("Usage: npm run test:service [-- path-to-png-or-jpeg]");
  process.exit(2);
}

async function post(path, token, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed (HTTP ${response.status}, ${data.error || "unknown"}).`);
  return data;
}

try {
  const token = (process.env.RFQ_SERVICE_TOKEN || await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error("Client token is empty.");
  const first = await post("/v1/agent", token, { query: "请只回复 REMOTE_AGENT_OK" });
  console.log(`Agent: session=${first.session_id}, model=${first.model}, answer=${first.answer}`);
  if (first.answer.trim() !== "REMOTE_AGENT_OK" || !first.session_id) {
    throw new Error("Agent fixed-prompt result or session ID was unexpected.");
  }
  const second = await post("/v1/agent", token, {
    session_id: first.session_id,
    query: "上轮我要求你回复的短语是什么？请只回复该短语。"
  });
  console.log(`Session follow-up: session=${second.session_id}, answer=${second.answer}`);
  if (second.session_id !== first.session_id || second.answer.trim() !== "REMOTE_AGENT_OK") {
    throw new Error("Agent did not preserve the expected session context.");
  }

  const skill = await post("/v1/agent", token, {
    query: "先用 Bash 执行 printf RFQ_TOOL_OK，再按报价 Skill 说明历史 PI 是否能证明今天的售价。回答中包含 RFQ_TOOL_OK。"
  });
  console.log(`RFQ Skill: skill=${skill.skill}, tools=${skill.tools_used?.join(",")}`);
  if (skill.skill !== "rfq-quote-advisor" || !skill.tools_used?.includes("Bash") ||
      !skill.answer?.includes("RFQ_TOOL_OK")) {
    throw new Error("Agent SDK did not run the RFQ Skill and Bash tool.");
  }

  if (imagePath) {
    const bytes = await readFile(imagePath);
    const mime = bytes[0] === 137 && bytes[1] === 80 ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : null;
    if (!mime) throw new Error("Image must be PNG or JPEG.");
    const image = { mime_type: mime, data: bytes.toString("base64") };
    const ocr = await post("/v1/ocr", token, { image });
    console.log(`OCR: status=${ocr.status}, model=${ocr.model}, text=${ocr.text.slice(0, 200)}`);
    if (ocr.status !== "read" || !ocr.text) throw new Error("OCR did not recognize text.");
    const agent = await post("/v1/agent", token, {
      session_id: first.session_id,
      query: "请根据图片中的文字概括关键信息。",
      images: [image]
    });
    console.log(`Agent with image: mode=${agent.image_handling}, answer=${agent.answer.slice(0, 300)}`);
    if (agent.image_handling !== "claude-code-direct" || agent.model !== "glm-5.3-flash" ||
        agent.image_count !== 1 || !agent.answer) {
      throw new Error("Agent SDK did not receive the image directly.");
    }
  }
} catch (error) {
  console.error(`Remote service test failed: ${error.message}`);
  process.exitCode = 1;
}
