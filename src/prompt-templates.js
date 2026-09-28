import fs from "node:fs";
import path from "node:path";
import { resourceDir } from "./paths.js";

const names = new Set(["classification.system", "draft.system", "rationale.system", "vision-probe", "input",
  "image-read", "image-ocr", "image-none", "vision-read", "vision-ocr"]);

/** Prompt files are packaged resources. Only the declared placeholders may be
 * substituted; missing values fail loudly instead of shipping {{...}} to a model. */
export function renderPrompt(name, values = {}) {
  if (!names.has(name)) throw new Error(`Unknown prompt template: ${name}`);
  const template = fs.readFileSync(path.join(resourceDir, "src/prompts", `${name}.md`), "utf8").trim();
  const used = new Set();
  const rendered = template.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing prompt placeholder: ${key}`);
    used.add(key);
    return String(values[key]);
  });
  for (const key of Object.keys(values)) if (!used.has(key)) throw new Error(`Unused prompt placeholder: ${key}`);
  return rendered;
}

export function buildModelPrompt(name, values, payload) {
  const systemPrompt = renderPrompt(name, values);
  return { systemPrompt, prompt: `${systemPrompt}\n\n${renderPrompt("input", { inputJson: JSON.stringify(payload) })}` };
}
