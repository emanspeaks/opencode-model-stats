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

## Plugin Environment Variables

- `LLAMA_PREFILL_PROGRESS_URL`
  - Default: `http://127.0.0.1:8080/prefill-progress`
- `LLAMA_PREFILL_POLL_MS`
  - Default: `1000`
  - Minimum enforced by plugin: `250`

## Reference Proxy Implementation

Reference target implementation:

- https://github.com/emanspeaks/llama-swap-proxy
