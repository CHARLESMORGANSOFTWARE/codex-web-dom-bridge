#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { startServer } from "../src/server.mjs";

const bridgeUrl = process.env.CODEX_DOM_BRIDGE_URL || "http://127.0.0.1:8797";
const autoStart = process.env.CODEX_DOM_BRIDGE_AUTOSTART !== "0";
let startedBridge = null;

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function bridgeRequest(path, options = {}) {
  await ensureBridge();
  const response = await fetch(`${bridgeUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `bridge_http_${response.status}`);
  }
  return payload;
}

async function health() {
  const response = await fetch(`${bridgeUrl}/healthz`);
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
}

async function ensureBridge() {
  try {
    await health();
    return;
  } catch (error) {
    if (!autoStart || startedBridge) throw error;
  }

  const url = new URL(bridgeUrl);
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!isLocal) throw new Error(`bridge_not_available:${bridgeUrl}`);

  try {
    startedBridge = await startServer({
      host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
      port: Number(url.port || 8797)
    });
    console.error(`codex-web-mcp started bridge at ${startedBridge.url}`);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
  }
}

function activeClientSchema() {
  return z.string().default("active").describe("Browser client id, or active for the visible/recent page.");
}

async function command(clientId, type, payload) {
  return bridgeRequest(`/api/${encodeURIComponent(clientId || "active")}/${type}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

const looseJson = z.any().describe("JSON payload forwarded to the DOM bridge.");

const server = new McpServer({
  name: "codex-web",
  version: "0.1.0"
});

server.registerTool(
  "web_status",
  {
    title: "Codex Web Status",
    description: "Check the local DOM bridge and list connected browser pages.",
    inputSchema: {}
  },
  async () => {
    const [healthPayload, clientsPayload] = await Promise.all([
      bridgeRequest("/healthz"),
      bridgeRequest("/api/clients")
    ]);
    return textResult({
      bridgeUrl,
      health: healthPayload,
      ...clientsPayload
    });
  }
);

server.registerTool(
  "web_observe",
  {
    title: "Observe Web Page",
    description: "Return a compact DOM map of links, buttons, inputs, headings, and forms.",
    inputSchema: {
      clientId: activeClientSchema(),
      include: z.array(z.enum(["links", "buttons", "inputs", "headings", "forms"])).optional(),
      query: z.string().optional(),
      visibleOnly: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "observe", payload))
);

server.registerTool(
  "web_act",
  {
    title: "Act On Web Element",
    description: "Click, type, select, check, focus, or press a key against a DOM element handle or selector.",
    inputSchema: {
      clientId: activeClientSchema(),
      id: z.string().optional(),
      selector: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      action: z.enum(["click", "type", "setValue", "select", "check", "uncheck", "focus", "press"]),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      key: z.string().optional(),
      append: z.boolean().optional()
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "act", payload))
);

server.registerTool(
  "web_wait",
  {
    title: "Wait For Web Page",
    description: "Wait for readiness, text, a selector, or quiet DOM/network state.",
    inputSchema: {
      clientId: activeClientSchema(),
      for: z.enum(["ready", "selector", "text", "networkIdle", "quiet", "domIdle"]).default("ready"),
      value: z.string().optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
      quietMs: z.number().int().positive().max(10_000).optional()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "wait", payload))
);

server.registerTool(
  "web_extract",
  {
    title: "Extract Web Content",
    description: "Extract visible text, HTML, links, fields, or repeated records from the page.",
    inputSchema: {
      clientId: activeClientSchema(),
      selector: z.string().optional(),
      text: z.boolean().optional(),
      html: z.boolean().optional(),
      links: z.boolean().optional(),
      fields: looseJson.optional(),
      items: looseJson.optional(),
      limit: z.number().int().positive().max(500).optional(),
      maxText: z.number().int().positive().max(100_000).optional()
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "extract", payload))
);

server.registerTool(
  "web_search",
  {
    title: "Search Current Web Page",
    description: "Find the page's search box, submit a query, wait for results, and extract them in one browser hop.",
    inputSchema: {
      clientId: activeClientSchema(),
      query: z.string().min(1),
      selector: z.string().optional(),
      submitSelector: z.string().optional(),
      resultsSelector: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
      quietMs: z.number().int().positive().max(10_000).optional(),
      text: z.boolean().optional(),
      links: z.boolean().optional(),
      waitFor: z.enum(["ready", "selector", "text", "networkIdle", "quiet", "domIdle"]).optional(),
      waitValue: z.string().optional(),
      items: looseJson.optional()
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "search", payload))
);

server.registerTool(
  "web_run",
  {
    title: "Run Web Workflow",
    description: "Execute multiple DOM bridge steps in the browser as one fast workflow.",
    inputSchema: {
      clientId: activeClientSchema(),
      steps: z.array(looseJson).min(1),
      continueOnError: z.boolean().optional()
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false
    }
  },
  async ({ clientId, ...payload }) => textResult(await command(clientId, "run", payload))
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  if (startedBridge) await startedBridge.close();
  process.exit(0);
});
