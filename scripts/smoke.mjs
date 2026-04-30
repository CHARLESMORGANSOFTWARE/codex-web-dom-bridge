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

async function simulatedClientOnce() {
  const response = await fetch(`${baseUrl}/client/${clientId}/command?timeoutMs=5000`);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.command.type, "observe");

  await post(`/client/${clientId}/result`, {
    commandId: payload.command.id,
    result: {
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
    }
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

  const clientPromise = simulatedClientOnce();
  const observed = await post("/api/active/observe", { include: ["buttons"] });
  await clientPromise;

  assert.equal(observed.ok, true);
  assert.equal(observed.result.title, "Smoke");
  assert.equal(observed.result.elements[0].id, "e1");

  console.log("Smoke test passed.");
} finally {
  await started.close();
}
