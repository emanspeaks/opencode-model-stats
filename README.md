# oc-tps

Displays live TPS, average TPS, and TTFT in the OpenCode session prompt. TTFT, or time to first token, measures how long it takes the model to begin responding.

Requires `opencode` `1.3.14` or newer.

## Demo

![Demo](./assets/demo.gif)

## Installation

Install from the CLI:

```bash
opencode plugin oc-tps@latest --global
```

This installs the package and adds it to your global OpenCode config.
