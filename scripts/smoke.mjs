import assert from "node:assert/strict";
import { startServer } from "../src/server.mjs";

const started = await startServer({ port: 0, host: "127.0.0.1" });
const address = started.server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const clientId = "smoke-client";

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return response.json();
}

async function simulatedClientOnce(expectedType, result) {
  const response = await fetch(`${baseUrl}/client/${clientId}/command?timeoutMs=5000`);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.command.type, expectedType);

  await post(`/client/${clientId}/result`, {
    commandId: payload.command.id,
    result
  });
}

try {
  const hello = await post("/client/hello", {
    clientId,
    metadata: {
      url: "https://example.test/",
      title: "Smoke",
      visibility: "visible"
    }
  });
  assert.equal(hello.ok, true);

  const clients = await get("/api/clients");
  assert.equal(clients.activeClientId, clientId);

  const clientPromise = simulatedClientOnce("observe", {
    url: "https://example.test/",
    title: "Smoke",
    elements: [
      {
        id: "e1",
        role: "button",
        kind: "buttons",
        label: "Submit",
        selector: "button",
        visible: true
      }
    ]
  });
  const observed = await post("/api/active/observe", { include: ["buttons"] });
  await clientPromise;

  assert.equal(observed.ok, true);
  assert.equal(observed.result.title, "Smoke");
  assert.equal(observed.result.elements[0].id, "e1");

  const runPromise = simulatedClientOnce("run", {
    ok: true,
    steps: [{ ok: true, index: 0, type: "observe", result: { title: "Smoke" } }]
  });
  const ran = await post("/api/active/run", { steps: [{ type: "observe" }] });
  await runPromise;
  assert.equal(ran.ok, true);
  assert.equal(ran.result.ok, true);
  assert.equal(ran.result.steps[0].type, "observe");

  const searchPromise = simulatedClientOnce("search", {
    query: "bridge",
    result: {
      title: "Smoke Results",
      links: []
    }
  });
  const searched = await post("/api/active/search", { query: "bridge" });
  await searchPromise;
  assert.equal(searched.ok, true);
  assert.equal(searched.result.query, "bridge");

  console.log("Smoke test passed.");
} finally {
  await started.close();
}
