#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";

const baseUrl = process.env.CODEX_DOM_BRIDGE_URL || "http://127.0.0.1:8797";

function usage() {
  console.log(`Usage:
  codex-web clients
  codex-web observe [clientId] [--include links,buttons,inputs,headings,forms] [--query text]
  codex-web act [clientId] <elementId> <action> [value]
  codex-web wait [clientId] <ready|selector|text|networkIdle|quiet> [value]
  codex-web extract [clientId] [--selector css] [--text] [--html] [--links]
  codex-web run [clientId] <steps-json|@file|->
  codex-web search <query> [--client active] [--selector css] [--submit css] [--results css]

Defaults:
  clientId defaults to "active".
  server defaults to ${baseUrl}; override with CODEX_DOM_BRIDGE_URL.
`);
}

function takeFlag(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value ?? fallback;
}

function takeBooleanFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseClientId(args) {
  if (args[0] && !args[0].startsWith("--")) return args.shift();
  return "active";
}

function looksLikePayload(value) {
  return value === "-" || value?.startsWith("@") || value?.startsWith("[") || value?.startsWith("{");
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function readJsonPayload(value) {
  if (!value) throw new Error("json_payload_required");
  if (value === "-") return JSON.parse(await readStdin());
  if (value.startsWith("@")) return JSON.parse(await readFile(value.slice(1), "utf8"));
  return JSON.parse(value);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = [...rest];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "clients") {
    print(await request("/api/clients"));
    return;
  }

  if (command === "observe") {
    const clientId = parseClientId(args);
    const include = takeFlag(args, "--include");
    const query = takeFlag(args, "--query");
    const payload = {};
    if (include) payload.include = include.split(",").map((item) => item.trim()).filter(Boolean);
    if (query) payload.query = query;
    print(await request(`/api/${encodeURIComponent(clientId)}/observe`, {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }

  if (command === "act") {
    const clientId = parseClientId(args);
    const [id, action, ...valueParts] = args;
    if (!id || !action) {
      usage();
      process.exitCode = 1;
      return;
    }
    const value = valueParts.length ? valueParts.join(" ") : undefined;
    print(await request(`/api/${encodeURIComponent(clientId)}/act`, {
      method: "POST",
      body: JSON.stringify({ id, action, value })
    }));
    return;
  }

  if (command === "wait") {
    const clientId = parseClientId(args);
    const [waitFor, ...valueParts] = args;
    if (!waitFor) {
      usage();
      process.exitCode = 1;
      return;
    }
    const value = valueParts.length ? valueParts.join(" ") : undefined;
    print(await request(`/api/${encodeURIComponent(clientId)}/wait`, {
      method: "POST",
      body: JSON.stringify({ for: waitFor, value })
    }));
    return;
  }

  if (command === "extract") {
    const clientId = parseClientId(args);
    const selector = takeFlag(args, "--selector");
    const text = takeBooleanFlag(args, "--text");
    const html = takeBooleanFlag(args, "--html");
    const links = takeBooleanFlag(args, "--links");
    const payload = { selector, text, html, links };
    print(await request(`/api/${encodeURIComponent(clientId)}/extract`, {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }

  if (command === "run") {
    const clientId = args[0] && !looksLikePayload(args[0]) ? args.shift() : "active";
    const rawPayload = await readJsonPayload(args.join(" ") || args[0]);
    const payload = Array.isArray(rawPayload) ? { steps: rawPayload } : rawPayload;
    print(await request(`/api/${encodeURIComponent(clientId)}/run`, {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }

  if (command === "search") {
    const clientId = takeFlag(args, "--client", "active");
    const selector = takeFlag(args, "--selector");
    const submitSelector = takeFlag(args, "--submit");
    const resultsSelector = takeFlag(args, "--results");
    const limit = takeFlag(args, "--limit");
    const timeoutMs = takeFlag(args, "--timeout-ms");
    const quietMs = takeFlag(args, "--quiet-ms");
    const noText = takeBooleanFlag(args, "--no-text");
    const noLinks = takeBooleanFlag(args, "--no-links");
    const query = args.join(" ").trim();

    if (!query) {
      usage();
      process.exitCode = 1;
      return;
    }

    const payload = { query };
    if (selector) payload.selector = selector;
    if (submitSelector) payload.submitSelector = submitSelector;
    if (resultsSelector) payload.resultsSelector = resultsSelector;
    if (limit) payload.limit = Number(limit);
    if (timeoutMs) payload.timeoutMs = Number(timeoutMs);
    if (quietMs) payload.quietMs = Number(quietMs);
    if (noText) payload.text = false;
    if (noLinks) payload.links = false;

    print(await request(`/api/${encodeURIComponent(clientId)}/search`, {
      method: "POST",
      body: JSON.stringify(payload)
    }));
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(inspect(error, { colors: true, depth: 4 }));
  process.exit(1);
});
