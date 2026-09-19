#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  analyzeRfq,
  browserStatus,
  fillQuote,
  scanRfqs,
  submitQuote
} from "./runtime.mjs";

const server = new McpServer({ name: "alibaba-rfq-midscene", version: "0.2.0" });
const rfqSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  summary: z.string().default(""),
  quantityText: z.string().default(""),
  quantity: z.number().nullable().optional(),
  countryText: z.string().default(""),
  country: z.string().default(""),
  remainingQuotesText: z.string().default(""),
  remainingQuotes: z.number().nullable().optional(),
  publishedText: z.string().default(""),
  buyerText: z.string().default(""),
  cardImageUrl: z.string().default(""),
  detailUrl: z.string().url(),
  quoteUrl: z.string().url(),
  searchTerm: z.string().default(""),
  collectedAt: z.string().optional()
});

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function guarded(handler) {
  return async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.stack || error.message }]
      };
    }
  };
}

server.registerTool("midscene_browser_status", {
  description: "Check the existing Alibaba Chrome session through Midscene Bridge without reading cookies or storage.",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, guarded(browserStatus));

server.registerTool("midscene_scan_rfqs", {
  description: "Search and extract Alibaba RFQ cards from the logged-in browser. This is read-only.",
  inputSchema: {
    searchTerm: z.string().min(1),
    maxCards: z.number().int().min(1).max(30).default(20)
  },
  annotations: { readOnlyHint: true }
}, guarded(scanRfqs));

server.registerTool("midscene_analyze_rfq", {
  description: "Open one scanned RFQ, extract its details and images, call the configured local Claude/GLM agent, apply deterministic pricing, and save a local draft. It does not fill or submit the form.",
  inputSchema: {
    rfq: rfqSchema,
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional().describe("Run ID returned by midscene_scan_rfqs; links the analysis to the persisted run report")
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, guarded(analyzeRfq));

server.registerTool("midscene_fill_quote", {
  description: "Fill a prepared Alibaba quote draft in the live browser and save a screenshot, but do not click submit. Requires user approval at action time.",
  inputSchema: {
    file: z.string().min(1).describe("JSON path inside data/drafts")
  },
  annotations: { readOnlyHint: false }
}, guarded(fillQuote));

server.registerTool("midscene_submit_quote", {
  description: "Submit a prepared quote only after the full policy gate and an exact per-RFQ confirmation token. This sends a real quotation and buyer message.",
  inputSchema: {
    file: z.string().min(1).describe("JSON path inside data/drafts"),
    confirmationToken: z.string().min(1),
    confirmLiveSubmission: z.literal(true)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, guarded(submitQuote));

await server.connect(new StdioServerTransport());
console.error("alibaba-rfq-midscene MCP server running on stdio");
