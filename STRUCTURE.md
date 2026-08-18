# Codebase Structure

## Directory Layout

```
anthropic-auth/
├── packages/
│   ├── core/                   # Shared core library
│   │   └── src/                # Reusable OAuth, quota, cache, relay, signing
│   ├── opencode/               # OpenCode plugin + CLI
│   │   ├── src/
│   │   │   ├── rpc/            # Loopback RPC server/client for TUI IPC
│   │   │   ├── tests/          # Comprehensive test suite per module
│   │   │   │   ├── fixtures/   # Test fixtures (realistic system prompts)
│   │   │   │   └── __snapshots__/
│   │   │   └── tui/            # Command modal dialog components
│   │   ├── scripts/            # Build and smoke-testing scripts for the TUI
│   │   └── dist/               # Built output (git-ignored)
│   ├── pi/                     # Pi provider extension
│   │   ├── src/
│   │   │   └── tests/
│   │   └── dist/
│   └── e2e-tests/              # End-to-end integration tests
│       ├── src/                # Test harness + mock servers
│       └── tests/              # Test files
├── scripts/                    # Dev, release, and analysis scripts
├── captures/                   # System-prompt capture artifacts (git-ignored)
├── docs/                       # Documentation (superpowers plans/specs/perf)
├── images/                     # Images for README
└── .github/                    # CI workflows + issue templates
```

## Directory Purposes

**`packages/core/src/`:**
- Purpose: All reusable OAuth, account management, quota, cache, relay, dump, signing, routing, and command execution logic
- Contains: TypeScript modules, each focused on one concern, plus core unit tests in `tests/`
- Key files: `index.ts` (re-exports all public API), `accounts.ts` (sidecar storage + types + quota API + prime opt-in and runtime counters), `auth.ts` (OAuth authorization + token exchange + refresh), `oauth-profile.ts` (OAuth profile fetch + rate limit tier formatting), `quota-headers.ts` (passive quota header extraction and normalization), `token-fingerprint.ts` (SHA-256 token fingerprinting), `relay.ts` (Cloudflare Worker relay protocol), `quota-manager.ts` (centralized quota cache), `cachekeep.ts` (hybrid cache pre-warming), `cachekeep-registry.ts` (cross-process tracked-session lease registry), `prime.ts` (opt-in five-hour quota priming and cross-process scheduler), `cch.ts` (body signing), `claude-code.ts` (Claude Code identity + billing headers), `provider.ts` (provider HTTP error classification), `logging.ts` (logging level commands), `commands/account.ts` (account command execution), `cache1h.ts` (1h prompt cache configuration), `fast.ts` (fast mode configuration), `dump.ts` (request/response dump capture and size-capped background sweeping), `models.ts` (Claude model specs and Haiku prime pricing), `logger.ts` (structured logger), `pkce.ts` (PKCE helpers), `routing.ts` (routing mode commands), `sticky-routing.ts` (persistent quota-balanced session affinity), `killswitch.ts` (hard-block and model-scoped thresholds), `quotas.ts` (quota calculation), `constants.ts` (global constants)

**`packages/opencode/src/`:**
- Purpose: OpenCode plugin implementation — fetch interception, request rewriting, CLI, TUI sidebar, command dialogs
- Contains: Plugin entry point, transform pipeline, CLI, TUI widget (SolidJS), precompiled TUI loader/output, RPC server for TUI IPC, preferences management
- Key files: `index.ts` (plugin factory — auth loader, command registration, background services), `transform.ts` (request body rewriting + SSE stream stripping), `server-fallback.ts` (Anthropic server-side safety fallback opt-in, fallback-boundary preservation, and outcome detection), `fable-fallback.ts` (legacy session-and-source-family Fable/Opus 5 content-filter downgrade and standby Opus cache-anchor state), `prime-manager-registry.ts` (process-wide PrimeManager registry keyed by account-storage identity), `cli.ts` (fallback account login + relay setup), `tui.tsx` (sidebar source), `tui/entry.mjs` (host-runtime-aware compiled/raw loader), `tui/command-dialogs.tsx` (command modal dialog components), `tui-compiled/` (generated build output, shipped but git-ignored), `tui-preferences.ts` (JSONC preferences file), `sidebar-state.ts` (quota/routing, prime status, and session-keyed recovery state for TUI sidebar IPC), `sanitize-memo.ts` (system prompt sanitization memoization), `prompt-context.ts` (prompt context resolver)

**`packages/opencode/src/rpc/`:**
- Purpose: Loopback HTTP RPC between OpenCode server and TUI process
- Contains: `rpc-server.ts`, `rpc-client.ts`, `rpc-dir.ts`, `port-file.ts`, `protocol.ts`, `notifications.ts`

**`packages/opencode/scripts/`:**
- Purpose: Build and smoke-testing scripts for the precompiled TUI
- Contains: SolidJS build transformation and package installation validation
- Key files: `build-tui.ts` (compiles the SolidJS/OpenTUI files to `src/tui-compiled/` with virtual modules), `smoke-tui-pack-install.ts` (validates TUI installation and dependency resolution)

**`packages/pi/src/`:**
- Purpose: Pi extension — registers CortexKit Anthropic provider override
- Contains: Extension entry point, command registration, request building, streaming provider
- Key files: `index.ts` (provider registration), `stream.ts` (streaming request handling), `commands.ts` (slash command registration), `convert.ts` (request body conversion), `paths.ts` (Pi-specific path resolution)

**`packages/e2e-tests/`:**
- Purpose: Integration tests with mock Anthropic and relay servers
- Contains: Test harness, mock server implementations, process runner with temp dir hygiene, end-to-end integration tests (tool prefix, quota header relay, temp directory hygiene)

**`scripts/`:**
- Purpose: Development, release, and analysis utilities
- Contains: `dev.ts` / `dev-clean.ts` (local dev workflow with symlinks), `release.sh` / `wait-release.sh` (tag-driven npm release), `analyze-cache-usage.mjs` (OpenCode SQLite cache analyzer), `extract-system-prompt.ts` (prompt capture extraction), `capture-with-mitmproxy.sh` (HTTPS capture setup), `version-sync.mjs` (cross-package version alignment)

## Key File Locations

**Entry Points:**
- `packages/opencode/src/index.ts`: OpenCode plugin factory (exported as `AnthropicAuthPlugin`)
- `packages/opencode/src/cli.ts`: CLI binary entry (`opencode-anthropic-auth`)
- `packages/pi/src/index.ts`: Pi extension entry (default export function)
- `packages/opencode/src/tui.tsx`: TUI sidebar source (SolidJS component), loaded through `src/tui/entry.mjs` from precompiled output on current OpenTUI hosts
- `packages/core/src/index.ts`: Shared core library entry (re-exports all modules)

**Configuration:**
- `package.json` (root): Bun workspace root — workspace config, shared dev dependencies, root scripts
- `packages/core/package.json`: Core package — depends only on `xxhash-wasm`
- `packages/opencode/package.json`: OpenCode package — depends on core + OpenCode SDK + SolidJS + OpenTUI
- `packages/pi/package.json`: Pi package — depends on core + Pi SDKs (peer dependencies)
- `biome.json`: Biome linter and formatter config
- `mise.toml`: Runtime version management (Bun, Node.js)
- `lefthook.yml`: Git hooks configuration
- `tsconfig.*.json`: TypeScript configs (root + per-package build configs)

**Core Logic:**
- `packages/core/src/auth.ts`: OAuth authorize → PKCE challenge → token exchange → refresh
- `packages/core/src/oauth-profile.ts`: OAuth profile metadata fetch, tier formatting (`Max 5x`, `Team · Max 5x`), and 7-day TTL validation
- `packages/core/src/quota-headers.ts`: Normalization of `anthropic-ratelimit-unified-*` headers from direct fetch and relay transports into shared quota snapshots
- `packages/core/src/token-fingerprint.ts`: Non-reversible SHA-256 token fingerprinting for profile-to-token binding
- `packages/core/src/accounts.ts`: Sidecar file read/write, account CRUD, quota API fetch, in-process write serialization, cross-process configuration file locking and account merging (with `ENOENT`/`EINVAL` eviction race handling), prime opt-in, auth-lineage bindings, and per-account runtime usage counters
- `packages/core/src/quota-manager.ts`: Unified quota cache with backoff + staleness and fresh-result metadata for quota priming
- `packages/core/src/relay.ts`: Cloudflare Worker HTTP/WebSocket relay protocol
- `packages/core/src/cch.ts`: XXH64-based request body signing
- `packages/core/src/cachekeep.ts`: Hybrid cache pre-warming manager with local-window and process-lifetime `always` schedules
- `packages/core/src/cachekeep-registry.ts`: Temporary lease registry for cross-process tracked-session status
- `packages/core/src/prime.ts`: Opt-in five-hour quota priming command, eligibility gates, minimal Haiku request body, and cross-process marker-claim scheduler
- `packages/core/src/routing.ts`: Main-first / fallback-first / sticky-balanced routing mode configuration and commands
- `packages/core/src/sticky-routing.ts`: Cross-process session assignment registry and quota-weighted sticky allocator
- `packages/core/src/killswitch.ts`: Per-account and model-scoped hard-block thresholds and command execution logic
- `packages/core/src/provider.ts`: Duck-typed provider HTTP error classification
- `packages/core/src/logging.ts`: Logging level command execution logic
- `packages/core/src/commands/account.ts`: Account slash command execution logic
- `packages/core/src/cache1h.ts`: 1h prompt cache configuration and commands
- `packages/core/src/fast.ts`: Fast mode configuration and commands
- `packages/core/src/dump.ts`: Request/response dump capture logic and commands
- `packages/core/src/models.ts`: Supported Claude models and specs, including the Haiku 4.5 prime model and pricing constants
- `packages/core/src/logger.ts`: Shared structured logger
- `packages/core/src/pkce.ts`: PKCE challenge generation helper
- `packages/core/src/quotas.ts`: Quota calculation and formatting helpers
- `packages/core/src/constants.ts`: Global application constants
- `packages/opencode/src/transform.ts`: Request rewriting (including trailing whitespace tool prefill stripping), system sanitization, cache strategy and model-specific cache bridges, server-side fallback request/response integration, completed-tool refusal continuation, tool prefix, SSE stripping
- `packages/opencode/src/server-fallback.ts`: Default Anthropic server-side safety fallback opt-in for OAuth Fable 5/Opus 5, hidden signed storage markers for unsupported `fallback` blocks, outgoing marker restoration, streamed handoff/sticky/restoration classification, and terminal-refusal rewriting after completed tool calls
- `packages/opencode/src/fable-fallback.ts`: Per-session and source-model-family 10-response Opus 4.8 backstop state, source-model prewarming, and standby cache-anchor identity; used after unabsorbed server-policy refusals or exclusively under `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy`
- `packages/opencode/src/prime-manager-registry.ts`: Process-wide registry that shares PrimeManager instances by account-storage identity and releases managers when project slots move
- `packages/opencode/src/sidebar-state.ts`: Shared quota/routing, prime status, and session-keyed server/legacy safety fallback state file for TUI sidebar IPC, using cross-process `mkdir` directory locks, read-before-write routing preservation, and pre/post-rename ownership fences
- `packages/opencode/src/sanitize-memo.ts`: System prompt sanitization memoization LRU cache
- `packages/opencode/src/prompt-context.ts`: Resolves context (agent, model, variant, and latest message IDs for assistant/user) for synthetic OpenCode user messages to preserve model state and support message ordering
- `packages/opencode/src/tui/command-dialogs.tsx`: Command modal dialog presentation and input formatting
- `packages/pi/src/stream.ts`: Pi provider streaming implementation

**Tests:**
- `packages/opencode/src/tests/`: One test file per module (30+ test files covering core + opencode)
- `packages/pi/src/tests/`: Pi-specific tests (convert, stream, index)
- `packages/e2e-tests/tests/`: Integration tests

## Naming Conventions

**Files:** Lowercase with hyphens for all TypeScript source files (`auth.ts`, `quota-manager.ts`, `fallback-account.ts`). Each module file exports a focused set of related functions/types.

**Directories:** Lowercase with hyphens for feature directories (`rpc/`, `tui/`, `e2e-tests/`). Tests are co-located in `tests/` subdirectories.

**Packages:** `@cortexkit/anthropic-auth-core`, `@cortexkit/opencode-anthropic-auth`, `@cortexkit/pi-anthropic-auth` — follows the `@scope/package` + `-core`/`-opencode`/`-pi` suffix convention for the monorepo packages.

**Exports:** Core library re-exports all modules through a barrel (`packages/core/src/index.ts`). OpenCode and Pi packages import from core by name, not path.

## Where to Add New Code

**New shared feature (used by both OpenCode and Pi):** `packages/core/src/[feature].ts` — add the implementation, export it from `packages/core/src/index.ts`, then import it in the OpenCode plugin and/or Pi extension as needed.

**New OpenCode hook or fetch transform:** `packages/opencode/src/` — follow the pattern in `index.ts` for hook registration or `transform.ts` for pipeline steps. Add tests in `packages/opencode/src/tests/`.

**New slash command:** Register the command name in `packages/core/src/constants.ts` (or a dedicated module), implement execution logic in core (shared) or per-package (if platform-specific), add the command hook in `packages/opencode/src/index.ts` (config hook) or `packages/pi/src/commands.ts`. If the command owns a background scheduler, keep its manager in core and adopt one process-wide manager through a keyed registry in the host package; persist user opt-in separately from runtime counters when the command spans processes, as `/claude-prime` does.

**New TUI feature:** `packages/opencode/src/tui/` — add components as `.tsx` files using SolidJS + OpenTUI. Add RPC protocol types in `packages/opencode/src/rpc/protocol.ts` if the feature needs server-to-TUI IPC.

**New test:** Co-locate with source as `*.test.ts` — `packages/opencode/src/tests/` for unit tests covering opencode and core modules, `packages/pi/src/tests/` for Pi-specific tests, `packages/e2e-tests/tests/` for integration tests.

**New script:** `scripts/` (for global analysis/development tools) or `packages/opencode/scripts/` (for TUI build/packaging validations) — use TypeScript (run with `bun`) or plain JavaScript. Reference `tsconfig.scripts.json` or `packages/opencode/tsconfig.scripts.json` for TypeScript compilation options.

**New CLI command:** `packages/opencode/src/cli.ts` — add the subcommand handler following the `login`/`list`/`api add`/`relay setup` pattern.

**New model spec:** `packages/core/src/models.ts` — add model ID, pricing, context window, and max output tokens constants. If it needs special request handling, update `packages/opencode/src/transform.ts` (e.g., Fable/Mythos, Sonnet 5, or Opus 5 adaptive thinking normalization).

**Shared utilities used across packages:** Extend `packages/core/src/` rather than duplicating between opencode and pi packages.
