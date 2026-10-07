# Codebase Structure

## Directory Layout

```
anthropic-auth/
├── packages/
│   ├── core/                   # Shared core library
│   │   └── src/                # Reusable OAuth, quota, cache, relay, signing
│   │       ├── commands/       # Shared command execution
│   │       └── tests/          # Core-focused unit tests
│   ├── opencode/               # OpenCode plugin + CLI
│   │   ├── src/
│   │   │   ├── rpc/            # Loopback RPC server/client for TUI IPC
│   │   │   ├── tests/          # Comprehensive test suite per module
│   │   │   │   ├── fixtures/   # Test fixtures (claustrum-golden, realistic prompts)
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
├── docs/                       # Feature docs, research, plans, specs, and perf notes
├── images/                     # Images for README
└── .github/                    # CI workflows + issue templates
```

## Directory Purposes

**`packages/core/src/`:**
- Purpose: All reusable OAuth, account management, optional Claustrum custody, model metadata, quota, host-local quota feeds, cache, relay, dump, signing, thinking-binding, routing, and command execution logic
- Contains: TypeScript modules, each focused on one concern, plus core unit tests in `tests/`
- Key files: `index.ts` (re-exports all public API), `accounts.ts` (sidecar storage + types + quota API + prime opt-in, Claustrum gates, and runtime counters), `auth.ts` (OAuth authorization + token exchange + refresh), `claustrum.ts` (connection discovery and custody tombstone guards), `claustrum-scoped-runtime.ts` (scoped credential discovery and per-send authorization), `claustrum-scoped-roster.ts` (locked secret-free routing projection), `oauth-profile.ts` (OAuth profile fetch + rate limit tier formatting), `quota-headers.ts` (passive quota header extraction and normalization), `quota-header-feed.ts` (sanitized host-local quota observation leases with per-field provenance), `token-fingerprint.ts` (SHA-256 token fingerprinting for legacy migration and credential lineage), `relay.ts` (Cloudflare Worker relay protocol), `quota-manager.ts` (centralized quota cache), `cachekeep.ts` (hybrid cache pre-warming), `cachekeep-registry.ts` (cross-process tracked-session lease registry), `prime.ts` (opt-in five-hour quota priming and cross-process scheduler), `start.ts` (explicit lane-start command parsing and text), `cch.ts` (body signing, bounded process-local Claude Code version-suffix pinning, request lineage formatting, and lineage stripping for reusable bodies), `claude-code.ts` (Claude Code identity + billing headers), `thinking-binding.ts` (configurable Fable 5.1 thinking-prefix controls), `mid-conversation-output-config.ts` (cache-stable Fable 5.1 effort changes), `provider.ts` (provider HTTP error classification), `logging.ts` (logging level commands), `commands/account.ts` (account command execution), `cache1h.ts` (1h prompt cache configuration), `fast.ts` (fast mode configuration), `dump.ts` (request/response dump capture and size-capped background sweeping), `models.ts` (Claude model specs, Haiku prime pricing, and context-window qualifier normalization), `logger.ts` (structured logger), `json.ts` (redacted JSON parser diagnostics for secret-bearing files and bodies), `network-errors.ts` (transient network and DNS error classification), `pkce.ts` (PKCE helpers), `routing.ts` (routing mode commands), `sticky-routing.ts` (persistent quota-balanced session affinity), `killswitch.ts` (hard-block and model-scoped thresholds), `quotas.ts` (quota calculation), `constants.ts` (global constants), `custom-headers.ts` (proxy-only custom header parsing), `model-remap.ts` (proxy route model aliases)

**`packages/opencode/src/`:**
- Purpose: OpenCode plugin implementation — fetch interception, request rewriting, CLI, TUI sidebar, command dialogs
- Contains: Plugin entry point, transform pipeline, cache diagnostics, CLI, TUI widget (SolidJS), precompiled TUI loader/output, RPC server for TUI IPC, preferences management
- Key files: `index.ts` (single exported plugin factory — auth loader, command registration, background services), `request-policy.ts` (internal killswitch request classification and messaging), `transform.ts` (request body rewriting + SSE stream stripping), `custody-mode.ts` (fail-closed scoped startup admission), `custody-dimensions.ts` (route custody classification), `cache-diagnostics.ts` (cache diagnosis beta opt-in, message ID tracking, and schema v:2 record formatting), `server-fallback.ts` (Anthropic server-side safety fallback opt-in, fallback-boundary preservation, outcome detection, and completed-tool refusal continuation), `fable-fallback.ts` (session-and-source-family 10-response Opus 4.8 backstop/legacy recovery and standby cache-anchor state), `prime-manager-registry.ts` (process-wide PrimeManager registry keyed by account-storage identity), `lane-start.ts` (synthetic prompt injection and request correlation), `cli.ts` (fallback account login + relay setup), `tui.tsx` (sidebar source), `tui/entry.mjs` (host-runtime-aware compiled/raw loader), `tui/command-dialogs.tsx` (command modal dialog components), `tui-compiled/` (generated build output, shipped but git-ignored), `tui-preferences.ts` (comment-preserving JSONC preferences with directory-watch and independent polling reload paths), `sidebar-state.ts` (quota/routing, prime status, and session-keyed recovery state for TUI sidebar IPC), `sanitize-memo.ts` (system prompt sanitization memoization), `prompt-context.ts` (prompt context resolver), `effort-history.ts` (request-scoped Fable 5.1 effort timeline), `billing-lineage.ts` (user-turn prompt UUID and previous Anthropic request ID tracking across tool loops, internal correlation headers, and session invalidation)

**`packages/opencode/src/setup/`:**
- Purpose: Interactive setup wizard and environment detection for OpenCode, Pi, and Claustrum custody
- Contains: `command.ts` (wizard orchestration), `detect.ts` (OpenCode, Pi, and Claustrum detection), `process-fence.ts` (host quiescence verification), `opencode-config.ts` (comment-preserving `opencode.jsonc` and `tui.jsonc` plugin updates), `pi.ts` (Pi extension installation and local OAuth conflict resolution), `activation.ts` (fenced OpenCode auth tombstone installation), `claustrum.ts` (consumer enrollment, grant, discovery, and scoped roster commitment), `command-runner.ts` (safe child execution), `paths.ts` (host path resolution), `jsonc.ts` (safe JSONC editing), `types.ts`

**`packages/opencode/src/rpc/`:**
- Purpose: Project-isolated loopback HTTP RPC between OpenCode server and TUI process, with session-scoped notification delivery, serialized same-directory replacement, and identity-fenced server disposal
- Contains: `rpc-server.ts`, `server-registry.ts`, `rpc-client.ts`, `rpc-dir.ts`, `port-file.ts`, `protocol.ts`, `notifications.ts`

**`packages/opencode/scripts/`:**
- Purpose: Build, smoke-testing, and bundle validation scripts for the OpenCode plugin and precompiled TUI
- Contains: SolidJS build transformation, package installation validation, and bundle artifact registry verification
- Key files: `build-tui.ts` (compiles the SolidJS/OpenTUI files to `src/tui-compiled/` with virtual modules), `smoke-tui-pack-install.ts` (verifies packed Node CLI startup and compiled TUI dependency resolution from a fresh install), `check-bundle-globals.ts` (validates bundle artifact size and RPC server registry globals)

**`packages/pi/src/`:**
- Purpose: Pi extension — registers CortexKit Anthropic provider override
- Contains: Extension entry point, command registration, request building, streaming provider
- Key files: `index.ts` (provider and model-catalog registration), `stream.ts` (streaming request handling including redacted-thinking preservation), `commands.ts` (slash command registration), `convert.ts` (Claude Code-compatible request conversion, a bounded in-memory map that holds the Claude Code billing-version suffix stable for each session, origin-aware thinking-signature filtering, configurable Fable 5.1, Opus 5.5, Sonnet 5.5, and Haiku 5.5 adaptive-thinking prefix behavior, mid-conversation effort markers, redacted-thinking replay, Pi documentation-prompt relocation, and cache breakpoint placement), `transcript.ts` (host-independent system-prompt and tool replay for Pi and Oh My Pi), `effort-history.ts` (compaction-aware Pi thinking-level timeline), `paths.ts` (Pi-specific path resolution)

**`packages/e2e-tests/`:**
- Purpose: Integration tests with mock Anthropic, relay, and Claustrum servers
- Contains: Test harness, mock server implementations, process runner with temp dir hygiene, end-to-end integration tests (tool prefix, quota header relay, temp directory hygiene, custody mode, mock claustrum)

**`scripts/`:**
- Purpose: Development, release, and analysis utilities
- Contains: `dev.ts` / `dev-clean.ts` (local dev workflow with symlinks), `release.sh` / `wait-release.sh` (tag-driven npm release), `analyze-cache-usage.mjs` (OpenCode SQLite cache analyzer), `check-claustrum-golden.ts` (pins canonical Claustrum tombstone ancestry and exact fixture bytes), `check-pi-tool-mapping.ts` (runs an isolated real Pi host tool round-trip against deterministic SSE), `check-pi-dist-imports.ts` (AST-validates emitted Pi host-SDK imports, rejecting unsupported or unverifiable dynamic imports in CI and release), `check-test-count-floors.ts` (runs unit suites once; compares floors against the merge target in PR CI and the previous version tag at release), `extract-system-prompt.ts` (prompt capture extraction), `capture-with-mitmproxy.sh` (HTTPS capture setup), `version-sync.mjs` / `workspace-lock.mjs` (cross-package versions, surgical Bun lockfile synchronization, and manifest-to-lock validation)

## Key File Locations

**Entry Points:**
- `packages/opencode/src/index.ts`: OpenCode plugin factory (exported as `AnthropicAuthPlugin`)
- `packages/opencode/src/cli.ts`: CLI binary entry (`opencode-anthropic-auth`)
- `packages/pi/src/index.ts`: Pi extension entry (default export function)
- `packages/opencode/src/tui.tsx`: TUI sidebar source (SolidJS component), loaded through `src/tui/entry.mjs` from precompiled output on current OpenTUI hosts
- `packages/core/src/index.ts`: Shared core library entry (re-exports all modules)

**Configuration:**
- `package.json` (root): Bun workspace root — workspace config, shared dev dependencies, root scripts
- `packages/core/package.json`: Core package — depends on `xxhash-wasm` and `@cortexkit/claustrum-client`; only the E2E mock declares `@cortexkit/subc-client` directly
- `packages/opencode/package.json`: OpenCode package — depends on core + OpenCode SDK + SolidJS + OpenTUI
- `packages/pi/package.json`: Pi package — depends on core + Pi SDKs (peer dependencies)
- `biome.json`: Biome linter and formatter config
- `mise.toml`: Runtime version management (Bun, Node.js)
- `lefthook.yml`: Git hooks configuration
- `tsconfig.*.json`: TypeScript configs (root + per-package build configs)

**Core Logic:**
- `packages/core/src/auth.ts`: OAuth authorize → PKCE challenge → token exchange → refresh, with provider-bound custody tombstones rejected before network access
- `packages/core/src/claustrum.ts`: Claustrum connection-file discovery and provider-scoped tombstone recognition/refusal
- `packages/core/src/claustrum-scoped.ts`: Per-dispatch credential retrieval and send-time record-version 401 reporting through enrolled scoped access
- `packages/core/src/claustrum-scoped-runtime.ts`: Shared client lifecycle, discovery polling, and quota/profile authorization
- `packages/core/src/claustrum-scoped-roster.ts`: Locked projection of verified inventory into secret-free OAuth routing rows
- `packages/core/src/claustrum-enrollment.ts`: Host-specific enrollment paths and crash-resumable, setup-only Claustrum ceremony — owner-only bounded state, secret-before-propose persistence, idempotent crash replay, one-shot token persistence ordering, producer-permanent refusal classification, cross-process locking, terminal reset guards, and read-only status projection
- `packages/core/src/oauth-profile.ts`: OAuth profile metadata fetch, tier formatting (`Max 5x`, `Team · Max 5x`), and 7-day TTL validation
- `packages/core/src/quota-headers.ts`: Normalization of `anthropic-ratelimit-unified-*` headers from direct fetch and relay transports into shared quota snapshots
- `packages/core/src/quota-header-feed.ts`: Schema-versioned, owner-only per-process lease files containing an explicit allowlist of fresh quota observations for host-local consumers
- `packages/core/src/token-fingerprint.ts`: Non-reversible SHA-256 token fingerprinting retained for legacy state migration, refresh-token lineage, and other credential-bound guards
- `packages/core/src/accounts.ts`: Sidecar file read/write, account CRUD, quota API fetch, stable main-account slot identity, account-identity-bound quota/profile state, observation-fenced quota-error clears, refresh-token-hash-bound error/backoff state, global Claustrum mode and scoped inventory state, in-process write serialization, cross-process configuration file locking and account merging (with `ENOENT`/`EINVAL` eviction race handling), prime opt-in, auth-lineage bindings, and per-account runtime usage counters
- `packages/core/src/quota-manager.ts`: Stable-account-identity-keyed quota cache with backoff, replacement generations, staleness, and fresh-result metadata for quota priming
- `packages/core/src/relay.ts`: Cloudflare Worker HTTP/WebSocket relay protocol
- `packages/core/src/cch.ts`: XXH64-based final-body signing plus Claude Code 2.1.280 billing suffix extraction, bounded per-session pinning, request lineage formatting (`cc_prev_req`, `cc_prompt_id`), and lineage stripping for reusable bodies
- `packages/core/src/claude-code.ts`: Claude Code identity system instructions and billing headers
- `packages/core/src/cachekeep.ts`: Hybrid cache pre-warming manager with local-window and process-lifetime `always` schedules, stripping request-scoped billing lineage from pre-warm bodies
- `packages/core/src/cachekeep-registry.ts`: Temporary lease registry for cross-process tracked-session status
- `packages/core/src/prime.ts`: Opt-in five-hour quota priming command, eligibility gates, minimal Haiku request body, and cross-process marker-claim scheduler
- `packages/core/src/start.ts`: Shared parsing and user-facing text for the explicit OpenCode lane-start command
- `packages/core/src/routing.ts`: Main-first / fallback-first / sticky-balanced routing mode configuration and commands
- `packages/core/src/sticky-routing.ts`: Cross-process session assignment registry and quota-weighted sticky allocator
- `packages/core/src/killswitch.ts`: Per-account and model-scoped hard-block thresholds and command execution logic
- `packages/core/src/provider.ts`: Duck-typed provider HTTP error classification
- `packages/core/src/logging.ts`: Logging level command execution logic
- `packages/core/src/commands/account.ts`: Account slash command execution logic
- `packages/core/src/cache1h.ts`: 1h prompt cache configuration and commands
- `packages/core/src/fast.ts`: Fast mode configuration and commands
- `packages/core/src/dump.ts`: Request/response dump capture logic, response metadata artifacts, same-session on-disk byte-diff baseline recovery after restart, CacheKeep/Prime prewarm tagging, and commands
- `packages/core/src/models.ts`: Supported Claude models and specs, including Fable/Mythos 5.1 release metadata and pricing, Haiku 5.5 metadata and its 100K request-wide pricing tier, context-window qualifier normalization (`[1m]`) for model-family checks, and the Haiku 4.5 prime model
- `packages/core/src/thinking-binding.ts`: Shared replay detection and configurable `account-default`/`error`/`drop_block` controls for Fable 5.1, Opus 5.5, Sonnet 5.5, and Haiku 5.5 signed/redacted thinking
- `packages/core/src/mid-conversation-output-config.ts`: Shared Fable 5.1 effort normalization and empty-system-marker insertion while keeping the cached top-level effort stable
- `packages/core/src/logger.ts`: Shared structured logger
- `packages/core/src/json.ts`: Shared JSON parsing helpers that redact parser source context while preserving path, line, and column diagnostics
- `packages/core/src/network-errors.ts`: Shared transient DNS and transport error classification for OAuth refresh and quota recovery
- `packages/core/src/custom-headers.ts`: Bounded, redacted parsing for API-key/proxy-only custom headers with protected authentication, protocol, framing, and internal-correlation names
- `packages/core/src/model-remap.ts`: Proxy-only generic and family-specific model alias resolution with strict family boundaries
- `packages/core/src/pkce.ts`: PKCE challenge generation helper
- `packages/core/src/quotas.ts`: Quota calculation and formatting helpers
- `packages/core/src/constants.ts`: Global application constants
- `packages/opencode/src/transform.ts`: Request rewriting (including trailing whitespace tool prefill stripping, Fable/Mythos 5.1 adaptive-thinking normalization, conditional Fable 5.1 binding controls, Claude Code 2.1.280 billing suffix pinning and request lineage, cache diagnostics opt-in, API-route model aliases, and version-aware proxy base-path composition), source-cache prewarm lineage stripping, system sanitization, cache strategy and model-specific cache bridges, server-side fallback request/response integration, completed-tool refusal continuation, tool prefix, SSE stripping
- `packages/opencode/src/cache-diagnostics.ts`: Cache diagnosis beta request opt-in (`diagnostics.previous_message_id`), session message ID tracking, schema v:2 record construction with TTL token breakdown, and beta header hash deduplication
- `packages/opencode/src/server-fallback.ts`: Default Anthropic server-side safety fallback opt-in for OAuth Fable 5/5.1 and Opus 5, hidden signed storage markers for unsupported `fallback` blocks, outgoing marker restoration, streamed handoff/sticky/restoration classification, and terminal-refusal rewriting after completed tool calls
- `packages/opencode/src/fable-fallback.ts`: Per-session and source-model-family 10-response Opus 4.8 backstop state (recognizing context-window-qualified models like `[1m]`), source-model prewarming, and standby cache-anchor identity; used after unabsorbed server-policy refusals or exclusively under `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy`
- `packages/opencode/src/prime-manager-registry.ts`: Process-wide registry that shares PrimeManager instances by account-storage identity and returns generation-fenced project-slot leases, preventing late predecessor disposal from releasing a reloaded successor
- `packages/opencode/src/request-policy.ts`: Internal killswitch block classification and user-facing request-policy messages kept outside the plugin entrypoint so OpenCode invokes only `AnthropicAuthPlugin`
- `packages/opencode/src/lane-start.ts`: Resolves the current prompt context, injects the exact synthetic lane-start marker, and correlates its message ID to one request through a bounded session-scoped tracker
- `packages/opencode/src/sidebar-state.ts`: Shared quota/routing, prime status, and session-keyed server/legacy safety fallback state file for TUI sidebar IPC, using cross-process `mkdir` directory locks, read-before-write routing preservation, and pre/post-rename ownership fences
- `packages/opencode/src/sanitize-memo.ts`: System prompt sanitization memoization LRU cache
- `packages/opencode/src/prompt-context.ts`: Resolves context (agent, model, variant, and latest message IDs for assistant/user) for synthetic OpenCode user messages to preserve model state and support message ordering
- `packages/opencode/src/effort-history.ts`: Carries bounded Fable 5.1 effort transitions across OpenCode host lowering with stable checksum-bound user-boundary markers, a plan-bound current-user anchor, and a fixed-size request-plan header retained across same-message provider retries; accepts correlated tool-result continuations and ordered transitions merged onto one wire user boundary, retains bounded and revocable history for overwritten in-flight plans, folds exact-suffix-trimmed changes into the baseline only with an authenticated surviving anchor, strips internal state before dispatch, and fails locally on unprovable total marker loss or non-prefix correlation loss
- `packages/opencode/src/billing-lineage.ts`: Correlates user message prompt UUIDs and upstream Anthropic request IDs across tool turns via internal headers, excludes background and synthetic turns, tracks session sequence/generations, and commits valid `req_*` responses to feed `previousRequestId` into the billing header
- `packages/opencode/src/custody-mode.ts`: Scoped-only startup verdict and fail-closed mismatch classification
- `packages/opencode/src/custody-dimensions.ts`: Classification of scoped roster, main tombstone, and OAuth fallback dimensions
- `packages/opencode/src/tui-preferences.ts`: Comment-preserving JSONC preference reads/writes plus live reload through content-checked directory events and an independent polling fallback for missed events or `fs.watch` construction failures
- `packages/opencode/src/tui/command-dialogs.tsx`: Command modal dialog presentation and input formatting
- `packages/pi/src/commands.ts`: Pi slash command registration (`/claude-*`) and persistent setting handlers
- `packages/pi/src/paths.ts`: Pi-specific storage and config path resolution
- `packages/pi/src/convert.ts`: Pi-to-Anthropic request conversion, including ordered system prompt block flattening, session-stable Claude Code billing suffixes, same-origin thinking-signature replay, configurable Fable 5.1 compaction behavior, mid-conversation effort markers, redacted_thinking mapping, Pi documentation-prompt relocation, and four-slot cache breakpoint placement
- `packages/pi/src/transcript.ts`: Locally replays host system messages and tool changes rather than importing helpers absent from Oh My Pi's legacy SDK shim
- `packages/pi/src/effort-history.ts`: Rebuilds Fable 5.1 effort transitions from Pi's active branch and compaction-aware context entries (locally derived when buildContextEntries is absent)
- `packages/pi/src/stream.ts`: Pi provider streaming implementation, including preservation of Anthropic redacted-thinking blocks for later replay, request-resolved host tool names for SSE tool-call mapping, API-key route versioned URL composition, and safe custom header application

**Tests:**
- `packages/core/src/tests/`: Core-only unit tests (dump, killswitch, models, prime, quota surfaces, accounts persistence, custom headers, model remap, claustrum)
- `packages/opencode/src/tests/`: OpenCode unit and integration tests, including scoped Claustrum custody, billing lineage, a fail-closed network guard, and test-host filesystem/daemon isolation. `preload-sandbox.ts` initializes a disposable sandbox before `setup.ts` imports Core (whose logger/dump defaults are fixed at module load), then `setup.ts` restores account, sidebar, cache, RPC, dump, and daemon paths before/after tests so clearing a feature override cannot reach live state.
- `packages/pi/src/tests/`: Pi-specific tests (commands, convert, effort-history, index, stream)
- `packages/e2e-tests/tests/`: Process integration tests (tool prefix, quota header relay, temp directory hygiene, scoped custody, and Opus 5.5 structured output with and without the schema tool call)

## Naming Conventions

**Files:** Lowercase with hyphens for all TypeScript source files (`auth.ts`, `quota-manager.ts`, `fallback-account.ts`). Each module file exports a focused set of related functions/types.

**Directories:** Lowercase with hyphens for feature directories (`rpc/`, `tui/`, `e2e-tests/`). Tests are co-located in `tests/` subdirectories.

**Packages:** `@cortexkit/anthropic-auth-core` for the shared core, and `@cortexkit/<host>-anthropic-auth` for integrations (`opencode`, `pi`).

**Exports:** Core library re-exports all modules through a barrel (`packages/core/src/index.ts`). OpenCode and Pi packages import from core by name, not path.

## Where to Add New Code

**New shared feature (used by both OpenCode and Pi):** `packages/core/src/[feature].ts` — add the implementation, export it from `packages/core/src/index.ts`, then import it in the OpenCode plugin and/or Pi extension as needed.

**New OpenCode hook or fetch transform:** `packages/opencode/src/` — follow the pattern in `index.ts` for hook registration or `transform.ts` for pipeline steps. Add tests in `packages/opencode/src/tests/`.

**New slash command:** Register the command name in `packages/core/src/constants.ts` (or a dedicated module), implement execution logic in core (shared) or per-package (if platform-specific), add it to the shared `COMMAND_MODAL_NAMES` tuple in `packages/opencode/src/rpc/protocol.ts`, register its `template` and `description` in the `config` hook, and handle it exhaustively in `buildDialogPayload` in `packages/opencode/src/index.ts`. The tuple derives the closed `CommandModalName` type and the `command.execute.before` interception list; `index.test.ts` asserts that the config-hook command set exactly matches it, while the exhaustive payload branch makes new unhandled modal names fail type-checking. An interactive palette check still verifies that the running host surfaces the command. For Pi, add the command in `packages/pi/src/commands.ts`. If the command owns a background scheduler, keep its manager in core and adopt one process-wide manager through a keyed registry in the host package; persist user opt-in separately from runtime counters when the command spans processes, as `/claude-prime` does.

**New TUI feature:** `packages/opencode/src/tui/` — add components as `.tsx` files using SolidJS + OpenTUI. Add RPC protocol types in `packages/opencode/src/rpc/protocol.ts` if the feature needs server-to-TUI IPC.

**New test:** Add `*.test.ts` under the owning package's test directory — `packages/core/src/tests/` for core-only tests, `packages/opencode/src/tests/` for OpenCode and shared-core integration tests, `packages/pi/src/tests/` for Pi-specific tests, and `packages/e2e-tests/tests/` for process-level integration tests.

**New script:** `scripts/` (for global analysis/development tools) or `packages/opencode/scripts/` (for TUI build/packaging validations and bundle checks) — use TypeScript (run with `bun`) or plain JavaScript. Reference `tsconfig.scripts.json` or `packages/opencode/tsconfig.scripts.json` for TypeScript compilation options.

**New CLI command:** `packages/opencode/src/cli.ts` — add the subcommand handler following the `login`/`list`/`api add`/`relay setup` pattern.

**New model spec:** `packages/core/src/models.ts` — add model ID, pricing, context window, and max output tokens constants. If it needs special request handling, update `packages/opencode/src/transform.ts` (e.g., Fable/Mythos, Sonnet 5/5.5, or Opus 5/5.5 adaptive thinking normalization).

**Shared utilities used across packages:** Extend `packages/core/src/` rather than duplicating between opencode and pi packages.
