# CortexKit Anthropic Auth

This repo is a CortexKit-maintained Anthropic auth monorepo for OpenCode and Pi. The OpenCode package is a fork of the original `@ex-machina/opencode-anthropic-auth` plugin, so older entries below the initial CortexKit release are inherited from upstream package history.

## Unreleased

- Deliver OpenCode Desktop recovery notices without triggering an extra billed provider turn on OpenCode 1.18 and newer.

## 1.19.1

### Patch Changes

- Keep deterministic Opus 4.8 recovery armed as a backstop when Anthropic's server-side safety policy still returns a refusal, while stripping the server-fallback opt-in from source-model prewarms.
- Preserve completed tool calls when a served fallback later refuses, continuing with the existing tool result instead of replaying potentially non-idempotent tools.
- Return an explicit authentication or quota response when sticky-balanced routing has no eligible account in OpenCode or Pi instead of falling through to an excluded main account.
- Clear a permanent, token-bound `invalid_grant` state immediately after the main OpenCode account is re-authenticated, while retaining shared transient and rate-limit backoffs.
- Keep TUI preferences live updates working when Bun cannot create a directory watcher (for example, `EBADF`) by running the polling fallback independently, and capture the baseline before returning so an immediate first update cannot be absorbed.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the server-fallback recovery contribution.

## 1.19.0

### Minor Changes

- Default eligible OpenCode Fable 5 and Opus 5 OAuth requests to Anthropic's server-side safety fallback, preserve fallback conversation boundaries across stored history, and report active/restored model transitions in the TUI sidebar and OpenCode Desktop.
- Keep the previous deterministic 10-response Opus 4.8 recovery available through `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy`, including source-model cache prewarming and standby cache bridges.

### Patch Changes

- Reconcile Desktop fallback notices against live OpenCode session status when a delayed cache warm completes after the normal completion/idle events.
- Strip trailing whitespace-only text blocks after the latest assistant tool call before Anthropic replay, preventing valid tool-result continuations from being rejected as unsupported assistant prefills.

## 1.18.0

### Minor Changes

- Add Claude Opus 5 request shaping to OpenCode and Pi's converter, including summarized adaptive thinking, effort-based reasoning, explicit disabled-thinking handling, and OpenCode fast mode.
- Extend OpenCode content-filter recovery to Opus 5: temporarily downgrade refused requests to Opus 4.8 for 10 successful responses while preserving the selected model, prewarming the original Opus 5 cache, and reporting model-specific recovery transitions.

### Patch Changes

- Publish native OpenCode Opus 5 `low`, `medium`, `high`, `xhigh`, and `max` effort variants instead of inherited manual-thinking budgets.
- Isolate Fable 5 and Opus 5 recovery state, cache warm chains, OAuth account binding, and standby anchors by session and source-model family.
- Treat Darwin/Bun `EINVAL` during a contended eviction-marker create as a lost lock race, preventing high-contention refresh-lock failures.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the Opus 5 contribution.

## 1.17.0

### Minor Changes

- Refresh OAuth 5h and 7d quota from genuine `anthropic-ratelimit-unified-*` response headers across direct, HTTP relay, and WebSocket relay transports while preserving poll-owned model-scoped quota data.
- Show account plan/tier metadata, the binding quota window, extra-usage credit status, and Anthropic fallback hints in expanded OpenCode quota and account surfaces.

### Patch Changes

- Prevent startup, quota-refresh, metadata, and command writes from overwriting another process's active sidebar route by preserving routing-authoritative fields behind cross-process locked and fenced state writes.
- Token-fence asynchronous account-profile persistence so delayed profile fetches or clears cannot restore stale credentials or remove a newer profile.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the quota surfaces, relay harvesting, and sidebar-state contributions.

## 1.16.0

### Minor Changes

- Add `sticky-balanced` routing for OpenCode and Pi, assigning cold sessions by current quota headroom while preserving account affinity across processes, restarts, transient failures, short reset holds, model-scoped limits, and Fable recovery.
- Add `/claude-cachekeep always` and aggregate live tracked-session status across OpenCode project plugin instances and Pi processes without sharing request bodies, credentials, or headers.

### Patch Changes

- Prevent concurrent fallback-account additions and configuration saves from dropping accounts by serializing cross-process writes, merging current disk state, and using explicit removal semantics.
- Preserve fresh empty model-scoped quota snapshots and evaluate scoped quota freshness independently during sticky routing.
- Bound request-dump storage to 512 MB by default and harden end-to-end process and temporary-directory cleanup.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the dump-storage and end-to-end cleanup contribution.

## 1.15.1

### Patch Changes

- Show Fable recovery transition notices immediately during active multi-step OpenCode Desktop runs while preserving the selected session model and preventing additional provider turns.
- Restore live OpenCode TUI sidebar updates on current OpenTUI hosts by shipping a precompiled reactive Solid tree, with packed-package smoke coverage in CI and release gates.

Thanks to [@tomolom](https://github.com/tomolom) for reporting the TUI packaging issue.

## 1.15.0

### Minor Changes

- Add automatic OpenCode recovery for Fable content-filter refusals: transparently route the session through Opus 4.8 for a 10-response recovery window, prewarm Fable after each successful Opus response, and return to Fable without changing the selected session model.
- Preserve both model caches during recovery by warming Fable with the OAuth account that served the refused request and retaining an Opus standby cache bridge when healthy Fable turns move the previous Opus boundary outside Anthropic's 20-block lookback.
- Show session-specific recovery status in the OpenCode TUI sidebar and send safe transition notices in OpenCode Desktop without spending quota or creating an extra provider response.

## 1.14.0

### Minor Changes

- Expose Claude Sonnet 5 in the Pi Anthropic provider catalog, completing its existing adaptive-thinking request support.

### Patch Changes

- Preserve empty model-scoped quota arrays through account-state loading, runtime-state merges, and sidebar normalization so a fresh quota response can clear a previously stored scoped window.
- Omit unavailable 5h/7d placeholders from collapsed quota summaries when only a scoped model window is present.
- Update OpenTUI Solid, OpenCode SDK, Biome, and generated project documentation.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the scoped-quota persistence fixes and [@nodnarbnitram](https://github.com/nodnarbnitram) for the Pi Sonnet 5 catalog contribution.

## 1.13.0

### Minor Changes

- Add model-scoped OAuth quota support for Anthropic weekly scoped limits such as Fable, including sidebar/quota-summary display, model-aware OAuth fallback routing, and Pi parity. Fable scoped exhaustion can route Fable requests to an OAuth fallback while other models continue using the main account.
- Add per-model scoped killswitch thresholds so matching scoped quota windows can hard-block an account without poisoning routing for other models.

### Patch Changes

- Fix same-label fallback OAuth re-login state merging so fresh credentials clear stale reauth/quota errors and invalidate old quota cache entries.
- Keep CacheKeep tracking on OAuth fallback routes and prewarm with the same OAuth account that served the cached request.
- Shorten the Fable scoped quota sidebar label to `Fa` and preserve scoped killswitch thresholds in the OpenCode TUI edit modal.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the scoped killswitch contribution.

## 1.12.2

### Patch Changes

- Update OpenCode, Pi, Biome, and Miniflare dependencies.

## 1.12.1

### Patch Changes

- Request visible summarized adaptive thinking for Claude Sonnet 5 in OpenCode and Pi, while preserving explicit disabled-thinking requests on OpenCode's raw Anthropic body path.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the Sonnet 5 adaptive-thinking fix.

## 1.12.0

### Minor Changes

- Handle Anthropic auth slash commands with an Effect-compatible `204 No Content` response shape, matching OpenCode's current command-interception path while keeping the legacy sentinel fallback for older hosts.

## 1.11.0

### Minor Changes

- Add interactive account-management and logging flows for OpenCode and Pi, including fallback account list/enable/disable/reorder/remove actions, API-key route setup, OAuth fallback login helpers, and persisted log-level settings.
- Add shared leveled redacting rotating logging, CacheKeep per-warm cost logging, and an opt-in CacheKeep subagent toggle.

### Patch Changes

- Harden account storage and refresh coordination with serialized account-store updates, stale-lock re-election fixes, safer atomic writes, malformed sidebar-state guards, RPC multi-session isolation, and runtime-state loading when the editable config file is absent.
- Improve account cleanup and re-login UX by clearing removed fallback runtime state, showing dead fallback accounts that need re-login, and preserving clearer OAuth account labels.
- Treat Claude quota endpoint `403` responses as account/org-policy auth failures without arming quota backoff or OAuth refresh backoff.
- Update OpenCode, OpenTUI, Pi, Miniflare, Biome, GitHub Actions, and related development dependencies.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the account/logging parity work and account-management fixes, [@jonmast](https://github.com/jonmast) for the runtime-state load fix, and [@eddieparc](https://github.com/eddieparc) for reporting and proposing the quota `403` backoff boundary fix.

## 1.10.3

### Patch Changes

- Keep OpenCode `fallback-first` routing on usable fallback accounts when another process is already refreshing fallback quota, preventing a broken primary OAuth refresh backoff from aborting requests while fallback quota is still passing.
- Keep the OpenCode TUI preferences watcher stable even when unrelated tests or integrations temporarily override global timers.
- Update Biome to 2.5.0.

## 1.10.2

### Patch Changes

- Fix OpenCode `ReadableStream is locked` failures after detecting Anthropic streaming rate-limit errors when no fallback route can serve the request, returning a replayable inspected response instead of reusing the consumed stream.

## 1.10.1

### Patch Changes

- Stabilize `/claude-cache hybrid` system cache anchors when OpenCode leaves plugin-added system instructions split across multiple blocks, preserving the canonical merged tail before placing the Anthropic cache breakpoint.

## 1.10.0

### Minor Changes

- Add interactive OpenCode TUI command dialogs for Anthropic auth commands, backed by a localhost-only authenticated RPC bridge so sidebar actions can configure routing, cache, quota, relay, and related settings without text-only command replies.

### Patch Changes

- Mark transient Anthropic SSE server errors inside HTTP 200 streams as retryable connection-reset-style failures so OpenCode can use its normal auto-retry flow instead of surfacing them as non-retryable unknown errors.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the interactive TUI command modal contribution.

## 1.9.4

### Patch Changes

- Align Claude OAuth request fingerprints with captured Claude Code 2.1.177 interactive CLI traffic, including the CLI identity string, user agent, billing `cc_entrypoint=cli`, and beta header ordering.
- Remove unavailable `context-1m` and `effort` betas from Claude Code OAuth requests, add the captured thinking token count beta, and keep redacted thinking disabled by design.
- Match captured OAuth login/refresh details more closely with the updated axios-style user agent, accept header, refresh scope, and Claude Max authorize URL.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the Claude Code MITM capture and fingerprint alignment.

## 1.9.3

### Patch Changes

- Keep OpenCode sidebar quota display stable during concurrent quota refreshes by re-seeding from the latest runtime state and avoiding stale quota writes from older plugin instances.
- Dump direct Anthropic requests when `/claude-dump on` is enabled, including redacted request metadata for OpenCode and Pi direct/API paths. Relay requests continue to include relay metadata.
- Harden Pi SSE reader cleanup so preflight parsing cannot cancel the response stream on early abandon.
- Strip OpenAI encrypted reasoning payloads, including Pi JSON-stringified `encrypted_content` payloads, before converting history to Anthropic `thinking` blocks.
- Repair Pi replay after interrupted tool calls by dropping incomplete aborted assistant `tool_use` turns and orphan tool results before sending Anthropic history.
- Add configurable OpenCode TUI preferences via `tui-preferences.jsonc`, persisted sidebar collapse state, shared `forceToTop` ordering helpers, and quota pacing/runout projections in the sidebar.
- Update OpenCode, Pi, OpenTUI, Miniflare, and related development dependencies.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the TUI preferences and quota pacing contributions.

## 1.9.2

### Patch Changes

- Fix `/claude-cache hybrid` anchors for Magic Context requests where stable project context and session history are merged into `messages[0]`, preserving cache breakpoints on the first two prefix blocks instead of the volatile tail.

## 1.9.1

### Patch Changes

- Request summarized adaptive thinking for Claude Fable 5 and Mythos 5 so agents can display readable reasoning summaries instead of blank signed-thinking blocks.
- Add opt-in structural SSE diagnostics under `OPENCODE_ANTHROPIC_AUTH_PERF=1`, counting Anthropic event, block, and delta types without logging response text or tool input content.

## 1.9.0

### Minor Changes

- Add an OpenCode `costZeroing.enabled` opt-out so advanced users can show Anthropic model pricing for OAuth sessions instead of the default zero-cost subscription/quota display.

### Patch Changes

- Fix synthetic Claude Fable 5 and Mythos 5 OpenCode catalog entries so `model.api.id` matches the selected model, ensuring the wire request sends Fable/Mythos rather than the cloned Opus fallback model.
- Coalesce WebSocket relay upstream SSE chunks before binary WebSocket sends, reducing tiny frame fragmentation while preserving response bytes exactly.
- Memoize repeated system-prompt sanitation work with a bounded byte-aware cache.

## 1.8.0

### Minor Changes

- Add Claude Fable 5 and limited-access Claude Mythos 5 support across shared model metadata, OpenCode's Anthropic provider catalog, Pi's provider catalog, and the cache-usage analyzer.
- Add API-key fallback routes for Anthropic-compatible providers such as Kie, with route secrets stored in runtime state and API-key spending gated behind fresh, token-bound confirmation that main OAuth quota is exhausted.
- Split editable sidecar config from volatile auth runtime state so background refresh, quota, and routing writers cannot overwrite user configuration such as quota intervals or relay settings.

### Patch Changes

- Normalize Fable/Mythos OpenCode requests by removing top-level adaptive `thinking` and preserving `output_config.effort`, matching Anthropic's migration guidance.
- Show both 5-hour and 7-day quota windows in the collapsed OpenCode sidebar active-account summary.
- Display Anthropic OAuth models as zero-cost in OpenCode through the provider model hook while preserving token accounting and API-key model pricing.
- Bound relay/cachekeep/identity in-memory caches, propagate relay abort signals, improve Pi stream cancellation, and document intentional relay tradeoffs in `AUDITOR.md`.
- Add opt-in performance instrumentation for Anthropic request rewriting, relay payloads, and downstream stream consumption under `OPENCODE_ANTHROPIC_AUTH_PERF=1`.

## 1.7.0

### Minor Changes

- Improve `/claude-cache hybrid` for Magic Context sessions whose stable `m[0]` and volatile `m[1]` history blocks are merged into one Anthropic user message: hybrid mode now anchors both the first and last cacheable block of `messages[0]` so stable leading history can remain cached when the trailing delta changes.
- Include a sanitized session/affinity segment in `/claude-dump` artifact filenames so dumps from different sessions are easier to find.

### Patch Changes

- Refresh current-token main quota in the OpenCode sidebar without blocking `fallback-first` routing, avoiding a stale `checking…` display after main token rotation.
- Keep custom/future Claude billing version suffixes stable across date boundaries so the billing header does not rotate at midnight and unexpectedly bust prompt-cache prefixes.

## 1.6.1

### Patch Changes

- Mark WebSocket relay stream-close failures as retryable connection resets so OpenCode can use its normal retry UI instead of treating mid-stream relay disconnects as terminal unknown errors.

## 1.6.0

### Minor Changes

- Add `/claude-killswitch` for OpenCode, allowing requests to be hard-blocked or rerouted when main or fallback Claude quota drops below configured per-account thresholds.
- Add a collapsible OpenCode quota sidebar view and opt-in quota refresh toasts controlled by `quota.showToasts`.

### Patch Changes

- Improve WebSocket relay recovery when a socket closes after upstream `response_start` but before any stream bytes reach OpenCode, and add clearer close diagnostics for mid-stream failures.
- Harden Pi Anthropic message conversion for tool-result and content-shape edge cases.
- Fix OpenCode sidebar quota refreshes so async quota updates do not clobber the active account or show stale fallback quota state.
- Update OpenCode SDK/plugin, OpenTUI, and relay test dependencies.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the killswitch, quota toast, sidebar, and Pi conversion contributions.

## 1.5.0

### Minor Changes

- Add an OpenCode TUI sidebar for Claude quota, active route, relay transport, and cache status.
- Add a shared quota manager with persisted quota caching, quota API backoff, token-bound fallback quota state, and request-count-based quota refreshes.

### Patch Changes

- Strip trailing assistant messages from Anthropic request bodies to avoid Claude OAuth prefill `400` errors when a conversation does not end with a user message.
- Avoid placing `cache_control` on message objects in hybrid cache mode when the selected message has no cacheable content block.
- Invalidate fallback quota cache and quota backoff when a same-label fallback account is re-logged with a new token.
- Fix OpenCode TUI package loading by exporting the source TUI entrypoint and including required sidebar state files in the package.
- Fix TUI sidebar state so it uses token-bound quota reads and reflects the actual active route.
- Canonicalize dropped AFT tool namespaces in Anthropic responses, so `safety`/`mcp_Safety` and other known AFT suffixes are mapped back to `aft_*` tool names.
- Reload relay config from the sidecar on each request so long-running OpenCode processes stop using stale HTTP/WebSocket settings.
- Reduce fallback OAuth refresh backoff log noise and improve WebSocket relay fallback diagnostics.
- Fix root `bun test` and CI workflow test commands.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the quota manager and TUI sidebar contributions.

## 1.4.1

### Patch Changes

- Clarify the `<use_parallel_tool_calls>` guidance so agents parallelize only independent tool calls and never invent placeholder task IDs or other values for calls that depend on earlier tool results.

## 1.4.0

### Minor Changes

- Add Claude Opus 4.8 support across fast mode, the Pi model catalog, documentation, and cache-usage price estimates.
- Improve `/claude-cache hybrid` anchor placement for long tool-heavy sessions by moving the rolling anchor to the latest user/tool-result boundary and adding a bridge anchor when Anthropic's 20-block cache lookback would otherwise miss the prior tail anchor.
- Add Anthropic's `<use_parallel_tool_calls>` system prompt guidance for OpenCode Anthropic chat sessions only, encouraging independent read-only tool calls to be issued in parallel without modifying non-Anthropic model prompts.

### Patch Changes

- Renew main and fallback OAuth refresh file locks while a refresh is in flight, preventing another OpenCode process from reusing a rotating refresh token if Anthropic's OAuth endpoint is slow to respond.
- Sign only the controlled billing-header CCH placeholder so historical `cch=...;` text in prior messages cannot receive the per-request signature and break prompt-cache stability.
- Update development and integration dependencies, including OpenCode/Pi SDK packages, Biome, Miniflare, and release workflow pins.

## 1.3.0

### Minor Changes

- Add `/claude-routing` with persisted `routing.mode` so OpenCode and Pi can switch between the default `main-first` routing and `fallback-first` routing without restarting.
- In `fallback-first` mode, usable sidecar fallback accounts are tried before the main account; if no fallback succeeds, the request falls back to the main account.

## 1.2.5

### Patch Changes

- Reuse cached fallback-account quota snapshots when transient quota probes are rate limited, so an account with known remaining quota can still be tried instead of falling back to an exhausted main account.
- Reuse fresh fallback-account quota snapshots during explicit quota checks and clear stale quota errors so transient quota-probe `429`s do not hide otherwise usable fallback account state.

## 1.2.4

### Patch Changes

- Serialize fallback-account OAuth refreshes across OpenCode processes so concurrent refresh attempts cannot reuse and invalidate a rotating refresh token.

## 1.2.3

### Patch Changes

- Align Claude OAuth token refresh with the live-tested PR #40 request shape: `https://platform.claude.com/v1/oauth/token`, JSON payloads, and an `axios/1.13.6` User-Agent.
- Honor OAuth `Retry-After` responses and skip request-path refresh attempts while main-account backoff is active, reducing repeated refresh failures during Anthropic rate limits.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the OAuth refresh fixes in this release.

## 1.2.2

### Patch Changes

- Add jitter to OpenCode and fallback-account background OAuth refresh timers so concurrent OpenCode processes do not all refresh at the same due timestamp.
- Harden the cross-process main OAuth refresh lock so a process cannot steal a lock while another process is still initializing it, preventing duplicate refresh requests that can consume a rotated refresh token and leave the loser with `invalid_grant`.
- When a main OAuth refresh is already in progress, wait briefly and re-read OpenCode auth so followers can join the successful token rotation instead of failing immediately.

## 1.2.1

### Patch Changes

- Refresh Claude OAuth tokens through `https://api.anthropic.com/v1/oauth/token`, matching the live-smoke-tested CLIProxyAPI JSON refresh path, after `platform.claude.com` repeatedly returned OAuth `429` during proactive refresh.

## 1.2.0

### Minor Changes

- Bundle the OpenCode plugin runtime with Bun so published installs no longer depend on workspace-local source layout.
- Move Pi integration dependencies and imports from the old `@mariozechner/*` namespace to `@earendil-works/*`, including `@earendil-works/pi-tui`.

### Patch Changes

- Retry transient Claude OAuth refresh failures in the shared helper while keeping the OpenCode main-account refresh path single-sourced through its existing retry, backoff, and cross-process lock.
- Harden Pi message conversion for empty base64 images, error `tool_result` parts, and tool IDs.
- Reduce redundant account-storage reads in fallback routing and quota selection paths.
- Harden relay optimistic-stream error handling and Worker request handling, including deferred KV state writes and a health response.
- Update development dependencies and release workflow actions; release CI now also runs the OpenCode e2e harness before publishing.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for the batch of Pi, fallback, relay, and packaging improvements that went into this release.

## 1.1.3

### Patch Changes

- Refresh Claude OAuth tokens earlier by treating `refresh.refreshBeforeExpiryMinutes` as a minimum 4-hour window, preventing transient OAuth `429` backoff from pushing retries past token expiry.
- Serialize main OpenCode OAuth refresh across concurrently running OpenCode processes with an atomic filesystem lock, avoiding multi-session refresh races against Anthropic's OAuth endpoint.

## 1.1.2

### Patch Changes

- Added `/claude-cachekeep` for hybrid Claude cache mode. It keeps in-memory clones of recently used rewritten requests and sends prewarm-safe `max_tokens: 0` calls during the configured local time window.
- Fixed OAuth refresh backoff after re-login by resetting retry severity when the refresh token rotates.
- Reduced hidden slash-command reply overhead by bounding OpenCode prompt-context lookup to the most recent 100 messages instead of hydrating the full session.

## 1.0.0

### Major Changes

- Initial CortexKit release under `@cortexkit/opencode-anthropic-auth`, including multi-account fallback, quota-aware routing, Claude cache controls, Anthropic fast mode toggling, final-body billing signing, and the optional user-owned Cloudflare relay.

## 1.7.4

### Patch Changes

- [#96](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/96) [`d3d4823`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d3d4823c93e88cd0db125865bedf6d3049bf1134) Thanks [@eliasstepanik](https://github.com/eliasstepanik)! - Re-read auth before token refresh to avoid using a stale refresh token snapshot when token rotation occurs between requests.

## 1.7.3

### Patch Changes

- [#110](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/110) [`2352c87`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2352c875bdbbb740b9faecd0345c2af88b993e58) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Downgrade bun to 1.3.11 to work around a macOS code-signing issue in 1.3.12 that prevents dev-mode testing.

## 1.7.2

### Patch Changes

- [#106](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/106) [`31b3b99`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/31b3b991be07dbc27734bc8326e3d8fe0d3626ac) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Bump bun to 1.3.12, ensure we use mise in CI, and lock engines for dev

## 1.7.1

### Patch Changes

- [#94](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/94) [`522c18d`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/522c18d7193d2a99d28e2664b0ba2b10faf80a4c) Thanks [@colus001](https://github.com/colus001)! - Fix `Cannot find module '.../dist/auth'` error when opencode loads the plugin as strict ESM.

## 1.7.0

### Minor Changes

- [#91](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/91) [`550c408`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/550c408e22f29ee83fe9c707318e8759510ff0eb) Thanks [@bogdan-manole](https://github.com/bogdan-manole)! - fixing the StructuredOutput issue introduced in v1.5.1

## 1.6.1

### Patch Changes

- [#88](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/88) [`a90185a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/a90185afc77f8200d3a2187b244610eef7375371) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove system block to user message relocation, remove experimental FF, and align system blocks to match Anthropic

- [#87](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/87) [`e3e1be4`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/e3e1be4aace9d34bda53a99d43b9c72afbf6d6a4) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove OpenCode identity more accurately

## 1.6.0

### Minor Changes

- [#81](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/81) [`0906d28`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/0906d288b85511abcba358ccdec04ae2929792ae) Thanks [@INONONO66](https://github.com/INONONO66)! - PascalCase tool names after mcp\_ prefix to match Claude Code convention

## 1.5.1

### Patch Changes

- [#76](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/76) [`d92609c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d92609c2c8168f9b80616f0269381126a02fe7c8) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in `EXPERIMENTAL_KEEP_SYSTEM_PROMPT` which allows users to
  keep the sanitized prompt as a system prompt, instead of changing
  it to a user propmt.

## 1.5.0

### Minor Changes

- [#74](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/74) [`53b62bb`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/53b62bb1fc18fff29fccbfa0ef190d5082cc247d) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in Claude billing header with content consistency hashing from decompiled binary

## 1.4.1

### Patch Changes

- [#70](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/70) [`91601b8`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/91601b81616b5013517d316c82beb5c3d6303022) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @opencode-ai/plugin from 1.3.13 to 1.4.3

- [#71](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/71) [`ce3f9fc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/ce3f9fc0f96c943c5ec3b906e4285bedababae2e) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump lefthook from 2.1.4 to 2.1.5

- [#69](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/69) [`2d9b5bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2d9b5bce197464504c2957b7943344291e559f4b) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @biomejs/biome from 2.4.10 to 2.4.11

## 1.4.0

### Minor Changes

- [#63](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/63) [`69f4754`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/69f4754b7b59ed6632e5d0db30f92ccc3d3beb39) Thanks [@eXamadeus](https://github.com/eXamadeus)! - To bypass Anthropic's scans of the system prompts, move all but the identity marker into a user message

### Patch Changes

- [#61](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/61) [`8dca525`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/8dca5253cedbce8bc1d1283368370044ff933321) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor change to identity anchor

## 1.3.0

### Minor Changes

- [#59](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/59) [`d520d0c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d520d0ceb27bcab25c36a85925b71212d2721f24) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minimize prompt sanitization reach with anchor-based paragraph removal, preserving behavioral guidance that was previously stripped.

## 1.2.0

### Minor Changes

- [#52](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/52) [`19ea91a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/19ea91abdfa04506fccf6c24cce1dabccb82f98a) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add system prompt sanitization for Max subscription compatibility. Moves system prompt handling from the plugin hook into the request body layer, surgically removing the OpenCode identity section and prepending Claude Code identity. Preserves user-configured instructions from config.json.

## 1.1.2

### Patch Changes

- [#49](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/49) [`3ad9267`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/3ad92670bcc77adb45eab51efeab7ffcc7537822) Thanks [@PaoloC68](https://github.com/PaoloC68)! - Surface token refresh error body for easier diagnosis; add prepare script for github installs

## 1.1.1

### Patch Changes

- [#47](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/47) [`c0fbbcf`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/c0fbbcf6cdcf6c2879604e0b8e609cbdf8fddead) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor bump to update README in npm with security suggestion

## 1.1.0

### Minor Changes

- [#42](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/42) [`feec332`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/feec3328afd0c9fcc5b708f5d2b11337e6844242) Thanks [@Thesam1798](https://github.com/Thesam1798)! - feat: support ANTHROPIC_BASE_URL env var for custom API endpoint

## 1.0.4

### Patch Changes

- [#39](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/39) [`32240f1`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/32240f1e82e2ec711e9699a4efecb754e192c3af) Thanks [@Thesam1798](https://github.com/Thesam1798)! - ci: harden workflows for fork safety and concurrency

- [#41](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/41) [`386e716`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/386e71681d00c858e0d0fe958a06f3ee3fab10e3) Thanks [@Thesam1798](https://github.com/Thesam1798)! - fix: deduplicate concurrent OAuth token refreshes

## 1.0.3

### Patch Changes

- [#37](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/37) [`97729bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/97729bc8140f9931512958bda2de6950a4ce4636) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Update copyright year in LICENSE file

## 1.0.2

### Patch Changes

- [#31](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/31) [`2ff263f`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2ff263f9d8c43ed009582697a45f4dfbf6de4e0b) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in changesets for changeset management and fix type checking

- [#33](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/33) [`4523f1b`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/4523f1beba4f6c2669a04e67a47be8d365d0d30f) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Make sure changeset PRs are run by bot user for CI to trigger

- [#34](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/34) [`9c7a9e2`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/9c7a9e217a0c6be0f419bf129dad48c033120da5) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Ensure CI is triggered per release
