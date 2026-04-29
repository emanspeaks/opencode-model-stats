# opencode-model-stats

Displays live TPS (tokens per second), average TPS, and average TTFT (time to first token) in the OpenCode session prompt.
When prompt processing, it can also show prefill progress from a compatible proxy endpoint.

A fork of [oc-tps](https://github.com/Tarquinen/oc-tps)

## Installation

Install from the CLI:

```bash
opencode plugin opencode-model-stats@latest --global
```

Requires `opencode` `1.4` or newer.

## Configuration

OpenCode uses two separate config files for two separate processes:

- **`opencode.json`** — server/runtime process, reads the `server` export
- **`tui.json`** — terminal UI process, reads the `tui` export

Add the plugin to **both** files to get the full feature set:

```json
// opencode.json
{
  "plugin": [
    "opencode-model-stats"
  ]
}
```

```json
// tui.json
{
  "plugin": [
    "opencode-model-stats"
  ]
}
```

The default entry point exports both components. Each process picks up only what it needs.

### Plugin options

Options are passed as a second element in the tuple and apply to whichever component that config file loads:

```json
{
  "plugin": [
    ["opencode-model-stats", { "debug": true, "prefillPollMs": 500 }]
  ]
}
```

#### `debug`

Set `debug: true` to enable verbose logging of the `chat.headers` path on every LLM request. Logged lines include:

- Confirmation that the plugin initialized with debug enabled
- The full `LlmRequestContext` (`sessionID`, `messageID`, `providerID`, `modelID`) on each call
- How many `onRequest` callbacks are registered
- Each callback's return value as it is merged
- The final `output.headers` map actually sent to the provider

Remove or set `"debug": false` once you have confirmed the headers are flowing correctly.

#### `prefillProgressUrl`

Base URL of the proxy (origin only, e.g. `"http://127.0.0.1:8080"`). The plugin always appends `/prefill-progress` to form the full endpoint URL. By default, the plugin derives this automatically from the active session's model API URL, so this only needs to be set if that automatic resolution produces the wrong address.

#### `prefillPollMs`

Polling interval in milliseconds for prefill progress. Minimum enforced: `100`.

Default: `250`

### Individual entry points

The TUI and server components are also available as separate entry points if you only need one:

| Entry point | Component |
| --- | --- |
| `opencode-model-stats` | Both (recommended — add to both config files) |
| `opencode-model-stats/tui` | TUI stats display only (`tui.json`) |
| `opencode-model-stats/server` | Correlation header injection only (`opencode.json`) |

## Prefill Progress Via Proxy

This plugin supports a proxy-assisted prefill progress mode for local llama.cpp-style backends.

During prompt prefill, the plugin polls a proxy endpoint for progress keyed by session and message IDs. When progress is available, the slot displays:

- `Prefill X/Y (Z%)`
- `Prefill X/Y (Z%) · ~Ns left` (or `~Nm left`) when ETA is computable

When generation starts, it automatically switches back to:

- `TPS X | AVG Y | TTFT Z`

If the proxy endpoint is unavailable or returns no record (`found` is false or `done` is true), the display reverts to TPS stats.

## Proxy Contract

The plugin expects the proxy to expose:

- Endpoint: `GET /prefill-progress`
- Query params:
  - `session_id`
  - `message_id`

Response JSON (snake_case):

- `found: boolean`
- `started: boolean` — `false` while queued but not yet picked up by the decoder; `true` once decoding begins
- `total: number`
- `cache: number`
- `processed: number`
- `time_ms: number`
- `done: boolean` (optional)
- `updated_at: number` (optional)

The plugin shows prefill only when `found=true`, `started=true`, and `done` is absent or false. Responses with `started=false` are treated as queued and the display reverts to TPS stats. Proxies that omit `started` are treated as always started (backward compatible).

## Reference Proxy Implementation

Reference target implementation:

- https://github.com/emanspeaks/llama-swap-proxy
