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

## Loading The Extension

1. Start the server with `npm start`.
2. Open Chrome or a Chromium browser.
3. Go to `chrome://extensions`.
4. Enable Developer Mode.
5. Choose "Load unpacked" and select the `extension/` directory.

The extension content script connects to `http://127.0.0.1:8797` by default.

## API

All command endpoints accept `active` in place of a client id.

```http
GET  /api/clients
POST /api/:clientId/observe
POST /api/:clientId/act
POST /api/:clientId/wait
POST /api/:clientId/extract
```

Example:

```bash
curl -s http://127.0.0.1:8797/api/active/observe \
  -H 'content-type: application/json' \
  -d '{"include":["inputs","buttons"]}'
```

## Why This Shape

The bridge keeps Codex out of the pixel business whenever the page gives us better structure. A browser client assigns stable temporary handles like `e12`, returns concise element descriptors, and resolves later actions against the real DOM node.

Fallback order:

1. Element id from `observe`.
2. CSS selector.
3. Accessibility role and name.
4. Browser surface clicking, only when the DOM path is blocked.
