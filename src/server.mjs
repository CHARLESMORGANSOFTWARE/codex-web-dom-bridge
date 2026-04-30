import http from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultPort = Number(process.env.CODEX_DOM_BRIDGE_PORT || 8797);
const clientTimeoutMs = 35_000;
const commandTimeoutMs = 30_000;
const maxBodyBytes = 1_000_000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

const clients = new Map();
const pendingResults = new Map();

function now() {
  return Date.now();
}

function json(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function noContent(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end();
}

function text(res, status, value) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(value);
}

function notFound(res) {
  json(res, 404, { ok: false, error: "not_found" });
}

function badRequest(res, message) {
  json(res, 400, { ok: false, error: message });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function ensureClient(id, metadata = {}) {
  const existing = clients.get(id);
  if (existing) {
    existing.lastSeen = now();
    existing.metadata = { ...existing.metadata, ...metadata };
    return existing;
  }

  const client = {
    id,
    createdAt: now(),
    lastSeen: now(),
    metadata,
    queue: [],
    poll: null
  };
  clients.set(id, client);
  return client;
}

function publicClient(client) {
  return {
    id: client.id,
    ageMs: now() - client.createdAt,
    lastSeenMsAgo: now() - client.lastSeen,
    queueLength: client.queue.length,
    metadata: client.metadata
  };
}

function getActiveClient() {
  const connected = [...clients.values()]
    .filter((client) => now() - client.lastSeen < clientTimeoutMs)
    .sort((a, b) => {
      const aActive = a.metadata?.visibility === "visible" ? 1 : 0;
      const bActive = b.metadata?.visibility === "visible" ? 1 : 0;
      return bActive - aActive || b.lastSeen - a.lastSeen;
    });
  return connected[0] || null;
}

function resolveClient(id) {
  if (id === "active") {
    return getActiveClient();
  }
  return clients.get(id) || null;
}

function sweepClients() {
  const cutoff = now() - clientTimeoutMs * 3;
  for (const [id, client] of clients) {
    if (client.lastSeen < cutoff && !client.poll && client.queue.length === 0) {
      clients.delete(id);
    }
  }
}

function finishPoll(client, command = null) {
  if (!client.poll) return false;
  const { res, timer } = client.poll;
  clearTimeout(timer);
  client.poll = null;
  json(res, 200, command ? { ok: true, command } : { ok: true, command: null });
  return true;
}

function enqueueCommand(client, type, payload = {}) {
  const id = `cmd_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const command = { id, type, payload, createdAt: now() };

  const resultPromise = new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      pendingResults.delete(id);
      rejectResult(new Error("command_timeout"));
    }, payload.timeoutMs || commandTimeoutMs);
    pendingResults.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolveResult(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectResult(error);
      }
    });
  });

  if (client.poll) {
    finishPoll(client, command);
  } else {
    client.queue.push(command);
  }

  return { command, resultPromise };
}

async function sendCommand(res, clientId, type, payload) {
  const client = resolveClient(clientId);
  if (!client) {
    json(res, 404, { ok: false, error: "client_not_connected" });
    return;
  }

  try {
    const { command, resultPromise } = enqueueCommand(client, type, payload);
    const result = await resultPromise;
    json(res, 200, {
      ok: true,
      clientId: client.id,
      commandId: command.id,
      result
    });
  } catch (error) {
    json(res, 504, {
      ok: false,
      clientId: client.id,
      error: error.message
    });
  }
}

async function handleClient(req, res, url) {
  if (req.method === "POST" && url.pathname === "/client/hello") {
    const body = await readBody(req);
    if (!body.clientId) {
      badRequest(res, "clientId_required");
      return;
    }
    const client = ensureClient(body.clientId, body.metadata || {});
    json(res, 200, { ok: true, client: publicClient(client) });
    return;
  }

  const pollMatch = url.pathname.match(/^\/client\/([^/]+)\/command$/);
  if (req.method === "GET" && pollMatch) {
    const client = ensureClient(decodeURIComponent(pollMatch[1]));
    client.lastSeen = now();

    if (client.queue.length) {
      json(res, 200, { ok: true, command: client.queue.shift() });
      return;
    }

    if (client.poll) {
      finishPoll(client);
    }

    const timeoutMs = Math.min(Number(url.searchParams.get("timeoutMs") || 25_000), 30_000);
    const timer = setTimeout(() => finishPoll(client), timeoutMs);
    client.poll = { res, timer };
    req.on("close", () => {
      if (client.poll?.res === res) {
        clearTimeout(timer);
        client.poll = null;
      }
    });
    return;
  }

  const resultMatch = url.pathname.match(/^\/client\/([^/]+)\/result$/);
  if (req.method === "POST" && resultMatch) {
    const clientId = decodeURIComponent(resultMatch[1]);
    const client = ensureClient(clientId);
    const body = await readBody(req);
    client.lastSeen = now();
    client.metadata = { ...client.metadata, ...(body.metadata || {}) };

    const pending = pendingResults.get(body.commandId);
    if (!pending) {
      json(res, 202, { ok: true, accepted: false, reason: "no_pending_command" });
      return;
    }

    pendingResults.delete(body.commandId);
    pending.resolve(body.result);
    json(res, 200, { ok: true, accepted: true });
    return;
  }

  notFound(res);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/clients") {
    sweepClients();
    json(res, 200, {
      ok: true,
      clients: [...clients.values()].map(publicClient),
      activeClientId: getActiveClient()?.id || null
    });
    return;
  }

  const commandMatch = url.pathname.match(/^\/api\/([^/]+)\/(observe|act|wait|extract)$/);
  if (req.method === "POST" && commandMatch) {
    const [, rawClientId, type] = commandMatch;
    const body = await readBody(req);
    await sendCommand(res, decodeURIComponent(rawClientId), type, body);
    return;
  }

  notFound(res);
}

function safeStaticPath(urlPath) {
  if (urlPath === "/" || urlPath === "") return join(rootDir, "demo", "index.html");
  if (urlPath === "/codex-bridge.js") return join(rootDir, "extension", "content.js");
  const decoded = decodeURIComponent(urlPath);
  const relative = decoded.replace(/^\/+/, "");
  const filePath = resolve(rootDir, relative);
  if (!filePath.startsWith(rootDir)) return null;
  return filePath;
}

async function serveStatic(req, res, url) {
  let filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    notFound(res);
    return;
  }

  if (filePath.endsWith("/") || !extname(filePath)) {
    const indexPath = join(filePath, "index.html");
    if (existsSync(indexPath)) filePath = indexPath;
  }

  if (!existsSync(filePath)) {
    notFound(res);
    return;
  }

  const type = mimeTypes[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    try {
      if (req.method === "OPTIONS") {
        noContent(res);
        return;
      }

      if (url.pathname === "/healthz") {
        json(res, 200, { ok: true, clients: clients.size });
        return;
      }

      if (url.pathname.startsWith("/client/")) {
        await handleClient(req, res, url);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }

      if (req.method === "GET") {
        await serveStatic(req, res, url);
        return;
      }

      notFound(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, message === "invalid_json" ? 400 : 500, { ok: false, error: message });
    }
  });
}

function parseArgs(argv) {
  const args = {
    port: defaultPort,
    host: "127.0.0.1",
    openDemo: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      args.port = Number(argv[++i]);
    } else if (arg === "--host") {
      args.host = argv[++i];
    } else if (arg === "--open-demo") {
      args.openDemo = true;
    }
  }

  return args;
}

export async function startServer(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? defaultPort);
  const server = createServer();

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  return {
    server,
    url: `http://${host}:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const started = await startServer(args);
  console.log(`Codex DOM Bridge listening on ${started.url}`);
  console.log(`Demo: ${started.url}/demo/`);
  console.log(`Extension: load unpacked from ${join(rootDir, "extension")}`);

  if (args.openDemo) {
    spawn("open", [`${started.url}/demo/`], {
      stdio: "ignore",
      detached: true
    }).unref();
  }
}
