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
    ["opencode-model-stats", { "debug": true }]
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

#### `tuiDebug`

Set `tuiDebug: true` to write verbose TUI diagnostic logs to `opencode-model-stats-tui.log` in the current working directory, or provide a string path to write elsewhere:

```json
["opencode-model-stats", { "tuiDebug": true }]
["opencode-model-stats", { "tuiDebug": "/tmp/oms-tui.log" }]
```

The log file path is printed to the console on startup. The file is appended (not overwritten) so each session adds to the same file. Each session starts with a `=== started ... ===` separator line.

#### `prefillWsUrl`

WebSocket URL of the proxy's prefill push stream (see [Proxy Contract](#proxy-contract) below).

By default, the URL is derived automatically from the model's API URL: the scheme is converted to `ws`/`wss` and `/prefill-ws` is appended to the origin. Set this option to override that derivation with a fixed URL.

#### `prefillPollMs`

Interval in milliseconds for the TUI clock and prune cycle. Controls how often the live TPS display refreshes and stale state is cleaned up. Minimum enforced: `100`.

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

During prompt prefill, the plugin receives push updates over a persistent WebSocket connection. When progress is available, the slot displays:

- `Prefill X/Y (Z%)`
- `Prefill X/Y (Z%) | R t/s | ~Ns left` when ETA is computable

When generation starts, the proxy signals completion and the display automatically switches back to:

- `TPS X | AVG Y | TTFT Z`

If the WebSocket is unavailable the display simply shows TPS stats. The plugin reconnects automatically after a 2-second delay.

The WebSocket connection stays open across turns and is only closed when the model URL changes (the old connection is released once no in-flight responses remain on it) or when the program exits.

## Proxy Contract

The plugin opens one persistent WebSocket connection per unique proxy URL and listens for server-push messages. No polling — the proxy broadcasts updates as they occur.

### WebSocket endpoint

- `GET /prefill-ws` (or `/v1/prefill-ws`) — upgraded to WebSocket
- The client sends nothing; the server pushes JSON messages
- Multiple clients may connect simultaneously; each receives the same broadcasts
- Progress entries are evicted automatically after inactivity (TTL ~180s)

### Push message format

Progress update (snake_case JSON):

```json
{
  "session_id": "...",
  "total": 1024,
  "cache": 200,
  "processed": 600,
  "time_ms": 450,
  "started": true,
  "done": false
}
```

Completion signal (sent when generation begins or the request ends):

```json
{ "session_id": "...", "done": true }
```

Field reference:

- `session_id: string` — matches the `x-opencode-session-id` header injected by the server plugin
- `total: number` — total tokens to prefill
- `cache: number` — tokens served from KV cache (already done)
- `processed: number` — tokens prefilled so far (including cache)
- `time_ms: number` — elapsed prefill time in milliseconds
- `started: boolean` — `false` while the request is queued; `true` once the decoder picks it up. Omit to default to `true` (backward compatible)
- `done: boolean` — `true` when this request's prefill phase is over

The plugin displays progress only when `started=true` and `done` is absent or false. Messages with `started=false` are silently ignored (display stays on TPS stats).

## Reference Proxy Implementation

Reference target implementation:

- https://github.com/emanspeaks/llama-swap-proxy
