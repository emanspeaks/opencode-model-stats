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

Add the plugin to your `opencode.json` as a single entry:

```json
{
  "plugin": [
    "opencode-model-stats"
  ]
}
```

The default entry point loads both the TUI component (live stats display) and the server component (correlation header injection) together. OpenCode picks up whichever is relevant for each process.

### Plugin options

Pass options as a second element in the tuple:

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

#### `prefillProgressUrl`

Base URL of the proxy (origin only, e.g. `"http://127.0.0.1:8080"`). The plugin always appends `/prefill-progress` to form the full endpoint URL. By default, the plugin derives this automatically from the active session's model API URL, so this only needs to be set if that automatic resolution produces the wrong address.

#### `prefillPollMs`

Polling interval in milliseconds for prefill progress. Minimum enforced: `100`.

Default: `250`

### Individual entry points

The individual components are also available separately if needed:

| Entry point | Loads |
| --- | --- |
| `opencode-model-stats` | Both TUI and server (recommended) |
| `opencode-model-stats/tui` | TUI stats display only |
| `opencode-model-stats/server` | Correlation header injection only |

## Prefill Progress Via Proxy

This plugin supports a proxy-assisted prefill progress mode for local llama.cpp-style backends.

During prompt prefill, the plugin polls a proxy endpoint for progress keyed by session and message IDs. When progress is available, the slot displays:

- `Prefill X/Y (Z%)`
- `Prefill X/Y (Z%) · ~Ns left` (or `~Nm left`) when ETA is computable

When generation starts, it automatically switches back to:

- `TPS X | AVG Y | TTFT Z`

If the proxy endpoint is unavailable or returns no record, the plugin falls back to a simple elapsed prefill display.

## Proxy Contract

The plugin expects the proxy to expose:

- Endpoint: `GET /prefill-progress`
- Query params:
  - `session_id`
  - `message_id`

Response JSON (snake_case):

- `found: boolean`
- `total: number`
- `cache: number`
- `processed: number`
- `time_ms: number`
- `done: boolean` (optional, supported)
- `updated_at: number` (optional)

The plugin currently uses `found`, `total`, `cache`, `processed`, and `time_ms`.

## Reference Proxy Implementation

Reference target implementation:

- https://github.com/emanspeaks/llama-swap-proxy
