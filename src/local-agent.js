import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { projectDir } from "./config.js";
import { extractJson } from "./utils.js";

const DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"
];

function modelNames(modelUsage = {}) {
  return Object.keys(modelUsage).filter(Boolean);
}

export async function runLocalAgentJson(config, {
  prompt,
  schema,
  imagePaths = [],
  maxTurns = 1
}) {
  if (!config.localClaudeExecutable) {
    throw new Error("Local Claude executable was not found. Set LOCAL_CLAUDE_EXECUTABLE.");
  }
  const absoluteImages = imagePaths.map((filePath) => path.resolve(filePath));
  for (const filePath of absoluteImages) {
    if (!fs.existsSync(filePath)) throw new Error(`Local RFQ image does not exist: ${filePath}`);
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.localClaudeTimeoutMs);
  const readEnabled = absoluteImages.length > 0;
  let finalResult;
  try {
    const stream = query({
      prompt,
      options: {
        abortController,
        cwd: projectDir,
        additionalDirectories: [...new Set(absoluteImages.map((filePath) => path.dirname(filePath)))],
        allowedTools: readEnabled ? ["Read"] : [],
        tools: readEnabled ? ["Read"] : [],
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: "dontAsk",
        permissionPrompts: "none",
        strictMcpConfig: true,
        mcpServers: {},
        plugins: [],
        skills: [],
        settingSources: config.localClaudeSettingSources,
        persistSession: false,
        maxTurns,
        maxBudgetUsd: config.localClaudeMaxBudgetUsd,
        model: config.localClaudeModel || undefined,
        pathToClaudeCodeExecutable: config.localClaudeExecutable,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: "alibaba-rfq-agent/0.5.0"
        },
        outputFormat: config.localClaudeStructuredOutput
          ? { type: "json_schema", schema }
          : undefined
      }
    });
    for await (const message of stream) {
      if (message.type === "result") finalResult = message;
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!finalResult) throw new Error("Local Claude Agent SDK returned no result");
  if (finalResult.subtype !== "success" || finalResult.is_error) {
    throw new Error(`Local Claude Agent SDK failed: ${finalResult.subtype}: ${finalResult.result || "unknown error"}`);
  }
  const data = finalResult.structured_output ?? extractJson(finalResult.result);
  return {
    data,
    meta: {
      provider: "local-claude-sdk",
      requestedModel: config.localClaudeModel || "inherit-local-default",
      modelsUsed: modelNames(finalResult.modelUsage),
      imageCount: absoluteImages.length,
      turns: finalResult.num_turns,
      durationMs: finalResult.duration_ms
    }
  };
}
