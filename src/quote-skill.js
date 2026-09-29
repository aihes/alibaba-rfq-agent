import fs from "node:fs";
import path from "node:path";
import { resourceDir } from "./paths.js";

const skillPath = path.join(resourceDir, "src/skills/rfq-quote-advisor/SKILL.md");

/** Explicitly include the packaged skill in every model request. The Claude SDK
 * runs with its Skill tool disabled so buyer text cannot invoke arbitrary local
 * skills; this reviewed file is the only quote guidance it receives. */
export function withQuoteSkill(request) {
  if (!request.prompt.startsWith(request.systemPrompt)) throw new Error("Model prompt must start with its system instructions");
  const skill = fs.readFileSync(skillPath, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
  const systemPrompt = `${request.systemPrompt}\n\nLOCAL_QUOTE_SKILL:\n${skill}`;
  return { ...request, systemPrompt, prompt: `${systemPrompt}\n\n${request.prompt.slice(request.systemPrompt.length).trimStart()}` };
}
