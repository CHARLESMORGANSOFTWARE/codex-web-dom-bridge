#!/usr/bin/env node
import { inspect } from "node:util";

const baseUrl = process.env.CODEX_DOM_BRIDGE_URL || "http://127.0.0.1:8797";

function usage() {
  console.log(`Usage:
  codex-web clients
  codex-web observe [clientId] [--include links,buttons,inputs,headings,forms] [--query text]
  codex-web act [clientId] <elementId> <action> [value]
  codex-web wait [clientId] <ready|selector|text|networkIdle|navigation> [value]
  codex-web extract [clientId] [--selector css] [--text] [--html] [--links]

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

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(inspect(error, { colors: true, depth: 4 }));
  process.exit(1);
});
