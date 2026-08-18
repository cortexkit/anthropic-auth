# Architecture

## Pattern Overview

**Overall:** Plugin/extension-based OAuth proxy architecture — a shared core library provides Claude Pro/Max OAuth logic, with two separate integration packages adapting it to different agent platforms (OpenCode plugin and Pi provider extension).

**Key Characteristics:**
- Shared core (`@cortexkit/anthropic-auth-core`) contains all OAuth, quota, cache, relay, and request-signing logic — no duplication between agent integrations
- OpenCode integration operates at the **fetch/request transform** layer: intercepts Anthropic fetch calls, rewrites URLs and request bodies, sanitizes system prompts, and strips tool-prefix on streaming responses
- Pi integration operates at the **provider override** layer: replaces Pi's built-in Anthropic provider with a CortexKit implementation that uses the same shared core
- Sidecar JSON files persist config, fallback accounts, and runtime state — separate from the host agent's own credential store
- All external Anthropic API interactions go through shared core modules: OAuth token exchange, quota API, Claude Code identity bootstrap, and relay Worker

## Layers

**@cortexkit/anthropic-auth-core (Shared Core):**
- Purpose: Reusable OAuth, account, quota, cache, relay, dump, SSE, and request-signing logic
- Location: `packages/core/src/`
- Contains: OAuth authorization/token exchange (`auth.ts`), profile fetching (`oauth-profile.ts`), account storage (`accounts.ts`), PKCE generation (`pkce.ts`), token fingerprinting (`token-fingerprint.ts`), quota management (`quota-manager.ts`, `quotas.ts`, `quota-headers.ts`), cache control (`cache1h.ts`, `cachekeep.ts`, `cachekeep-registry.ts`), relay protocol (`relay.ts`), dump capture (`dump.ts`), Claude Code identity and body signing (`claude-code.ts`, `cch.ts`), routing (`routing.ts`, `sticky-routing.ts`), killswitch thresholds (`killswitch.ts`), fast mode (`fast.ts`), model specs (`models.ts`), logging commands and config (`logging.ts`), provider HTTP error contracts (`provider.ts`), account command execution (`commands/account.ts`), shared structured logger (`logger.ts`), and constants (`constants.ts`)
- Depends on: `xxhash-wasm` (for cch body signing), Node.js built-ins (`crypto`, `fs`, `os`)
- Used by: Both `@cortexkit/opencode-anthropic-auth` and `@cortexkit/pi-anthropic-auth`

**@cortexkit/opencode-anthropic-auth (OpenCode Plugin):**
- Purpose: OpenCode plugin that intercepts Anthropic fetch requests, provides CLI, TUI sidebar, and command modal dialogs
- Location: `packages/opencode/src/`
- Contains: Plugin entry point (`index.ts`), CLI (`cli.ts`), request transform/SSE stripping (`transform.ts`), Anthropic server-side safety fallback (`server-fallback.ts`), legacy content-filter recovery (`fable-fallback.ts`), system prompt sanitization (`sanitize-memo.ts`, `prompt-context.ts`), TUI sidebar widget (`tui.tsx`), TUI preferences (`tui-preferences.ts`), command modal dialogs (`tui/command-dialogs.tsx`), loopback RPC server/client for TUI IPC (`rpc/`), and TUI sidebar IPC state management (`sidebar-state.ts`)
- Depends on: `@cortexkit/anthropic-auth-core`, `@opencode-ai/plugin` (peer), `@opentui/core` + `@opentui/solid` + `solid-js` (TUI), `jsonc-parser` (TUI preferences)
- Used by: OpenCode agent (loaded as plugin + TUI plugin)

**@cortexkit/pi-anthropic-auth (Pi Extension):**
- Purpose: Pi package that registers a CortexKit Anthropic provider override under Pi's built-in `anthropic` provider ID
- Location: `packages/pi/src/`
- Contains: Extension entry point (`index.ts`), command registration (`commands.ts`), request body conversion (`convert.ts`), Pi-specific path resolution (`paths.ts`), streaming provider implementation (`stream.ts`)
- Depends on: `@cortexkit/anthropic-auth-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (all peer)
- Used by: Pi agent (loaded as Pi package)

**End-to-End Tests:**
- Purpose: Integration tests for the full OpenCode plugin flow with mock Anthropic and relay servers
- Location: `packages/e2e-tests/`
- Contains: Test harness (`src/harness.ts`), mock servers (`src/mock-anthropic.ts`, `src/mock-relay.ts`), OpenCode runner (`src/opencode-runner.ts` with orphaned process and temp directory hygiene), test files (`tests/tool-prefix.test.ts`, `tests/quota-header-relay.test.ts`, `tests/tmp-hygiene.test.ts`)

## Data Flow

**OpenCode Request Lifecycle:**

1. **Plugin load** — OpenCode loads `@cortexkit/opencode-anthropic-auth` plugin, which starts background refresh timers, creates `QuotaManager` and `FallbackAccountManager`, initializes RPC server, and registers `auth.loader` + `provider.models` hooks. The model hook publishes native adaptive `low` through `max` effort variants for Opus 5 instead of legacy manual-thinking budgets. On boot, the plugin resolves the initial sidebar routing only after the asynchronous account-storage load completes, ensuring a peer's concurrent routing-authoritative publish during the load is not overwritten by a stale pre-load snapshot. — `packages/opencode/src/index.ts`
2. **Auth loader** — When OpenCode creates an Anthropic session, the plugin's `auth.loader` runs: captures the OAuth `getAuth` function, starts main token refresh background loop — `packages/opencode/src/index.ts` (AnthropicAuthPlugin → auth.loader)
3. **Command registration** — Plugin registers `/claude-cache`, `/claude-cachekeep`, `/claude-quota`, `/claude-dump`, `/claude-fast`, `/claude-routing`, `/claude-killswitch`, `/claude-account`, `/claude-logging` — `packages/opencode/src/index.ts` (config hook)
4. **Request interception** — OpenCode's fetch wrapper calls the plugin's hooks — `packages/opencode/src/index.ts` (experimental fetch wrapping)
5. **URL rewrite** — `rewriteUrl()` adds `?beta=true` to `/v1/messages` and overrides base URL when `ANTHROPIC_BASE_URL` is set — `packages/opencode/src/transform.ts`
6. **Request body rewrite** — `rewriteRequestBody()` strips trailing assistant messages and trailing whitespace after tool_use, normalizes Fable/Mythos, Sonnet 5, and Opus 5 adaptive thinking, injects billing header, sanitizes system prompt (removes OpenCode identity), prepends Claude Code identity, applies cache strategy (explicit/automatic/hybrid), adds fast mode, prefixes tool names with `mcp_`, opts eligible OAuth Fable 5/Opus 5 requests into Anthropic server-side safety fallback, restores stored fallback boundary markers, and creates `cch` over the serialized body — `packages/opencode/src/transform.ts`, `packages/opencode/src/server-fallback.ts`
7. **Routing** — `shouldFallbackStatus()` checks if response should trigger fallback; `FallbackAccountManager` iterates accounts in ordered modes, while `StickySessionRouter` assigns cold sessions by reset-normalized spendable OAuth quota and weighted initial-prompt deficit, then persists hashed session affinity across processes/restarts. Sticky routes retain transient failures, hold confirmed 5h exhaustion when reset is within 15 minutes, and migrate for longer confirmed exhaustion/permanent account failure. All modes respect model-scoped quotas and killswitch thresholds (including per-model scoped thresholds). If all accounts fail the killswitch policy, a 429 block response is returned immediately; this block is classified as scoped-driven (matching a specific model's weekly limit) or account-level (5h/7d limits) with a model-specific or generic retry hint — `packages/core/src/routing.ts`, `packages/core/src/accounts.ts`, `packages/opencode/src/index.ts`
8. **Relay** — `sendViaRelay()` sends full or patched body to Cloudflare Worker, which streams Anthropic response back. HTTP relay responses and WebSocket `response_start` control messages deliver genuine upstream headers to the OpenCode account-bound quota harvester; synthetic optimistic response headers are never harvest input, and relay-to-direct fallback stays owned by the direct path — `packages/core/src/relay.ts`, `packages/opencode/src/index.ts`
9. **SSE stream and content-filter safety fallback** — By default, OAuth Fable 5 and Opus 5 requests send `fallbacks: "default"` with Anthropic's `server-side-fallback-2026-07-01` beta. The stream wrapper detects initial `fallback` blocks, sticky `fallback_message` usage iterations, and restoration to the requested model. Because OpenCode does not natively preserve `fallback` content blocks, the wrapper rewrites each block into a hidden signed thinking marker for storage, then the next eligible request restores the exact Anthropic fallback boundary before signing and sending. If an eligible OAuth response still terminates in refusal, the deterministic 10-successful-response Opus 4.8 recovery activates as a client-side backstop. Source-model prewarms explicitly remove `fallbacks` so they cannot be sticky-routed back to a fallback model. If a served fallback completes a `tool_use` before its terminal refusal, the wrapper preserves that completed call, changes the terminal finish to `tool_use`, and lets OpenCode continue on Opus 4.8 with the existing `tool_result` instead of replaying the tool. The active Anthropic-selected target and later restoration are written per session to the TUI sidebar state; when no matching TUI is connected, OpenCode Desktop receives an ignored/no-reply `promptAsync` notice that the plugin queues and arms for delivery on the `session.updated` event following `session.idle`, then escapes the awaited event handler with `setImmediate` because OpenCode evaluates the run-loop exit condition only after awaiting event handlers. Intermediate `tool-calls` completions do not flush notices. The plugin probes `session.status()` outside that critical section, re-arming inconclusive probes for at most four attempts, with attempt 0 on `setImmediate` and later attempts delayed by `25` ms multiplied by the attempt number, and attempts best-effort message-ID placement before the active assistant; the previous ordering guarantee was abandoned because on OpenCode 1.18 and newer a notice that becomes the latest user message makes the run loop invoke the provider again on the same turn, producing a duplicate billed provider turn. Custom API-key routes strip the beta and `fallbacks` field. Setting `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy` bypasses the server policy and uses the same deterministic Opus 4.8 recovery from the first refusal, keyed by session and source-model family with account-bound source-model prewarming and standby cache bridges beyond Anthropic's 20-block lookback — `packages/opencode/src/transform.ts`, `packages/opencode/src/server-fallback.ts`, `packages/opencode/src/fable-fallback.ts`, `packages/opencode/src/prompt-context.ts`, `packages/opencode/src/index.ts`
10. **Sidebar update** — `writeSidebarState()` writes quota/routing/cache state plus bounded per-session Fable recovery status to a JSON file read by the TUI sidebar widget (separate process via RPC). Routing-authoritative writes (e.g. active routing decisions) are distinguished from display-only/metadata writes (e.g. quota refreshes or command paths). Display-only writes re-read the file and merge state to preserve any live routing session's `activeId` and route. Cross-process writes are synchronized using an atomic `mkdir` directory lock with jittered retries, rename-claim eviction (tolerating `ENOENT` and `EINVAL` race conditions during marker eviction), and lock-budget exhaustion skips. The write is fenced: ownership is verified before and after the rename, triggering one bounded locked repair of routing-authoritative fields on post-rename loss. — `packages/opencode/src/sidebar-state.ts`, `packages/opencode/src/index.ts`

**Pi Request Lifecycle:**

1. **Extension load** — Pi loads `@cortexkit/pi-anthropic-auth` package, which calls `registerCommands()` and `pi.registerProvider("anthropic", ...)` — `packages/pi/src/index.ts`
2. **Provider registration** — Provider defines OAuth login/refresh functions (delegating to core's `authorize`/`exchange`/`refreshClaudeOAuthToken`) and a `streamSimple` function — `packages/pi/src/index.ts`
3. **Stream implementation** — `streamCortexKitAnthropic()` in `packages/pi/src/stream.ts` builds the Anthropic request, sends via relay or direct, handles ordered or persistent sticky-balanced routing (including model-scoped quota routing), and cache keepalive
4. **Slash commands** — `/claude-*` commands registered in `packages/pi/src/commands.ts` reuse core command execution functions

**Quota Refresh & Header Harvest Flow:**
1. Background timer fires at `checkIntervalMinutes` (default 5) — `packages/core/src/quota-manager.ts`
2. `QuotaManager.refreshMain()` fetches `https://api.anthropic.com/api/oauth/usage` (including standard five-hour/seven-day windows and weekly scoped model limits) with the access token
3. On success: persists quota snapshot (including a top-level `checkedAt` freshness timestamp to support merge resolution of windowless empty-scoped quotas) to sidecar state file, updates sidebar state — `packages/opencode/src/index.ts` (onMainQuotaFetched callback)
4. On 429: records backoff with `nextRetryAt` timestamp — prevents further refreshes during backoff — `packages/core/src/accounts.ts`
5. Fallback accounts: `FallbackAccountManager` refreshes per-account quotas in background, persists to state, notifies sidebar — `packages/opencode/src/index.ts`
6. Passive header harvesting: Upstream response headers (`anthropic-ratelimit-unified-*`) on direct fetch and HTTP/WebSocket relay transports are passively harvested (`normalizeQuotaHeaders`), merged into the quota snapshot, and update sidebar state without extra API polling — `packages/core/src/quota-headers.ts`, `packages/opencode/src/index.ts`
7. Account profile metadata: Organization tier metadata (`Max 5x`, `Team · Max 5x`) is fetched from `https://api.anthropic.com/api/oauth/profile` (`fetchOAuthAccountProfile`), bound via SHA-256 token fingerprint, cached with a 7-day TTL, and persisted fire-and-forget without blocking user command execution — `packages/core/src/oauth-profile.ts`, `packages/core/src/token-fingerprint.ts`

**Cache Keepalive Flow:**
1. `CacheKeepManager` tracks recently used hybrid-cache sessions and their associated `oauthAccountId` — `packages/core/src/cachekeep.ts`
2. ~5 minutes before the 1-hour cache TTL expires, sends a `max_tokens: 0` pre-warm request (authenticated using the corresponding main or fallback account credentials) to extend the cache entry
3. Removes response-only fields (streaming, thinking, structured output, forced tool choice) from the pre-warm body
4. Each manager publishes session IDs and cache timing (never request bodies, headers, or tokens) to a host-scoped temporary lease registry; status commands aggregate live records across project/plugin processes, and stale process records age out after three minutes. Schedule mode can be a local hour window or `always`, which remains active across midnight while the process is open

## Key Abstractions

**QuotaManager:**
- Purpose: Unified quota cache and API gateway for main + fallback accounts — deduplication, rate-limit backoff, staleness handling
- Location: `packages/core/src/quota-manager.ts`
- Pattern: Singleton instance shared by plugin and fallback manager; token-fingerprint aware to detect account switches

**FallbackAccountManager:**
- Purpose: Manages background token refresh and quota fetch for fallback OAuth/API accounts
- Location: `packages/core/src/accounts.ts`
- Pattern: Created per-plugin-instance; iterates accounts and schedules per-account refresh timers

**StickySessionRouter:**
- Purpose: Quota-balance cold sessions without moving an established prompt cache between OAuth accounts
- Location: `packages/core/src/sticky-routing.ts`
- Pattern: Cross-process locked atomic registry keyed by SHA-256 session hashes. Candidate weights combine spendable 5h/7d/model-scoped quota, reset horizon, and bytes assigned since the candidate quota snapshot. Assignments survive transient errors, can be cleared for the current session with `/claude-routing reset`, and expire after seven inactive days. Direct Opus allocation first consumes usable accounts with exhausted Fable scope; OpenCode Fable recovery continues on the original sticky account.

**CacheKeepManager:**
- Purpose: Tracks hybrid-cache sessions and sends pre-warm requests before 1-hour TTL expiry; also exposes immediate zero-output prewarming for Fable/Opus 5 content-filter recovery
- Location: `packages/core/src/cachekeep.ts`
- Pattern: In-memory target tracking with configurable local window or process-lifetime `always` schedule; tracks the associated `oauthAccountId` to pre-warm using the correct credentials; supports up to 32 concurrent sessions per manager and publishes sanitized tracking snapshots on changes/heartbeats

**CacheKeepSessionRegistry:**
- Purpose: Aggregates current CacheKeep session visibility across independently loaded OpenCode project plugins or Pi processes without sharing request payloads or credentials
- Location: `packages/core/src/cachekeep-registry.ts`
- Pattern: One atomic JSON lease record per manager under the system temporary directory; records contain only session IDs and cache timing, are separated into OpenCode/Pi scopes, deduplicate by session ID, and are ignored after a three-minute stale lease

**ServerSideFallbackStreamRewriter:**
- Purpose: Opts eligible OAuth Fable 5/Opus 5 requests into Anthropic's default safety fallback, preserves fallback conversation boundaries across OpenCode storage, and classifies active/restored fallback outcomes
- Location: `packages/opencode/src/server-fallback.ts`
- Pattern: Request-time restoration converts CortexKit-signed hidden markers back to Anthropic `fallback` blocks before `cch` signing. The streaming rewriter converts newly returned fallback blocks into hidden thinking markers that OpenCode can persist, observes top-level served models and `usage.iterations[].type === "fallback_message"`, and emits one outcome at the terminal message delta. It also tracks completed `tool_use` blocks: when a terminal refusal follows one, it activates client recovery and exposes a normal `tool_use` finish so OpenCode preserves the call and continues with the existing result. Marker restoration is enabled only for eligible server-fallback requests; custom API-key routes drop internal markers and server-fallback opt-ins.

**FableFallbackManager:**
- Purpose: Provides deterministic 10-successful-response Opus 4.8 recovery as the default server policy's refusal backstop and as the exclusive policy under `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy`
- Location: `packages/opencode/src/fable-fallback.ts`
- Pattern: Bounded, expiring in-memory map keyed by session and source-model family, with cycle IDs so late responses cannot decrement a newer recovery cycle; preserves each family's OAuth account identity and newest account-bound Opus 4.8 tail fingerprint for source-model prewarming and later cache bridges. Source-model prewarms remove the server-fallback request field and beta so they always reach the intended source model.

**PromptContextResolver:**
- Purpose: Resolves the active agent, model, variant, and latest message IDs (assistant and user) from the OpenCode session message history
- Location: `packages/opencode/src/prompt-context.ts`
- Pattern: Traverses recent session messages via the client API to reconstruct the current model/variant context for synthetic/ignored notification turns. This prevents OpenCode from resetting to default model configurations or misattributing background prompt notices.

**AccountStorage (sidecar file):**
- Purpose: Persisted configuration and runtime state — fallback accounts, quotas, refresh backoff, killswitch settings, cache/relay config
- Location: `packages/core/src/accounts.ts`
- Pattern: JSON file on disk (`~/.config/opencode/anthropic-auth.json` for OpenCode, `~/.pi/agent/anthropic-auth.json` for Pi). Runtime credentials/quota state lives in `anthropic-auth-state.json`; sticky routing affinity lives in `anthropic-auth-routing-state.json`. Atomic writes via temp + rename. Serializes all account-store and state writes via an in-process save mutex and acquires a cross-process write lock on the configuration file during save. Merges existing accounts on disk with incoming accounts on save to prevent fallback account loss under concurrent execution. Refresh file lock acquisition tolerates `ENOENT` and `EINVAL` lost-parent races when creating eviction marker files under high contention. Preserves empty scoped quota arrays `[]` on load/merge to distinguish explicit zero-carve-out from missing quota metadata.

**rewriteRequestBody:**
- Purpose: Full Anthropic request body transform — handle cache strategies (including legacy model-specific standby bridges), system sanitization, trailing whitespace tool prefill stripping, tool name prefixing, billing headers, server-side fallback opt-in/marker restoration, and body signing
- Location: `packages/opencode/src/transform.ts`
- Pattern: Clean pipeline of idempotent transforms; returns the original body on any parse failure (fail-closed)

**SidebarState:**
- Purpose: Shared state file between OpenCode server process and TUI widget process for live quota/routing/cache display and per-session safety fallback status
- Location: `packages/opencode/src/sidebar-state.ts`
- Pattern: JSON file under `$TMPDIR`; server writes after each routing decision or quota refresh; TUI polls on interval. Supports displaying standard usage windows alongside scoped model quotas (e.g. Fable weekly limit), omitting standard five-hour and seven-day placeholders when only model-scoped limits are visible, preserving empty scoped arrays `[]` to distinguish explicit ownership from missing data, and carries a bounded set of session-keyed server-side fallback or legacy Opus/Fable recovery notices so concurrent sessions do not overwrite each other's sidebar state. Non-authoritative updates re-read the file before merging to preserve active routing sessions (`activeId`). Cross-process writes are guarded by an `mkdir` directory lock with atomic rename-claim eviction of stale locks, jittered retries, and lock-budget exhaustion skips. Writes are fenced with pre- and post-rename ownership checks; if a post-rename lock loss is detected, a single bounded locked repair restores the routing-authoritative fields into the successor's fresh state.

**RPC Server/Client:**
- Purpose: Loopback HTTP server for TUI ↔ OpenCode server IPC — modal dialogs and notification delivery
- Location: `packages/opencode/src/rpc/`
- Pattern: Bearer-authenticated HTTP server on `127.0.0.1`; port file + token written to disk for TUI process discovery

## Entry Points

**OpenCode Plugin:**
- Location: `packages/opencode/src/index.ts`
- Triggers: OpenCode loads the plugin on startup — registers hooks, starts background services
- Responsibilities: Plugin factory (`AnthropicAuthPlugin`), auth loading, command registration, fetch interception, sidecar config management, background refresh orchestration

**OpenCode CLI:**
- Location: `packages/opencode/src/cli.ts`
- Triggers: User runs `bunx @cortexkit/opencode-anthropic-auth <command>`
- Responsibilities: Fallback account login (OAuth + API key), account listing, relay setup (Cloudflare Worker provisioning)

**Pi Extension:**
- Location: `packages/pi/src/index.ts`
- Triggers: Pi loads the installed package on startup
- Responsibilities: Register Anthropic provider override, register slash commands

**TUI Sidebar Widget:**
- Location: source in `packages/opencode/src/tui.tsx`; package loader in `packages/opencode/src/tui/entry.mjs`
- Triggers: OpenCode TUI loads the plugin from `tui.json`
- Packaging: build-time Solid/OpenTUI transformation emits `src/tui-compiled/` with host-runtime virtual imports; the loader selects that compiled tree on OpenTUI 0.4.x and retains raw TSX only for older hosts/development checkouts
- Responsibilities: Render quota/reporting sidebar, open command modal dialogs on `/claude-*` commands, honor TUI preferences from `tui-preferences.jsonc`

## Error Handling

**Strategy:** Fail-closed on parse failures (returns original request body vs crashing); 429 backoff with exponential retry for token refresh; retryable stream errors detected and bubbled as synthetic `ECONNRESET` for retry by the caller. Sticky-balanced routing fails retryably while its quota pool is incomplete instead of silently selecting a non-sticky account; once the pool is complete but has no eligible route, it returns an explicit 429 quota block, or a 401 re-login error when the main refresh token is permanently invalid and no fallback can serve the requested model, rather than falling through to the excluded main account. Confirmed five-hour exhaustion with at most 15 minutes until reset returns a deterministic jittered `Retry-After` while retaining affinity. Killswitch blocks requests before they hit the API when quota drops below configured thresholds (including per-model scoped thresholds evaluated against the requested model). Blocks are classified as scoped-driven (when a specific model's weekly limit is reached) or account-level (5h/7d limits), generating detailed user-facing error messages. Fallback routing triggers on confirmed standard quota exhaustion or model-scoped quota exhaustion (stale cached quota never triggers API-key fallback routes). Content-filter handling tries Anthropic's server-side safety fallback first for eligible OAuth Fable 5/Opus 5 requests, then activates deterministic client recovery if the response still refuses. A refusal after a completed tool call preserves that call and continues with its existing result rather than replaying the original turn. Malformed or unrecognized fallback metadata passes through without fabricated state; `legacy` mode bypasses the server policy and uses deterministic client recovery exclusively.

## Cross-Cutting Concerns

**Logging:** Simple structured logger (`packages/core/src/logger.ts`) writing to `$TMPDIR/opencode-anthropic-auth.log`; relay diagnostics and performance tracing behind `OPENCODE_ANTHROPIC_AUTH_PERF=1` env flag

**Caching:** In-memory quota cache (`QuotaManager`) with staleness-based refresh logic; memoized system prompt sanitization (`sanitize-memo.ts`) with 8MB max; 1-hour Anthropic prompt cache managed via cache strategy (`cache1h.ts`, `cachekeep.ts`)

**Storage:** Sidecar JSON files for config + credential/quota state (separate files to avoid config overwrite), a cross-process locked `anthropic-auth-routing-state.json` containing hashed sticky session assignments, JSONC preferences for the TUI (`tui-preferences.jsonc`), JSON state for TUI sidebar IPC at `$TMPDIR/opencode-anthropic-auth/`, and an auto-sweeping dump directory for request payloads capped at 512MB by default.

**Security:** OAuth tokens are stored in the sidecar state file (separate from config); sticky routing stores only SHA-256 session hashes, account IDs, quota timestamps, and initial input byte counts; relay uses a shared secret token; RPC server uses a bearer token; token refresh and configuration/routing writes use file locks to prevent races and concurrent write loss; no secrets are stored in git
