# Demo Benchmark Baseline

Target: `http://127.0.0.1:8798/demo/`

Task per iteration:

1. Search for one of `structured`, `speed`, or `handles`.
2. Submit the demo search form.
3. Wait for the expected result heading.
4. Extract the `#results` text.

Each run used 9 iterations.

| Surface | Median | Mean | Notes |
| --- | ---: | ---: | --- |
| `bridge.run` | 214 ms | 215 ms | One bridge command with explicit DOM steps. |
| `bridge.split` | 221 ms | 222 ms | Four bridge API calls: type, click, wait, extract. |
| `bridge.search` | 264 ms | 264 ms | One search recipe; includes result-change plus 50 ms quiet-DOM wait. |
| `browser.locator` | 1798 ms | 1796 ms | Normal in-app browser locator control: snapshot, fill, click, wait, extract. |

Speedup against `browser.locator` median:

| Surface | Median Speedup |
| --- | ---: |
| `bridge.run` | 8.4x |
| `bridge.split` | 8.1x |
| `bridge.search` | 6.8x |

Commands:

```bash
CODEX_DOM_BRIDGE_URL=http://127.0.0.1:8798 npm run benchmark -- --url http://127.0.0.1:8798 --iterations 9 --quiet-ms 50
```

The `browser.locator` number was measured in the in-app browser with the Browser Use runtime by looping over:

1. `domSnapshot()`
2. `locator("#query").fill(query)`
3. `locator("#submit-search").click()`
4. polling `locator("#results").innerText()` until the expected result appeared
