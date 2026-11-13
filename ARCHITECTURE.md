# Architecture

anthropic-auth lets coding agents use a Claude Pro, Max or Ultra subscription the way Claude Code does. It signs in with Claude's OAuth flow and keeps the tokens fresh. It reshapes each model request into the shape Claude Code 2.1.302 sends, and it spreads sessions across several subscription accounts while respecting their quota. Beyond that, it keeps the provider's prompt cache stable and warm, because on a long session the cached prefix is most of the cost.

It runs in three hosts and shares one core:

- **OpenCode 1.x and 2.x**, as the npm plugin `@cortexkit/opencode-anthropic-auth` (`packages/opencode`). OpenCode 1 loads `AnthropicAuthPlugin` and wraps the Anthropic provider's `fetch`. OpenCode 2 loads the `./server` export's `setup` and goes through common-auth's OpenCode 2 installer. The package's default export carries both, so one install serves either host.
- **Pi**, as `@cortexkit/pi-anthropic-auth` (`packages/pi`). It replaces Pi's built-in `anthropic` provider with its own stream implementation.
- **Core**, `@cortexkit/anthropic-auth-core` (`packages/core`): OAuth, accounts and custody, routing, quota, cache, request shaping helpers, message threads, relay, dumps and menus. Both host packages import it by name. Core bundles `@cortexkit/common-auth` (a dev dependency, pinned exactly) into its own `dist`.

Accounts are kept either in a **local pool** on disk or in the **Claustrum vault** (a local credential service; see Custody). `docs/` has the user-facing detail for each subsystem.

## Terms

- **Main account / fallback accounts:** the pool's primary Claude account and any further accounts. Routing and the sidebar call the primary `main`.
- **Route:** one place a request can go: an OAuth account, or (local mode only) a paid API key.
- **Custody:** who holds the credentials. **Local** means the native pool files on this machine. **Vault** means Claustrum, reached through an enrollment approved once per host kind. While a host is enrolled, local credentials never serve, refresh, poll or warm (the exclusive-vault rule).
- **Placeholder:** a non-secret entry in the host's own auth slot that makes the host route Anthropic requests to this plugin without holding a real token. OpenCode 1 uses an expired OAuth tombstone (`claustrum-tombstone:v1:anthropic`). OpenCode 2 uses common-auth's `common-auth-placeholder.anthropic`. Pi uses common-auth's move-aside slot, with an inert API-key placeholder.
- **Sticky session:** in `sticky-balanced` routing, a session stays on the account it was given, so its prompt cache stays valid.
- **Hold:** keeping a session on its exhausted account and asking the host to retry later, instead of moving it and paying for a cache rebuild.
- **Killswitch / quota floor:** a user-set minimum remaining quota below which an account is refused locally.
- **Prompt cache, TTL:** Anthropic caches a request prefix for 5 minutes or 1 hour. Changing any byte in the prefix makes everything after it a cache write again.
- **CacheKeep (keep-warm):** resending a session's last accepted request with `max_tokens: 0` shortly before its cache expires, so an idle session keeps its cache.
- **Message thread:** Anthropic's `message-threads-2026-08-12` beta. After a full `create` request, later requests send only the new messages and point at the previous response.
- **Server-side fallback:** Anthropic's safety fallback (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`). When a model refuses for safety, Anthropic reruns the request on a fallback model in the same response.
- **Recovery round:** OpenCode 1's client backstop. After a refusal the safety fallback did not absorb, it sends the next 10, 20, then 40 responses to Opus 4.8 before trying the original model again.
- **Effort marker:** an empty system message carrying a changed reasoning effort mid-conversation, so the top-level effort (part of the cached prefix) never changes.
- **Turn note:** a turn-scoped system message (`clear_at: "next_user_message"`). The plugin adds its own turn-end note, and places notes a Thalamus runner supplies.
- **Insula:** the vault side's shared quota cache. In vault mode the plugin reads quota from it instead of polling Anthropic for every account.
- **Thalamus:** the runner that hosts agent sessions on this machine. The plugin reads routing advice and turn notes from it through the `cortexkit.routing` accessor, and in hosted mode reads vault accounts through its relay (see Custody).

## Code map

| Layer | Where | Role |
|---|---|---|
| OpenCode 1 entry | `packages/opencode/src/index.ts` | Plugin factory: auth loader with custom `fetch`, message and header hooks, `/claude` command, background services, dispose. |
| OpenCode 1 request shaping | `packages/opencode/src/transform.ts` | Rewrites URL and body, and rewrites the SSE stream on the way back. |
| OpenCode 2 | `packages/opencode/src/v2/` | `setup.ts` installs common-auth's OpenCode 2 adapter. `source.ts` chooses accounts and retries. `adapter.ts` shapes and sends requests. Also menus, sidebar projection, keep-warm and Prime. |
| OpenCode shared | `packages/opencode/src/` | Server fallback, OpenCode 1 recovery rounds, effort plan transport, billing lineage, cache diagnostics, sidebar state, RPC for the TUI, setup CLI. |
| TUI | `packages/opencode/src/tui/`, `src/tui.tsx` | Sidebar (shared common-auth frame) and `/claude` dialogs, precompiled to `src/tui-compiled/` at build time. |
| Pi | `packages/pi/src/` | Provider registration, request conversion (`convert.ts`), streaming and transport (`stream.ts`, `transport.ts`), commands, keep-warm. |
| Core accounts | `packages/core/src/native-*.ts`, `pool-*.ts` | Native account runtime, local credential service and refresh coordinator, vault runtime and custody, enrollment authority, migration, host auth slots, menus. |
| Core request | `packages/core/src/` | `cch.ts` and `claude-code.ts` (billing header and body signature), `model-capabilities.ts` (per-model handling), `message-threads.ts`, `request-gzip.ts`, `relay.ts`, `thinking-binding.ts`, `mid-conversation-output-config.ts`, `turn-end-note.ts`, `oauth-origin.ts`. |
| Core policy | `packages/core/src/` | `routing.ts`, `sticky-routing.ts`, `killswitch.ts`, `quota-manager.ts`, `quota-headers.ts`, `insula-quota.ts`, `quota-refusal.ts`, `session-cache-activity.ts`. |
| Core cache | `packages/core/src/` | `cache1h.ts`, `cachekeep.ts` (keep-warm manager), `cachekeep-store.ts` (restart store), `cachekeep-registry.ts` (cross-process session list), `prime.ts`. |
| State layout | `packages/core/src/state-layout-*.ts`, `holder-registry.ts`, `layout-fence.ts` | Moving machine-written state out of OpenCode's config folder. Written, with the move switched off. |
| End-to-end | `packages/e2e-tests/` | Real OpenCode processes against mock Anthropic, relay and Claustrum servers. |

`STRUCTURE.md` has the directory map and where to add code.

## Request lifecycle

The order is the same on every host. Only the hook that runs each step differs (see the host sections).

1. **Admission.** Choose an account for the session (see Routing) and check it against quota policy. A request blocked by the user's own floor or killswitch is refused locally, with a message naming the limit and when it resets.
2. **Authorization.** Get a valid access token for that account. In local mode this goes through the refresh coordinator. In vault mode each send asks the vault for a fresh scoped receipt. A healthy request (valid token, known identity, ready roster) takes **no lock** before it is sent; per-host tests count lock acquisitions to enforce this.
3. **Shaping.** Rewrite the body into Claude Code's shape:
   - **Identity and billing:** sanitize OpenCode's identity out of the system prompt and prepend Claude Code's identity. Add the billing header with its `cc_version` suffix (pinned per session from the first user message) and request lineage (`cc_prompt_id`, `cc_prev_req`).
   - **Tools:** prefix tool names with `mcp_`.
   - **Cache:** place cache breakpoints for the chosen strategy (explicit, automatic or hybrid; at most four) and set the cache lifetime.
   - **Per-model handling** from `model-capabilities.ts`: thinking mode, rejected forced tool choice, effort markers, thinking-binding controls, turn-end notes, server-side fallback, fast mode, beta lists.
   - **History checks:** refuse locally, before anything is signed, a history that ends on a meaningful assistant turn or carries effort markers that don't match the session's plan.
4. **Message thread.** On the final body, decide `create`, `continue` or stateless (see Message threads), then compute the `cch` body signature once.
5. **Transport.**
   - **Destination:** OAuth requests go only to `https://api.anthropic.com`. Neither the provider `baseURL` nor `ANTHROPIC_BASE_URL` moves them; the latter applies to API-key routes only.
   - **Direct sends:** large direct bodies are gzipped the way Claude Code does, with one uncompressed resend if a proxy rejects them.
   - **Relay:** the optional Cloudflare Worker relay supports HTTP and WebSocket on OpenCode 1 and Pi, and HTTP only on OpenCode 2. A relay failure falls back to a direct send at most once per request.
   - **Abort:** the caller's abort signal ends the request at every step, including pre-send quota, profile and refresh work, which also have their own 30-second limits.
6. **Response.**
   - **Stream:** the stream is rewritten on the way back: `mcp_` prefixes are stripped, server-fallback blocks are turned into storable markers, and in-stream API errors become retryable connection errors.
   - **Bookkeeping:** rate-limit headers are read as quota evidence, the thread anchor is recorded, and the request is tracked for keep-warm once Anthropic accepts it. Bookkeeping writes never delay the response. At shutdown they get a one-second grace before pending lock waits are cancelled.

### OpenCode 1

- **Hooks:** `experimental.chat.messages.transform` adds checksum-bound effort markers to user turns and assigns prompt ids. `chat.headers` attaches internal correlation headers (effort plan, billing lineage, lane start). The `fetch` wrapper reads those headers, strips them, and runs steps 1-6.
- **Several projects, one server:** one OpenCode server runs a plugin instance per project. The instances share one native account runtime through leases, coalesce token refreshes per account store, and keep one loopback RPC server per project for the TUI.

### OpenCode 2

- **Installer:** common-auth's installer owns the provider integration. The plugin supplies `chooseAccount`, `retrySameAccount`/`dropSameAccountRetry` (vault-newer, local-newer, relay-to-direct and interrupted-read retries) and `rewriteResponse`.
- **Placeholder:** OpenCode 2 routes to the plugin only when the selected Anthropic connection is the plugin's exact placeholder. Stock API keys, OpenCode's own Anthropic login and custom proxies pass through untouched.
- **Holds:** OpenCode 2 holds by returning a retry delay from the installer, capped at 15 minutes per hold.
- **No WebSocket relay:** a selected WebSocket relay is refused before dispatch.

### Pi

- **Provider:** `registerProvider('anthropic', …)` with `streamSimple`.
- **Conversion:** `convert.ts` builds the body. Pi's documentation paragraph is moved out of the top-level system prompt into a cached block before the first user text, because its text can trigger OAuth billing rejection. Signed thinking is replayed only when it came from the same API and model.
- **Effort history:** rebuilt from the session branch on each `turn_start`.
- **Threads:** a whole-turn lease keeps tool-loop steps on one thread.
- **Server fallback:** Pi does not opt into server-side fallback.

## Shared user settings

`settings-definition.ts` declares the flat, user-only settings and generates the published Core schema at `packages/core/schema/anthropic-auth.schema.json`. OpenCode 1, OpenCode 2 and Pi use `settings-service.ts` over common-auth's public settings handle. The service is shared by resolved user-file path, with a lease per runtime/instance and the watch closed on the last release. Startup and watch changes resolve a whole generation in memory (no-model plus each model-capability row); requests never read or lock the settings file. `native-runtime-settings.ts` merges that generation with the account stores' remaining state and directs menu writes. No project settings file is read, watched or reported.

The target is `$HOME/.config/cortexkit/anthropic-auth.jsonc` on Linux/macOS, `%APPDATA%\cortexkit\anthropic-auth.jsonc` on Windows, or the full `cortexkit/anthropic-auth.jsonc` path under an absolute `XDG_CONFIG_HOME` on any OS. `settings-paths.ts` also resolves `ANTHROPIC_AUTH_SETTINGS_FILE` and separate installs. Separate installs retain legacy settings reads/writes and do not watch the shared file. See [settings paths and overrides](docs/settings-file.md).

`settings-start.ts` and `settings-move-run.ts` run the one-time startup move, using common-auth's `moveSettingsOnce` and the existing source-writer locks through publication. The holder/version fence checks that no older live plugin process can still read or write the old settings before allowing the move. Default targets read both hosts' current-custody sources; a custom target or private XDG config home reads only the acting host's resolved stores. Sources remain byte-identical and keep serving the state that did not move. The owner-only `<target>.moved` marker records a completed move, even one with no sources; a hand-made file that parses is marked too. `.MOVED_READPLEASE` notes are for people, never authority. A later host takes ordinary settings from the file; `settings-host-import.ts` fills only stricter legacy protection that the file does not already set for that host, once, with `<target>.moved.<host>` recording the check. A failed/refused import keeps that host in legacy mode until a later start retries.

Protection values are applied as a complete set. An unusable file keeps last-good values; startup recovery uses the host's applied copy, then its own readable legacy store, then restrictive defaults. `settings-protection-copy.ts` atomically maintains owner-only `<target>.applied.json` beside the user file, with a complete set per host and no credentials. Only usable user-file protection is copied. Missing-file menu writes preserve both hosts' known sets with host overrides and host-tagged floors; the writer's values reach both only when the peer has no set. Unknown protection refuses recreation. The old pool/vault settings sections remain intact for rollback, but the last published release does not see settings changed in the shared file.

## Custody

`readNativeEnrollmentMode()` (backed by common-auth's `enrollmentAuthority()`) is the only custody authority. It is read fresh for each operation, as the last awaited step before credential use or publication.

- **Local mode:** the native pool.
  - **Files:** accounts, relay settings and quota metadata live in `anthropic-auth-pool.json`; moved user settings are retained there for rollback and legacy/separate installs. State lives in `anthropic-auth-pool-state.json` and `anthropic-auth-native-state.json`, with a migration journal and custody roster in their resolved path set. Paths come from `pool-paths.ts`, and private credentials are written owner-only.
  - **Refresh:** the refresh coordinator refreshes each credential under its lock and fences every publication by account UUID and credential version. A spent refresh token's successor is always persisted, even when the request that triggered it is gone.
- **Vault mode:** stopped-host setup (`opencode-anthropic-auth setup --claustrum`) enrolls the host kind with Claustrum (`anthropic-auth-opencode`, `anthropic-auth-pi`). The enrollment token stays in an owner-only file under `~/.local/state/cortexkit/anthropic-auth/`.
  - **Roster:** the vault runtime discovers a secret-free, UUID-verified account list and keeps it, with relay settings, routing pins and quota, in a separate `anthropic-auth-vault-*.json` namespace. Shared user settings are custody-independent; the old vault settings section remains for rollback and legacy/separate installs.
  - **Receipts:** each send gets a fresh common-auth receipt. A rejected send is retried once on the same account only if the vault proves a newer record version.
  - **Outages:** an unreachable vault never falls back to local credentials.
- **Hosted mode (Thalamus):** when Thalamus launches the host with `CORTEXKIT_VAULT_HOST=thalamus`, the plugin reads vault accounts through Thalamus's relay (common-auth's `connectVaultHost()`), with no enrollment of its own. The same vault folders, routing pins and Insula quota are used, so a session keeps its account when its host moves under Thalamus. Local accounts never serve, and setup, Connect and Disconnect are refused.
  - **Marker latch:** the marker is read once and fixed for the life of the process (`native-vault-host.ts`). If it ever reads differently, every request is refused until restart, and a synchronous check runs right before each credential is returned, sent or saved.
  - **Relay outages:** the current connection keeps serving its kept receipts while a new client is tried in the background. The plugin switches only after a real roster read through the new client succeeds, then closes the old one once. A switch never retires a token already in use. A 401 on a token issued before the switch gets one fresh authorization and one retry.
  - **Pi:** Pi only reads its auth slot. A real Claude login there is refused per prompt with a fixed message; Pi still starts, and other providers are unaffected.
- **Moving between modes:** both directions happen only in stopped-host setup: migrating 1.x sidecar files into the native pool, enrolling, and disconnecting (which restores local state byte for byte). Running hosts only read enrollment state. The `/claude` menu explains, but never enrolls. `docs/custody-state-machine.md` has the file map and transitions.

## Routing

Modes are `main-first` (default), `fallback-first` and `sticky-balanced` (`routing.ts`). All modes respect the killswitch and per-model scoped quota. A paid API-key route (local mode only) is used only after fresh general OAuth exhaustion is confirmed.

`StickySessionRouter` (`sticky-routing.ts`):

- **Assignment:** a cold session goes to an account by reset-normalized spendable quota and weighted prompt deficit. Assignments are stored as SHA-256 session hashes in a cross-process locked file, and expire after seven inactive days. Changing the model discards the old assignment. An internal Fable/Opus recovery model keeps it.
- **Confirmed exhaustion:** the session holds on its account only when every exhausted window that blocks the request (5-hour, 7-day or the model's scoped window) has a known future reset, and the latest reset plus a per-session jitter fits before the session's cache expires and within `routing.maxSameAccountWait` (`0`, `15` minutes by default, or `max`). Otherwise it moves.
- **Unconfirmed 429:** the session stays on its account, with waits of at most 60 seconds each, up to `MAX_UNCONFIRMED_SAME_ACCOUNT_RETRIES` (2) per turn. The third unconfirmed 429 moves it.
- **No route:** a complete pool with no eligible route returns an explicit refusal (sign in again, or a quota 429, or a non-retryable 412 when waiting is off). An incomplete pool fails retryably.

**Shared routing.** When Thalamus provides the `cortexkit.routing` accessor, the plugin asks it once per account choice (OpenCode 1 sticky resolve, OpenCode 2 `chooseAccount`), with a 2-second limit. The answer is only advice: the local rules above still apply. The plugin also sends detached `served` and `exhausted` reports.

## Quota

- **Polls:** `QuotaManager` polls Anthropic's usage endpoint per account (default every 5 minutes), keyed by stable account identity, not the rotating token. A 429 backs off. A 403 is a policy error and never arms a backoff.
- **Headers:** each response's `anthropic-ratelimit-unified-*` headers update the 5-hour and 7-day windows without dropping poll-owned scoped windows (such as the Fable weekly limit) or extra usage. A 429's own headers decide whether exhaustion is confirmed before any re-poll.
- **Insula:** in vault mode, quota comes from Insula first. A reading Insula marks as failed upstream is used as-is, without re-polling the endpoint that is refusing.
- **Ultra:** a successful reading with a weekly window but no 5-hour window means the account has no 5-hour limit.
- **Writes:** quota is written through common-auth's coalescing pool writer, fenced by account and credential epoch. Stored formats stay readable by the last published release, so a rollback never disables an account.

## Prompt cache

- **Strategy:** set per account (`cache1h.ts`): explicit breakpoints, automatic, or hybrid. Hybrid keeps a stable system anchor. When the last two user or tool-result boundaries are more than 20 content blocks apart, it moves that marker to a bridge anchor on the earlier boundary, so the latest marker's 20-block lookback still reaches a cache entry. A full request after accepted thread continuations may use that slot for the previous full request's cache boundary, as described below. Markers that reconnect caches when a session switches between Fable and Opus take priority.
- **Keep-warm:** `CacheKeepManager` (`cachekeep.ts`) tracks up to 32 sessions, within a 64 MiB body budget, once Anthropic has accepted their request.
  - **Timing:** it sends the prewarm 5 minutes before expiry, on the account that served the session. Transient failures retry at about 20, 40 and 60 seconds until the cache would expire. A refusal a retry cannot fix (killswitch floor, account disabled or signed out, changed login, vault refusal) stops warming that session with one warning.
  - **Restarts:** OpenCode 2 and Pi save the latest accepted body per session, gzipped and owner-only, under `cortexkit/anthropic-auth/cachekeep-restore/` in the data folder. A restarted host warms again from there.
  - **Session list:** each process publishes session ids and cache timing, never bodies or tokens, to `cortexkit/anthropic-auth/cachekeep-sessions/` (documented in `docs/cachekeep-registry.md`).
- **Per-session policy (Thalamus):** `session-cache-policy.ts` reads a session's `{ttl, keep_warm, hours}` through common-auth's `sessionCachePolicy`, synchronously, on every OAuth request and before every warm. No policy, or an invalid one, leaves the plugin's own settings in charge, field by field.
  - **Lifetime:** `none` strips every cache marker from the final body (after Pi's `onPayload`), and `short` and `long` set 5-minute or 1-hour markers. The applied lifetime is read from the body actually sent.
  - **Keep-warm modes:** `off`, `hours`, `always` and `auto` are decided by common-auth's pure `decideCacheKeep`. `hours` and `always` stop after 24 warm attempts without a real request (`count-cap`), and this also applies to the local "always" setting and to Opus 4.8 source warms. `auto` stops before the summed warm reads would cost as much as one rewrite at the applied lifetime.
  - **Durability:** each attempt's count and admitted cost are written owner-only before the warm is sent, so a restart cannot reset the cap. An unusable restart folder keeps every bound in memory instead.
  - **Reports:** an accepted response or a successful warm sends a detached `cache_touch` with the applied lifetime, and a warmed session's retirement sends `cache_warm_stopped` with a shared reason. Neither can delay a request. Opus 4.8 source warms send no touch, because the runner tracks one cache per session.
- **Activity:** `session-cache-activity.ts` records when each session's cache was last refreshed by an accepted response or a successful prewarm. The sticky hold rule uses it.
- **Prime:** an opt-in five-hour window starter. On OpenCode 1, OpenCode 2 and Pi it sends one `max_tokens: 1` Haiku request per account when the window's reset has passed. A marker keyed by the verified Claude account makes sure only one process fires per reset, even across separate account files and hosts.

## Message threads

`message-threads.ts` is shared by all three hosts and runs on the final wire body. A request continues the thread only when all of these hold:

- it has an anchor from the previous accepted response, on the same account and credential, less than 5 minutes old. The credential is the stable row, not the token: the vault credential id, or the local account row and its login epoch, so a routine token refresh keeps the thread;
- every fixed field is identical: model, thinking, effort, tool choice, context management, fallbacks, betas, system and tools. On supported cache layouts, Core first restores the accepted create's system/tool cache annotations, preserving wire key order; normal per-request billing fields are excluded from the comparison;
- every earlier message matches its canonical thread-history hash, ignoring protocol `cache_control` annotations;
- exactly one new assistant reply matches the reply fingerprint the stream recorded.

Anything else sends a full `create` request. Title, summary, compaction, keep-warm, Prime and WebSocket relay requests stay stateless. Each full request inside a session logs one debug line with a fixed reason code (for example `reply_changed` or `identity_changed`) and no content.

**Full-after-thread cache boundary:** after at least one continuation has been accepted since the last full request, a new full request may reuse that full request's last message marker, including one nested inside a tool result. Core retains only the marker's position, lifetime, accepted time and hashes of its prefix and account/credential identity. The prefix, beta list and speed must still match, and the entry must not have expired. The marker replaces OpenCode's ordinary system/lookback marker or Pi's system marker, never exceeding four markers. It cannot replace an Opus standby bridge (anchoring the cache kept ready for an Opus recovery turn) or a Fable return marker (anchoring the Fable prefix when returning from Opus). If no slot is offered, Core skips the prefix hash and body clone. Every failed condition leaves the ordinary full body untouched and logs one content-free tail reason such as `prefix_changed`, `slot_taken` or `layout_unrecordable`. A create directly after a create, and a session that has only sent stateless requests, never gets this extra boundary.

**Wire safety:** 1-hour markers must precede every 5-minute marker. Core checks the final continuation after restoring fixed fields and budgeting message markers; invalid order falls back to the untouched full request rather than repairing the accepted fixed fields. Every accepted create records the fingerprint and last message marker from the body actually sent. Fixed annotation layouts must be recordable before a tail marker can replace another marker.

**Recovery:** if Anthropic rejects a continue, the plugin resends once with the full conversation as a new thread. If that create is rejected for using threads, it resends once more statelessly and turns threads off for that account until restart. Removing the thread beta for that last retry changes the cache-prefix identity, so the retry keeps the ordinary full body's cache markers. A thread problem never reaches the user as an error when a stateless send would work.

## Content-filter fallback

- **Opt-in:** OAuth Fable 5, Fable 5.1, Opus 5 and Opus 5.5 requests opt into server-side fallback on OpenCode 1 and 2.
- **Boundary marker:** OpenCode cannot store Anthropic's `fallback` block, so the stream turns it into a signed hidden thinking marker (`cortexkit-server-fallback-v1:`). The next request turns it back into the exact `fallback` block before signing.
- **Usage marker:** a fallback step's usage is the billed sum of both attempts. A second hidden marker (`cortexkit-server-fallback-usage-v1:`) carries the per-attempt breakdown for tools that size the context. It is stripped from every outgoing request.
- **Tool call before a refusal:** if a served fallback completes a tool call and then refuses, the finish becomes `tool_use`, so the tool doesn't run twice.
- **Recovery rounds (OpenCode 1 only):** a refusal the server fallback did not absorb starts a recovery round on Opus 4.8. During the round, keep-warm also keeps the original model's cache alive from its last sent body, so returning to it doesn't rebuild the prompt. `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy` skips server fallback and uses recovery rounds only.

## State layout

OpenCode 2 watches its config folder, so machine-written state should move out of it, into the user's state folder.

- **Release N (shipped in 2.4.0):** every process registers itself in `anthropic-auth-holders.json` beside the account files, and the relocation guards run inside the locks a move must hold.
- **The mover and restore:** both are written (`state-layout-move.ts`, `state-layout-restore.ts`), but `RELOCATION_MOVE_ENABLED` is `false`. Until that switch flips in its own release, every install keeps the legacy layout, and no code path may refuse an install that 2.4.x serves.
- **Storage id:** it is always derived from the legacy-layout path, so a move never changes it.

## Concurrency rules

- **Requests never wait on bookkeeping.** Quota, lastUsed, metadata, sidebar and keep-warm writes are detached. A request proceeds, or refuses only for a real reason (custody, auth, quota policy).
- **Locks:** cross-process writes use common-auth file locks. On Linux and macOS a lock file is published atomically with its owner record. A served response never holds the vault roster lock while waiting on another lock. Locks that guard credential refresh or custody change only with OAIAUTH's approval.
- **Shutdown:** disposal drains bookkeeping, cancels lock waits still pending after a one-second grace, and closes vault connections. Work on a runtime shared with other plugin instances is cancelled only when that shared runtime itself closes.

## Failure handling

- **Parse failures:** request bodies that can't be parsed pass through unchanged. Structural history errors and effort-plan mismatches refuse locally with a non-retryable 400, before cache shaping, signing, dumping or sending.
- **Stream errors:** a transient `api_error` inside a 200 SSE stream becomes a connection-reset error, so the host retries it instead of storing it.
- **Redaction:** logs, dumps, sidebar state, RPC and menus never carry tokens, raw provider bodies or prompt text. Errors use fixed messages and closed codes. Dumps (`OPENCODE_ANTHROPIC_AUTH_DUMP_DIR`, default `opencode-anthropic-auth-dumps` in the temp folder) keep only an allowlisted response summary.
- **Logging:** the log goes to `opencode-anthropic-auth.log` in the temp folder, or to `OPENCODE_ANTHROPIC_AUTH_LOG_FILE`.

## Testing and gates

- `scripts/gate.sh fast` runs CI's fast checks (lockfile, layout, format, lint, types, wire vectors, build). It is required before every push and worker delivery.
- CI runs the Core, Pi and four OpenCode unit groups, the Miniflare relay tests, end-to-end tests against real OpenCode hosts, and a packed-install check on three Windows machines.
- Releases are tag-driven, publish with npm provenance, and need the user's approval.
- Test preloads point every account, sidebar, cache, RPC, dump and vault path at a disposable sandbox. Tests never touch live state.
