# @cortexkit/anthropic-auth-e2e

End-to-end tests for the OpenCode integration. The harness starts:

- a local Anthropic-compatible mock server,
- optionally a local protocol-v2 WebSocket relay,
- a real `opencode serve` subprocess with isolated config/data/cache dirs,
- the local `@marcusrbrown/opencode-anthropic-auth` plugin loaded from source.

Run from the repo root:

```bash
bun run test:e2e
```

These tests require the `opencode` CLI on `PATH`.
