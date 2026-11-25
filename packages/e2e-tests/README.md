# @cortexkit/anthropic-auth-e2e

End-to-end tests for the OpenCode integration. The harness starts:

- a local Anthropic-compatible mock server,
- optionally a local protocol-v2 WebSocket or HTTP relay,
- optionally a quota-header feed for cross-process quota observations,
- a real `opencode serve` subprocess with isolated config/data/cache dirs,
- the local `@cortexkit/opencode-anthropic-auth` plugin loaded from source.

Run from the repo root:

```bash
bun run test:e2e
```

These tests require the `opencode` CLI on `PATH`.

## Refusal replies and rounds on real hosts

The joined-reply tests install and verify OpenCode 1.19.6, OpenCode 2.3.2 and
Pi 1.6.0. Run them on Linux x64 or arm64 with Bun 1.3.14, Node 24, npm registry
access, Python 3 and a kernel with Landlock TCP restrictions (ABI 4 or newer):

```bash
bun install --frozen-lockfile
bun run --cwd packages/core build
bun run --cwd packages/opencode build
bun run --cwd packages/pi build
cd packages/e2e-tests
bun test tests/mock-refusal.test.ts tests/refusal-joined-reply.test.ts tests/refusal-rounds-and-modes.test.ts
```

Each case starts with disposable host state and synthetic credentials. The host
processes can connect only on the mock server's port and, for OpenCode 2, the
local daemon's port. The authority cases that use the HTTP relay also allow its
loopback port. Round tests keep Pi open in RPC mode between prompts; joined
reply tests that check restart still start a fresh Pi process. The cases named
`callback-boundary` drive a second request through the real host's registered
provider callback because its CLI waits for the current prompt to finish.

The keep-alive cases exercise a real 36-second host idle deadline, so allow
several minutes for the matrix.
