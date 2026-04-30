# Webtool

A brilliantly small bridge for controlling the web through the page's HTML layer instead of screen coordinates.

```text
Codex CLI/tool calls
  -> local bridge server
  -> browser content script
  -> live DOM
```

The public contract is intentionally tiny:

- `observe` returns a compact, accessibility-flavored map of links, buttons, inputs, headings, and forms.
- `act` clicks, types, checks, selects, focuses, or presses against a DOM handle.
- `wait` waits for text, selectors, readiness, or quiet DOM.
- `extract` pulls text, HTML, links, fields, or repeated records out of the page.
- `run` executes a tiny multi-step DOM workflow in one browser hop.
- `search` finds the page's search input, submits a query, waits for quiet DOM, and extracts results.

## Quick Start

Start the bridge:

```bash
npm start
```

Open the demo page:

```bash
open http://127.0.0.1:8797/demo/
```

The demo injects the bridge runtime automatically. For arbitrary sites, load the unpacked extension in `extension/`.

List connected pages:

```bash
node bin/codex-web.mjs clients
```

Observe the active page:

```bash
node bin/codex-web.mjs observe
```

Type into an element and click a button:

```bash
node bin/codex-web.mjs act active e1 type "lightning fast web control"
node bin/codex-web.mjs act active e2 click
```

Extract visible page text:

```bash
node bin/codex-web.mjs extract active --text
```

Run a full DOM workflow in one command:

```bash
node bin/codex-web.mjs run '[
  {"act":{"selector":"#query","action":"type","value":"speed"}},
  {"act":{"selector":"#submit-search","action":"click"}},
  {"wait":{"for":"quiet","quietMs":250}},
  {"extract":{"selector":"#results","text":true}}
]'
```

Search the current page using its own search box:

```bash
node bin/codex-web.mjs search "structured" --results '#results'
```

## Loading The Extension

1. Start the server with `npm start`.
2. Open Chrome or a Chromium browser.
3. Go to `chrome://extensions`.
4. Enable Developer Mode.
5. Choose "Load unpacked" and select the `extension/` directory.

The extension content script connects to `http://127.0.0.1:8797` by default.

## Connecting Codex

Codex should call this through MCP, not by prompt convention alone. The MCP wrapper exposes the bridge as tools named `web_status`, `web_observe`, `web_act`, `web_wait`, `web_extract`, `web_search`, and `web_run`.

First install dependencies:

```bash
npm install
```

Then add the MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-web]
command = "node"
args = ["/Volumes/EXT/Applications/Webtool/bin/codex-web-mcp.mjs"]

[mcp_servers.codex-web.env]
CODEX_DOM_BRIDGE_URL = "http://127.0.0.1:8797"
```

For the current demo server on port `8798`, use:

```toml
[mcp_servers.codex-web]
command = "node"
args = ["/Volumes/EXT/Applications/Webtool/bin/codex-web-mcp.mjs"]

[mcp_servers.codex-web.env]
CODEX_DOM_BRIDGE_URL = "http://127.0.0.1:8798"
```

Restart Codex after editing the config. In a new Codex turn, ask it to use `web_status`; it should report the bridge URL and connected browser clients. From there:

```text
Use web_search with query "structured" and resultsSelector "#results".
```

The browser page still needs the content script: use the demo page, or load the unpacked extension in `extension/` for arbitrary sites.

## Benchmark

With the demo open, run:

```bash
CODEX_DOM_BRIDGE_URL=http://127.0.0.1:8798 npm run benchmark -- --url http://127.0.0.1:8798 --iterations 9
```

The benchmark reports:

- `bridge.search`: one tool call for search, wait, and extraction.
- `bridge.run`: one tool call for a scripted DOM workflow.
- `bridge.split`: the older multi-call pattern.

Current demo baseline numbers live in `benchmarks/demo-baseline.md`.

## API

All command endpoints accept `active` in place of a client id.

```http
GET  /api/clients
POST /api/:clientId/observe
POST /api/:clientId/act
POST /api/:clientId/wait
POST /api/:clientId/extract
POST /api/:clientId/run
POST /api/:clientId/search
```

Example:

```bash
curl -s http://127.0.0.1:8797/api/active/observe \
  -H 'content-type: application/json' \
  -d '{"include":["inputs","buttons"]}'
```

One-hop workflow:

```bash
curl -s http://127.0.0.1:8797/api/active/run \
  -H 'content-type: application/json' \
  -d '{"steps":[{"search":{"query":"codex dom","resultsSelector":"#results"}}]}'
```

## Why This Shape

The bridge keeps Codex out of the pixel business whenever the page gives us better structure. A browser client assigns stable temporary handles like `e12`, returns concise element descriptors, and resolves later actions against the real DOM node.

Fallback order:

1. Element id from `observe`.
2. CSS selector.
3. Accessibility role and name.
4. Browser surface clicking, only when the DOM path is blocked.

The fast path is `run`: compose the obvious DOM steps and let the content script do them locally. That removes the slow screenshot/coordinate loop and avoids paying a server round trip for every keystroke, click, wait, and extraction.
