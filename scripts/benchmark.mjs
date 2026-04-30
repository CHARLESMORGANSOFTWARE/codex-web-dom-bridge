#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const defaults = {
  url: process.env.CODEX_DOM_BRIDGE_URL || "http://127.0.0.1:8797",
  clientId: "active",
  iterations: 9,
  quietMs: 50,
  resultsSelector: "#results"
};

function usage() {
  console.log(`Usage:
  node scripts/benchmark.mjs [--url http://127.0.0.1:8797] [--client active] [--iterations 9] [--quiet-ms 50] [--json]

Benchmarks bridge control against the active demo page:
  bridge.search  One command: find search box, submit, wait, extract.
  bridge.run     One command: scripted act/wait/extract steps in page.
  bridge.split   Four API round trips: type, click, wait, extract.
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

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const options = {
  url: takeFlag(args, "--url", defaults.url),
  clientId: takeFlag(args, "--client", defaults.clientId),
  iterations: Number(takeFlag(args, "--iterations", defaults.iterations)),
  quietMs: Number(takeFlag(args, "--quiet-ms", defaults.quietMs)),
  json: takeBooleanFlag(args, "--json"),
  resultsSelector: takeFlag(args, "--results", defaults.resultsSelector)
};

const cases = [
  {
    query: "structured",
    expected: "Labels become navigation fuel"
  },
  {
    query: "speed",
    expected: "Actions hit the DOM directly"
  },
  {
    query: "handles",
    expected: "Bridge observe gives Codex handles"
  }
];

function caseAt(index) {
  return cases[index % cases.length];
}

async function request(path, options = {}) {
  const response = await fetch(`${options.baseUrl || globalThis.baseUrl}${path}`, {
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

async function command(type, payload) {
  return request(`/api/${encodeURIComponent(options.clientId)}/${type}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

function assertResultText(payload, expected) {
  const text =
    payload?.result?.result?.text ||
    payload?.result?.text ||
    payload?.result?.result?.result?.text ||
    "";
  assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return text;
}

async function resetVisibleResult() {
  await command("search", {
    query: "speed",
    resultsSelector: options.resultsSelector,
    quietMs: options.quietMs,
    timeoutMs: 5_000,
    limit: 5
  });
}

async function bridgeSearch(testCase) {
  const response = await command("search", {
    query: testCase.query,
    resultsSelector: options.resultsSelector,
    quietMs: options.quietMs,
    timeoutMs: 5_000,
    limit: 5
  });
  assertResultText(response, testCase.expected);
  return response;
}

async function bridgeRun(testCase) {
  const response = await command("run", {
    steps: [
      {
        act: {
          selector: "#query",
          action: "type",
          value: testCase.query
        }
      },
      {
        act: {
          selector: "#submit-search",
          action: "click"
        }
      },
      {
        wait: {
          for: "text",
          value: testCase.expected,
          timeoutMs: 5_000
        }
      },
      {
        extract: {
          selector: options.resultsSelector,
          text: true,
          items: {
            selector: "article",
            fields: {
              title: "h2",
              text: ""
            }
          }
        }
      }
    ]
  });
  assertResultText(response, testCase.expected);
  return response;
}

async function bridgeSplit(testCase) {
  await command("act", {
    selector: "#query",
    action: "type",
    value: testCase.query
  });
  await command("act", {
    selector: "#submit-search",
    action: "click"
  });
  await command("wait", {
    for: "text",
    value: testCase.expected,
    timeoutMs: 5_000
  });
  const response = await command("extract", {
    selector: options.resultsSelector,
    text: true,
    items: {
      selector: "article",
      fields: {
        title: "h2",
        text: ""
      }
    }
  });
  assertResultText(response, testCase.expected);
  return response;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    iterations: sorted.length,
    minMs: Math.round(sorted[0]),
    medianMs: Math.round(percentile(0.5)),
    meanMs: Math.round(sum / sorted.length),
    p95Ms: Math.round(percentile(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1])
  };
}

async function benchmark(name, fn) {
  await resetVisibleResult();

  const samples = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const testCase = caseAt(index);
    const startedAt = performance.now();
    await fn(testCase);
    samples.push(performance.now() - startedAt);
  }

  return {
    name,
    ...summarize(samples),
    samplesMs: samples.map((sample) => Math.round(sample))
  };
}

globalThis.baseUrl = options.url;

const clients = await request("/api/clients");
if (!clients.activeClientId && options.clientId === "active") {
  throw new Error("No active bridge client. Open the demo page or load the extension first.");
}

const results = [
  await benchmark("bridge.search", bridgeSearch),
  await benchmark("bridge.run", bridgeRun),
  await benchmark("bridge.split", bridgeSplit)
];

const payload = {
  url: options.url,
  clientId: options.clientId,
  activeClientId: clients.activeClientId,
  iterations: options.iterations,
  quietMs: options.quietMs,
  results
};

if (options.json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Bridge benchmark against ${options.url} (${options.iterations} iterations)`);
  console.table(
    results.map(({ name, minMs, medianMs, meanMs, p95Ms, maxMs }) => ({
      name,
      minMs,
      medianMs,
      meanMs,
      p95Ms,
      maxMs
    }))
  );
}
