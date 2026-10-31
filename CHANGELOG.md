# CortexKit Anthropic Auth

This repo is a CortexKit-maintained Anthropic auth monorepo for OpenCode and Pi. The OpenCode package is a fork of the original `@ex-machina/opencode-anthropic-auth` plugin, so older entries below the initial CortexKit release are inherited from upstream package history.

## Unreleased

- Under the CortexKit agent runner, a used-up model limit is reported to shared routing with its pool name in routing's lowercase form (for example `fable`), and a model limit whose name routing cannot accept is not reported at all, so it is never mistaken for the whole account's weekly limit.
## 2.4.9

- `@cortexkit/common-auth` 0.33.0.
- Under the CortexKit agent runner, a used-up limit is now reported to shared routing as the five-hour or weekly window, with the model's own limit named as a pool (for example Fable), matching the other auth plugins.

## 2.4.8

- The Claude sidebar now uses the same layout as the other CortexKit auth plugins. A usage window with no reading yet is no longer shown as `7d —`, and the credit line now sits below the "checked … ago" line.
- `@cortexkit/common-auth` 0.32.1. A vault account whose quota reading insula could not refresh because Anthropic refused it is no longer polled again by the plugin, which only extended the refusal.

## 2.4.7

- Verified Ultra accounts, which no longer have a five-hour limit, are no longer refused as having unknown quota. Their weekly and Fable limits still apply. Addresses #572.
- In vault mode, a request refused because your own quota floors or killswitch limits exclude every account now says which limit blocked it and where to change it, instead of asking you to sign in again. Addresses #567.

## 2.4.6

- After a 429 whose rate-limit headers already show the limit used up, the plugin no longer asks Anthropic's usage endpoint for that account again, which had extended the endpoint's own rate limit for capped accounts.
- When OpenCode runs under CortexKit's agent runner, the plugin asks the shared routing service which Claude account to use and reports quota back. The answer is advisory: the plugin's own account rules still apply, and without the runner nothing changes.

## 2.4.5

- OpenCode 2: cache keep-warm saves its sessions, gzipped, to an owner-only folder in the system temp directory, so a server restart no longer drops them and the next turn reads the existing prompt cache. Addresses #545.
- Sticky-balanced routing no longer parks a session for days when its account hits a weekly limit: a 429 whose own rate-limit headers show the limit used up moves the session to an account with room, and a 429 that can't be confirmed is retried after a short wait instead of Anthropic's long `retry-after`.
- `@cortexkit/common-auth` moves to 0.31.0. On OpenCode 2, a session that also uses OpenCode's own Anthropic login or an API key now still retries a rejected vault or local login, and a failed relay, on the same account.

## 2.4.4

- OpenCode 2: an account whose quota window has no reset time (for example one with no usage yet in the current five-hour window) no longer blanks the Claude sidebar to 'Waiting for quota…'. Addresses #556.
- During an Opus 4.8 recovery round on OpenCode 1, cache keep-warm also keeps the original model's prompt cache alive, so returning to it doesn't rebuild the whole prompt. A restart during a round drops this.
- CacheKeep stops warming a session whose account is blocked by its own policy (such as a killswitch floor) and logs the reason once, instead of retrying it as a network failure for up to an hour. Addresses #553.

## 2.4.3

- OpenCode 2: CacheKeep prewarms now read the session's prompt cache. A prewarm sent the stored request through the request rewrite a second time, which renamed every tool again and added the system blocks again, so each idle hour cost two full cache writes. Addresses #547.
- OpenCode 2 now applies the saved log level when it starts. Addresses #543.
- CacheKeep keeps up to 64 MiB of sessions (was 16 MiB) and logs a warning whenever it stops warming a session whose cache is still alive. Addresses #544.
- The Claude sidebar matches the other CortexKit auth plugins: no frame border, a status dot ends each collapsed account row, and the plugin version is always on the right of the header.
- `@cortexkit/common-auth` moves to 0.29.0, which fixes lock release and long paths on Windows.

## 2.4.2

- OpenCode 2: `/claude` → Status now looks up vault accounts itself, so a freshly connected vault shows its accounts before the first request, and an empty vault says so instead of 'No native Claude accounts.' Addresses #528.
- Dependency updates, including claustrum-client 0.13.0.

## 2.4.1

- Works with OpenCode 2.2.0, which requires OpenTUI 0.7: the plugin now depends on OpenTUI 0.7.0, the version OpenCode 2.2.0's plugin SDK asks for, so one copy of OpenTUI installs next to it. OpenCode 1 keeps working: the sidebar and dialogs still run on the OpenTUI that OpenCode itself ships. Addresses #511.
- The sidebar no longer says 'out in now' for a quota window that is already used up; it says the window is used up until its reset.
- OpenCode: a turn is no longer refused with 'Mismatched … effort anchor token' when another plugin puts back an earlier effort marker that gives exactly the same efforts. Effort-marker errors no longer name Fable 5.1 on Opus 5.5 and Sonnet 5.5 requests.

## 2.4.0

- OpenCode 2: CacheKeep keeps warming idle sessions when OpenCode reloads or evicts the plugin for a directory and the directory starts again before the session's cache expires, instead of dropping them after about an hour. Tracked sessions are shared by every OpenCode 2 directory using the same accounts, so while any one of them is open, all of them keep being warmed. If nothing opens an evicted directory again and no other directory is open, OpenCode does not restart it and its sessions are no longer warmed. A server restart still clears them. Addresses #504.
- `npx @cortexkit/opencode-anthropic-auth setup --help` lists every setup option, and `--host pi` works as well as `--host=pi`.
- `@cortexkit/common-auth` moves to 0.28.0.
- Each OpenCode, Pi and setup process now records which account files it uses, ahead of moving the plugin's state files out of OpenCode's config folder in a later release. Nothing moves yet.
- OpenCode 2: request dumps from `/claude` now write files, as on OpenCode 1. If dumps were already turned on, OpenCode 2 starts writing them after this update. Addresses #503.

## 2.3.0

- OpenCode 2: Prime now fires; it failed on every check because of an account-fingerprint format mismatch, and its failure log now says which step failed. Addresses #480.
- The plugin logs which vault enrollment file, names and mode it uses, once per process. Addresses #476.
- OpenCode 2: `/claude` opens with section names only and shows status in a wide view instead of raw Markdown. Addresses #478.
- OpenCode 2: in sticky-balanced mode a session now waits on its account when whichever quota window blocks it resets within 15 minutes, instead of moving and rebuilding its cache, matching OpenCode 1 and Pi.
- `@cortexkit/common-auth` moves to 0.27.1: vault connects are capped at 10 s, settings and enrollment files are read far less often, and local quota saves are batched.
- OpenCode 2: the Claude sidebar no longer fails every refresh with a 400. Addresses #475.
- The sidebar no longer re-reads its preferences file ten times a second per terminal, and a failing sidebar refresh backs off. Addresses #479.

## 2.2.8

- Security: OpenCode 1 and OpenCode 2 now send Claude sign-in (OAuth) requests only to `https://api.anthropic.com`, including the address inside relay requests. A provider `baseURL` (which a project `opencode.json` can set) or `ANTHROPIC_BASE_URL` pointing elsewhere is refused locally for those accounts, before the token is used. API-key routes keep their configured `baseURL` and `ANTHROPIC_BASE_URL`. Pi already worked this way. Addresses #474.

## 2.2.7

- OpenCode 2: finishing an OAuth sign-in from `/claude` → Accounts no longer fails with "Action failed"; the Accounts menu explains how to connect OpenCode when no main account exists. Thanks to @colinmollenhour. Addresses #464.
- When a relay request fell back to a direct send and that direct send failed after going out, the plugin could send the same request a second time. The direct fallback now runs at most once per request, and its failure goes to OpenCode or Pi, which retry as usual.
- Vault setup now grants read access to the name the vault approved for this installation, not always the default name, and the printed `ck auth grant` command uses that name too. Addresses #471.
- In sticky-balanced mode on OpenCode 1 and Pi, a session now waits on its account when whichever quota window blocks it resets within 15 minutes, including 7-day and model limits, instead of moving and rebuilding its cache. OpenCode 2 does not hold yet.

## 2.2.6

- Local mode no longer drops quota and last-used updates when several Claude requests run at once in one OpenCode process: each save takes only the lock it needs, saves for the same account are combined, and on OpenCode 2 the next request uses the newest quota reading straight away. Addresses #461.

## 2.2.5

- OpenCode 2: when a request fails and OpenCode retries, the plugin now chooses the retry's account once and keeps it, and an account it chose but OpenCode didn't use is released.

### Documentation

- The docs now say what their home-folder, temp-folder and shell examples mean on Windows (`%USERPROFILE%`, `%TEMP%`, PowerShell), with one shared note in the environment guide.

### Dependencies

- `@cortexkit/common-auth` moves to 0.25.0.

## 2.2.4

### Documentation

- The vault setup docs now say vault setup needs Claustrum v0.2.0 or newer.

### Setup

- Enrollment status for an old Claustrum vault now directs users to run `ck upgrade` to move to v0.2.0 or newer.
- Rerunning OpenCode 1 setup now imports an OpenCode Anthropic login you added after a first setup that found no accounts, as long as the pool is still empty; before, setup left that login unused until `setup --login`. Addresses #335.

## 2.2.3

### Accounts

- Starting an OAuth sign-in from `/claude` now shows the sign-in link in a dialog that stays open until you close it, in both OpenCode 1 and OpenCode 2, instead of a toast (OpenCode 1) or a message with the link mid-sentence (OpenCode 2). The link sits on rows of its own and wraps at any width, so selecting those rows copies it whole. Core's menu result names the checked link in its own `authorizationUrl` field, so the TUI no longer finds it in the text. OpenCode 1's older account dialog shows the link the same way above its Copy option. Neither TUI's plugin API offers a way to open a browser, so the dialog has no "Open in browser" action. Other results and server notifications are unchanged. Addresses #443.
- When this machine's private-files backend did not load (`@cortexkit/private-files` reports `unsupported-filesystem`), the enrollment refusal now says "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version." instead of "Native custody refused: invalid-token". Its error code is still `invalid-token`, so every other behaviour is the same, and every other unreadable enrollment keeps the old message. Addresses #442 (the private-files message).

### Commands

- In OpenCode 1, when no terminal window with the plugin's TUI part picks up the `/claude` menu within two seconds, the text menu it falls back to now starts with a short note on adding the TUI part to `tui.json`, once per session; later calls in that session don't wait. OpenCode Desktop gets the text menu at once with no note. Addresses #398 (tui.json).

### Setup

- Setup against a vault that doesn't support connecting plugins now stops at once with a clear message, never-created and pending-approval requests are told apart, and a missing Windows private-files addon is reported by name (common-auth 0.24.0). Addresses #439 and #442.
- "Reset host enrollment" no longer answers a pending vault enrollment with a bare `refused-pending`: in OpenCode 1, OpenCode 2 and Pi it now says a request may still be in progress and to quit OpenCode and run setup again, which picks up the same request. The migration-required message now gives `npx @cortexkit/opencode-anthropic-auth setup` without the stale `@2.0.0` version. Addresses #440 and #441.

### Dependencies

- Test and CI dependencies move: the Pi SDK packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) to 1.3.0 together, the OpenCode plugin and SDK to 1.19.3 together, `@ai-sdk/anthropic` to 4.0.82, `jdx/mise-action` to 5.2.0, `actions/download-artifact` to v8, Biome to 2.5.15 and lefthook to 2.2.2. The OpenCode host used by the process E2E checks moves to 1.19.3 with its plugin and SDK fixture. `@cortexkit/common-auth` moves to 0.24.0. The Pi peer range is unchanged.

## 2.2.2

### Accounts

- In vault mode with several OpenCode or Pi processes, quota readings are no longer dropped: a served response no longer holds the vault roster lock while it waits to write its own bookkeeping, which made other processes time out with "Timed out acquiring claustrum-roster-write lock".
- OpenCode 2 now waits for pending quota readings to be saved before it exits, as OpenCode 1 and Pi do, so a reading taken just before exit is no longer lost.

### Dependencies

- Update common-auth to 0.23.0, which saves vault quota readings even while another process holds the account roster lock and gives the sidebar its short quota labels.

## 2.2.1

### Sidebar

- The expanded sidebar labels model rows `Fa` again, as the collapsed line does, and keeps every quota row and pacing line on one line in both OpenCode 1 and OpenCode 2, dropping the reset time when space runs out instead of wrapping or running the percent into it.

## 2.2.0

### Sidebar

- OpenCode 2 now shows the CLAUDE quota sidebar too, without opening `/claude`. It is the same panel as OpenCode 1 (per-account 5h, 7d and model bars with pacing, collapsed rows, routing, cache, Prime and health), drawn from one shared component in the active OpenCode 2 theme's colors and configured by the same `anthropic-auth` entry in `tui-preferences.jsonc`. The OpenCode 2 server answers it through the native RPC (`sidebar` method) from the account pool, with no file and no credential; the active account is the one that last served the sidebar's session. Turned-off vault accounts stay listed, as on OpenCode 1, and reset countdowns, reading ages and pacing keep advancing between server changes. A TUI talking to an older server shows "Waiting for quota…".
- Before an account has served the session, the collapsed sidebar no longer marks `main` as active, matching the expanded view.

### Accounts

- A successful token refresh no longer fails a request just because a quota check finished while it was refreshing.
- Valid tokens no longer wait for proactive refreshes; requests waiting for a rejected-token refresh fail retryably after two seconds while the refresh continues.
- Prevent repeated long replies after housekeeping calls on supported OAuth models in OpenCode 1, OpenCode 2 and Pi. Add a turn-scoped reminder after tool results when the reply has at least 350 visible characters and every call is in `turnEndNote.tools` (default `board` and `ctx_reduce`; an empty list disables it). Replay earlier reminders unchanged for prompt caching, except when a reminder would sit directly before a user message; Anthropic rejects that placement. API-key routes are unchanged.

### Dependencies

- OpenTUI core and solid move to 0.6.6 together and the OpenCode 2 plugin SDK packages to 2.0.32, so each installs once. solid-js stays at 1.9.12, the exact version OpenTUI Solid 0.6.6 requires.
- Update common-auth to 0.22.0 so vault quota sweeps skip duplicate usage polls while insula starts or its upstream fetch has failed; requests also skip polls after an upstream failure.

## 2.1.2

- Requests no longer wait on relay or session-pin bookkeeping locks; relay settings and tokens are checked together before sending.

## 2.1.1

### Packaging

- The OpenCode package depended on `@cortexkit/claustrum-client` 0.11.0 while Core needs 0.12.0, so installing 2.1.0 put two copies in place: the setup command used one and Core the other. An error raised by one copy is not recognized by checks written against the other. OpenCode now depends on the same version as Core, and a packaging check keeps the two in step.

## 2.1.0

### Refusal recovery

- OpenCode 1 retries a refusing source model less often: 10 completed Opus 4.8 responses after the first refusal, 20 after the first re-refusal, then 40 after every further re-refusal. It always tries the source again after each round and never pins to Opus. Ten consecutive successful source responses reset the backoff to 10; tool-use responses count on both models. Picking another model or ending the session clears recovery. State is in memory: an OpenCode restart resets it, so a restarted session may try the original model once more. The same rules apply in legacy fallback mode.
- Stop the immediate source-model cache warm after every Opus recovery response and the wait before returning to the source. That warm used an already-converted Opus request without the source's fallback boundaries, not the source's next prompt. Ordinary CacheKeep still warms the active model, and recovery retains its account binding and Opus standby cache anchor. Desktop notices show the current recovery window without claiming the source cache is being warmed; the sidebar keeps its existing per-session recovery notice.

### Sidebar

- The collapsed OpenCode 1 sidebar now draws quotas with common-auth's shared narrow form, the same one the other CortexKit auth plugins use. An account-wide window without a reading is now left out instead of shown as a placeholder: `5h 87% · 7d — left` becomes `5h 87% left`. An account with no reading at all still shows a muted `—`, and stale readings are still dimmed.
- The collapsed OpenCode 1 sidebar no longer rebuilds every account row each time the sidebar file is rewritten, which made the rows flicker (#379). Rows now stay in place and only their text changes.
- A vault default account whose sign-in expired now shows once, as `main` with "needs sign-in in the vault", instead of also appearing as a second vault account (#392). It is still not used for requests until you sign in again.

### Setup

- Setup and remedies now show `npx @cortexkit/opencode-anthropic-auth setup`; `bunx` still works.
- When vault setup finds no Claude account it can use, it now says why from the vault's own listing (#354). With no read grant for the host, it prints the `ck auth grant` command that adds one. With a grant that reaches no Claude login, it suggests `ck auth reclassify --from-registry` and checking the logins with `ck auth status`. On older vaults that do not report grant reach, the previous message is unchanged.
- When setup fails after vault enrollment began, it now prints one line per host: connected to the vault, not connected, or unknown (check with `ck auth status`). A host left connected also gets the Disconnect / run-setup-again remedy. Setup no longer rereads enrollment files for this, so a failure before enrollment began no longer reports a host connected by an earlier run.

### Quota

- Credit lines show the dollar amounts again, after the shared wording: `credits 75% left · $25.00/$100.00` and `credits spent · $100.35/$100.00`, in OpenCode 1's quota dialog and expanded sidebar and in the OpenCode 2 and Pi quota summaries (#390). 2.0.3 had dropped them. When the amounts would make the sidebar line too wide, they are shown without cents.
- Vault-mode quota now reads Claude's cached quota from insula, with Anthropic usage polls retained as a per-account fallback for stale or missing readings.

### Compatibility

- Move to `@cortexkit/common-auth` 0.21.1, `@cortexkit/claustrum-client` 0.12.0 and `@cortexkit/subc-client` 0.22.0. If the vault cannot be reached, vault accounts keep serving with their last working credential in memory only, while it has more than a minute left; 0.20.0 also fixes Windows saves that timed out. With 0.21.0, requests use the kept credential immediately during a vault outage instead of waiting on the vault.
- Vault hosts now follow account changes from the vault's notices and, while those notices work, check the account list only every 5 minutes. With older vaults that send no notices, they keep checking at today's pace: every 2 seconds in OpenCode 1 and Pi, every 60 seconds in OpenCode 2.
- Update the OpenCode plugin and SDK test dependencies together to 1.19.0. The plugin's peer range and the OpenCode 1.18.18 host used by the process E2E and packed TUI checks are unchanged.
- Update the Pi SDK test dependencies (`pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`) together to 1.2.0. The Pi peer range is unchanged.

### Claude Code identity

- OAuth requests now present as Claude Code 2.1.302 instead of 2.1.280, matched against an interactive 2.1.302 capture: `User-Agent: claude-cli/2.1.302 (external, cli)`, `x-stainless-package-version: 0.128.0`, and the 2.1.302 billing block. A request for a user prompt now also carries `cc_turn_origin=human; cc_prompt_index=N; cc_turn_index=N;`, where `N` counts the prompts in the conversation and stays the same for tool-result follow-ups, plus the `x-claude-code-prompt-id` header. Every request carries `x-claude-code-request-class` (`main`, or `auxiliary` for title, summary and quota-window requests). The `cc_version` suffix and `cch` rules are unchanged.
- Beta lists now follow Claude Code 2.1.302's request classes rather than body-shape heuristics: all main turns use the captured main list, even without tools or companion fields. Auxiliary one-token quota probes use the quota list; other auxiliary requests use title/summary betas, including redact-thinking. JSON schema, fast mode, context-window and server-side-fallback feature betas remain request-dependent. This deliberately replaces the previous shape-distinction contract and its tests.
- Main requests advertise `thinking-binding-controls-2026-08-01` even without replayed thinking; the binding field itself still requires replayed thinking and an explicit setting. `per-turn-control-2026-07-01` follows prompt-caching-scope (after claude-code on Haiku 5.5) on Sonnet 5.5, Opus 5.5, Fable 5.1 and Haiku 5.5. Fable 5.1 effort changes use it with the same empty system messages and `output_config.effort`. The obsolete mid-conversation-system and mid-conversation-output-config betas are no longer sent. Advisor-tool and fallback-credit are also removed: the plugin enables neither an advisor nor a fallback credit code. `server-side-fallback` is unchanged. `thinking-display-updates-2026-08-18` is also sent on main requests, so no baseline beta difference remains from the capture. The body keeps `thinking.display: "summarized"` where Claude Code sends `"updates"`, because `"updates"` streams no thinking text; the beta alone does not suppress summarized thinking.

### Request compression

- OAuth bodies of 4,096 characters or more sent directly to `api.anthropic.com` now go out gzipped, as Claude Code 2.1.302 sends them: billing `cch` reset to `00000`, a newline and up to 256 random spaces and tabs appended, gzip level 6, `content-encoding: gzip`. Requests through a proxy, a custom CA or client certificates, API-key routes and relays stay uncompressed and signed. Set `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` to turn it off.
- If something on the way rejects a gzipped body, OpenCode 1 and Pi resend it once uncompressed with the same request id, and gzip stays off for the process; after a proxy rejection that Anthropic then accepted uncompressed, it stays off for seven days (recorded next to the account storage file, not in settings). OpenCode 2 cannot resend from the plugin, so the rejected request fails and the next one goes out uncompressed. See [transports](docs/transports.md#request-body-compression).

## 2.0.3

### Prompt cache

- Changing reasoning effort mid-session on OAuth Opus 5.5 and Sonnet 5.5 no longer rewrites the top-level effort and invalidates the cached conversation in OpenCode and Pi. The change is sent as an effort-only system message, as already done for Fable 5.1. These requests now always carry `per-turn-control-2026-07-01`, matching Claude Code. Sonnet 5.5 `between_tools`, API-key routes, and Opus 5, Haiku 5.5 and Mythos 5.1 requests are unchanged.

### Setup

- `bunx @cortexkit/opencode-anthropic-auth setup` now runs on common-auth's shared setup runner, the same one the other CortexKit auth plugins use. Host detection, the OpenCode generation choice, the running-process check, host registration and vault enrollment come from the shared runner; Anthropic keeps its own sign-in, migration, Pi consent and vault activation. Pressing Escape or Ctrl-C at the vault question now stops setup without changes.
- OpenCode 2 alone can now be set up without OpenCode 1: setup records an empty local account pool, and you then sign in from OpenCode with "Claude Pro / Max (native account pool)". Setup does not read OpenCode 1's login or open any OpenCode database.
- A later OpenCode 1 setup can import an older 1.x account setup into that pool while it still holds no accounts. Your native preferences stay, and existing session pins are kept. Once the pool holds accounts, setup skips the import instead of overwriting them.
- OpenCode 1 now serves from the native pool even when OpenCode still holds its own separate Anthropic login, as long as the pool has a usable sign-in. `/claude` → Accounts notes that the separate login is not used. Its tokens are never used.
- Setup with no hosts selected now exits quietly instead of failing.

### Relay

- When a relay has no stored transport, the transport is now inferred from its URL, as documented: a `wss://` URL uses WebSocket and an `https://` URL uses HTTP. Before, OpenCode 1 and Pi used WebSocket for every such relay. Set `transport: "websocket"` to keep WebSocket on an `https://` URL; a stored transport always wins. OpenCode 2 now sends such `https://` relays over HTTP instead of refusing them as WebSocket, and still refuses `wss://` ones (#336).
- The OpenCode 1 sidebar now shows the relay only when requests can use it, with the transport requests actually use. A relay enabled without its stored secret, whose requests go direct, no longer appears as active (#336).

### Documentation

- The READMEs are now short entry pages. Reference material moved to `docs/`: installation, accounts and routing, vault, commands, cache, transports, OpenCode 2, models, sidebar, environment variables, request rewriting, troubleshooting, development and releases.

## 2.0.2

### Fixes

- OpenCode 1 and OpenCode 2 local serving now read the session-routing file that the 2.0 setup migration fills, the same file Pi uses. Before, they read the old file name, so after upgrading each existing conversation picked an account again and rebuilt its prompt cache. Pins saved at the old name since upgrading are merged in once on the first routed request, never replacing a newer pin; a damaged or unreadable old file is skipped with one warning. OpenCode 2 also honors `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE`. Vault mode was not affected.
- Map tool names in Claude's responses back using only the tools that request declared (#286). A guessed short name such as `mcp_Search` is mapped to a declared tool only when exactly one declared tool matches; it no longer defaults to an AFT tool or rewrites a correctly called tool named `search`. A name that cannot be mapped back without risk of selecting a different declared tool stops the response with a fixed, non-retryable error. Tool arguments are never changed, and outgoing tool names are unchanged.

### Compatibility

- Support Pi 1.x (tested with 1.1) alongside Pi 0.86, and build the OpenCode sidebar for OpenTUI 0.6.
- Move to `@cortexkit/common-auth` 0.17.0.

## 2.0.1

### Fixes

- Setup can now find OpenCode, Pi and the Claustrum `ck` CLI on Windows, so it can configure them. Before, it reported "Neither OpenCode nor Pi was detected" when they were installed through npm or Bun launchers, or as OpenCode Desktop, or before OpenCode had written a config file.
- Windows vault enrollment works: `@cortexkit/claustrum-client` moves to 0.9.0, the first version that writes the enrollment token owner-only on Windows. Mac and Linux behavior is unchanged, and existing enrollments keep working.
- OpenCode 2: a request that retried after a 401 no longer fails with "Native Prime was not completed" when its first attempt's quota save was refused.
- Move to `@cortexkit/common-auth` 0.15.0, which closes a lock race that could let two writers hold the same file lock and writes private files owner-only on Windows.
- Session routing, vault enrollment and quota updates check that they still hold their file lock right before saving. A rare lock race could otherwise let two writers save at once and drop a session's account pin. A displaced save keeps the request's route and skips saving.

### For integrators

- `@cortexkit/anthropic-auth-core` is now an internal package of the OpenCode and Pi plugins. Its public, stable API is the identity, header, billing and signing functions listed in its README; everything else may change in any release.
- Removed from Core's exports: the 1.x scoped vault-custody modules (Core's own `ClaustrumScopedCustody`, the scoped roster and `ClaustrumScopedRuntime`), the 1.x sidecar account-file loaders and writers and `FallbackAccountManager`, and the sidecar routing-mode writer. The 2.0 native account runtime replaced all of them.

## 2.0.0

### Breaking Changes

- Store Claude logins, fallback accounts and plugin settings in a shared native account store instead of the old `anthropic-auth.json` / `anthropic-auth-state.json` sidecars. Upgrading requires one offline step: quit every OpenCode, LiteCode and Pi process, then run `bunx @cortexkit/opencode-anthropic-auth@2.0.0 setup`. Until it completes, OpenCode and Pi refuse Anthropic requests with that remedy and never serve, refresh or rewrite the old credentials. Migration preserves session routing. There is no reverse migration; returning to 1.23.0 requires a fresh configuration and new sign-ins.
- Replace the separate `/claude-*` commands with one `/claude` menu in OpenCode and Pi.
- Remove the handle-based Claustrum serving path, manifest bindings and per-account gates. Vault custody now comes only from this host's setup enrollment and uses a separate vault account namespace; while connected, only vault accounts serve and local accounts remain unchanged. Disconnecting returns to the local accounts, restoring any Pi login that setup moved aside. Remove Core's process-shared enrollment-registry export.

### Features

- Support OpenCode 2 with direct requests and HTTP relay. OpenCode 2 refuses a selected WebSocket relay before sending; OpenCode 1 and Pi keep WebSocket relay support.
- Add Claude Haiku 5.5 (`claude-haiku-5-5`) to Core, OpenCode, and Pi with a 1M context, 128K output and native `low` through `max` adaptive effort. Preserve supported forced tool choice, remove rejected manual thinking budgets and sampling parameters, and honor OpenCode thinking opt-outs at high effort or below. Standard input/output pricing is $0.10/$0.50 per million tokens; all rates increase fivefold above 100K total input tokens, including cached input. OpenCode and Pi apply the selected pricing tier to all input, output and cached tokens in the request, not just the tokens above the threshold. `thinkingBinding.prefixMismatchBehavior` set to `error` or `drop_block` also covers replayed Haiku 5.5 thinking after earlier conversation content changes. Subscription OAuth requests continue to show zero API cost in the host. Haiku 5.5 does not enable fast mode or automatic safety fallback, and quota priming continues to use Haiku 4.5.

- Add Claude Sonnet 5.5 (`claude-sonnet-5-5`) to Core, OpenCode, and Pi with its 1M context, 128K output, and official pricing. OpenCode and Pi request readable adaptive thinking. OpenCode maps explicit thinking opt-outs to Sonnet 5.5's `between_tools` mode, removes unsupported forced tool choice, and offers native `low` through `max` effort variants. Apply configured `error` or `drop_block` behavior to replayed Sonnet 5.5 and Opus 5.5 thinking when earlier messages, instructions, or tools have changed; the default account behavior stays unchanged. Pi exposes the model's supported `low`–`max` effort levels while refusing unsupported `minimal` and unavailable `off`.

### Fixes

- Remove account tokens from provider errors, stream errors, relay failures, background logs and setup or CLI failures, including encoded and split forms, while leaving successful model responses unchanged.
- Wait briefly for an account's first identity update during startup instead of silently sending the request through another account; a request that still cannot use the account refuses with a retryable connection error.
- Require a quota reading before admitting an account under an enabled killswitch floor, even when unknown quota is otherwise allowed.
- Fix OpenCode's hybrid 1-hour prompt caching when Magic Context adds an image of project memories. Place one cache breakpoint after the stable context and image, and another after the following history updates, so both prefixes can be reused. Requests without the image and the four-breakpoint limit remain unchanged.
- Stop silently discarding meaningful trailing assistant turns in OpenCode and Pi, which could replay the previous question. A shared Core guard removes only provably empty trailers and refuses other tails before billing, caching, signing, or model dispatch. OpenCode reports a terminal local 400 that cannot trigger account fallback, even when upstream 400 responses are configured for fallback; genuine provider responses retain that policy. Pi reports a terminal provider error without sending a model request.

### Patch Changes

- Stop sending `speed: "fast"` to Opus 4.7, where it returns 400, and Opus 4.6, where it has no effect. Fast mode now applies only to Opus 4.8, Opus 5, and Opus 5.5 in OpenCode and Pi (#267).
- Remove Opus 5.5's unsupported forced `tool_choice` for OpenCode structured-output requests while retaining the schema tool. OpenCode still records validated structured output and reports an error if the model does not call it. Keep named `tool_choice` references aligned with prefixed tool definitions on other models (#268).
- Isolate OpenCode tests from live account files, sidebar state, CacheKeep leases, RPC directories, and Claustrum sockets even when a test clears a feature-specific override. Setup detection now uses the supplied environment for its connection file (#264, #265).
- Persist scoped main quota under the discovered primary account rather than the local host slot, and let quota refresh poll with a freshly authorized scoped credential. A header-only main quota remains due for its first usage poll; failed polls are spaced by account without treating usage 403 as rate-limit backoff or counting requests that lose the cross-process refresh lock.
- Load the Pi extension through Oh My Pi's legacy SDK compatibility layer by keeping transcript system-prompt and tool replay in the extension instead of importing helpers absent from the host. Check built Pi imports with a syntax-aware allowlist in CI and release workflows.
- Add debug diagnostics for scoped 401 retry decisions and delivered failure reports across OpenCode and Pi, recording served and current record versions and a non-secret decision reason without logging bearer material.
- Update the shared Claustrum client to 0.4.0 (with Subc client 0.16.x) for scoped custody. The client no longer reconnects on a terminal `unknown_module` response from a daemon without the Claustrum module.
- Show an approved Claustrum enrollment as active in account status when the main account is vault-served; stop telling already configured users to rerun setup or request a grant. Clarify that `enrollment-reset` only clears terminal state.
- Fix packed OpenCode CLI startup under Node: keep `jsonc-parser` external so its CommonJS `./impl/*` modules resolve from the installed dependency, and run the packed CLI's `--help` path alongside the TUI smoke gate (#257).
- Stop unsolicited Claustrum enrollment on OpenCode boot and account-status views: only explicit offline setup proposes and polls, while the locked enrollment reset clears terminal state under lock without starting another request. Setup resumes crash-persisted secrets and replaces one daemon-confirmed dead request; all producer-permanent refusal codes stop polling even when older client transports mislabel them retryable. This removes the per-process enrollment poll loop (#255) without changing scoped account-discovery polling.
- Update OpenCode plugin and SDK test dependencies together to 1.18.31, plus Biome 2.5.14, Lefthook 2.1.14 and the dev-only Anthropic SDK 4.0.58; preserve packed TUI and custom-fetch compatibility checks.
- Remove Core's unused direct `@cortexkit/subc-client` dependency and declare it where the E2E mock uses it. Synchronize `bun.lock` workspace versions and dependency declarations during version bumps, and fail CI or release preparation when the lock disagrees with package manifests (which Bun's frozen install alone did not detect).
- Enforce Core/OpenCode/Pi unit-test count floors in CI and releases with one measured test pass, a PR merge-target ratchet and a release ratchet against the previous version tag rather than only the release commit's parent. A reduction requires an explicit from/to marker and reason; release checks reject stale tags or missing floor provenance, with v1.23.0's verified floorless baseline seeded at 290/1672/140. Both workflows check canonical Claustrum fixture provenance and the real Pi host tool-call round-trip.
- Keep Fable 5.1 effort changes correlated through completed tool-call continuations and consecutive host user records merged onto one wire boundary; log safe refusal metadata and apply the last planned effort on each merged boundary. Retain a bounded, revocable history when compaction overwrites an in-flight request plan. Missing anchors still fail closed rather than treating unprovable marker loss as a valid prefix trim.
- Pin the vendored Claustrum tombstone to the canonical `cortexkit/claustrum` source: update the fixture to the deployed empty-access shape and verify its exact bytes against a commit reachable from canonical `master`. Remove an obsolete "vault path not implemented" refresh error.
- Recover in-flight scoped OAuth rotations on replayable model requests, CacheKeep prewarms, Prime fires, and quota/profile queries: reauthorize after a genuine upstream 401 and retry once only when the same account's record version advances. Report only the final rejected send-time version, reauthorize relay-to-direct fallbacks separately, and classify relay-owned 401s without an Anthropic request ID as transport errors rather than account failures.
- Fix OpenCode main quota polling under scoped custody: resolve the quota account UUID to the `main` route before authorization. This also restores Prime's main-account quota preflight.
- Restore Pi tool-call name mapping on normalized transcripts: the streaming response uses the exact host tool set resolved for its outgoing request, rather than the missing `context.tools` field on Pi ≥0.86.
- Prevent background fallback refresh and quota polling from sending retained local OAuth material when a legacy Claustrum configuration is incomplete.
- Fix TUI sidebar `Tracked` session count flickering between instances: scoped roster notifications now fire only when the discovery view actually changes instead of on every 2s poll, background sidebar refreshes rebuild the cross-process CacheKeep aggregate before writing, and each instance refreshes its aggregate view on a 10s background tick so per-request writes no longer clobber a sibling's count with a stale zero.

## 1.23.0

### Minor Changes

- Support Claude Opus 5.5 (`claude-opus-5-5`) across Core, OpenCode, and Pi:
  - Expose Opus 5.5 model specifications (1,000,000 token context window, 128,000 max output tokens, $4/$20 MTok pricing).
  - Enforce always-on adaptive thinking with summarized display (`thinking: { type: "adaptive", display: "summarized" }`) per Anthropic's Opus 5.5 specification, automatically rewriting disabled thinking or manual token budgets to adaptive summarized to prevent 400 invalid request errors.
  - Expose native adaptive `low`, `medium`, `high`, `xhigh`, and `max` effort variants for Opus 5.5 in OpenCode's provider catalog and Pi.
  - Support Anthropic fast mode (`speed: "fast"` with `fast-mode-2026-02-01` beta header) on Opus 5.5.
  - Provide refusal recovery and server-side safety fallback parity for Opus 5.5, isolating recovery state between Opus 5 and Opus 5.5.
- Add unified interactive `opencode-anthropic-auth setup` wizard (`bunx @cortexkit/opencode-anthropic-auth setup`) for one-step detection and configuration of OpenCode, Pi, and zero-bind Claustrum vault custody.
- Add Claustrum vault custody support to Pi with native ambient authentication, per-dispatch scoped credential authorization, atomic roster reconciliation, and version-fenced 401 reporting.
- Implement zero-bind scoped Claustrum custody across OpenCode and Pi, discovering vaulted Anthropic accounts automatically via `listScoped` under `category:anthropic-native` without manual capability handle minting, manifest files, or process restarts.

- Add the global `/claude-account claustrum|local` custody mode for every OpenCode OAuth account, including main-account tombstone takeover, fail-closed serving, and explicit Pi refusal.
- Add global Claustrum manifest onboarding, startup legacy-handle migration, and verified local re-login recovery.
- Add a crash-resumable OpenCode Claustrum enrollment ceremony for the future scoped-discovery cutover, using producer-owned typed wire decoders, one host-global owner-only token, secret-before-propose persistence, process/file-lock sharing, and explicit pending/terminal status without enabling scoped credential spending yet.
- Add API-key/proxy-only custom headers and model aliases for OpenCode and Pi, preserving versioned proxy base paths while protecting route authentication, protocol headers, and internal correlation state.

### Patch Changes

- Bind sticky-balanced affinity to the user-selected model for OpenCode and Pi, discarding the old assignment and CacheKeep route preference on a real model change while preserving account affinity for transparent Fable/Opus recovery.
- Enroll newly bound Claustrum OAuth accounts into the OpenCode routing pool at startup or live without a restart, after exact credential-ID and provider-account verification; immediately prime quota for sticky-balanced routing, persist only secret-free tombstone rows, preserve disabled accounts, and recover missed manifest watch events with one process-shared metadata poll.
- Remove obsolete root-level build output before workspace builds so stale pre-custody CLI artifacts cannot bypass current account and Claustrum safeguards.
- Give consecutive Desktop fallback notices distinct, pre-registered message IDs before the assistant; defer delivery when safe ordering is unavailable and bound notice tracking across sessions (#230).
- Publish account UUIDs and credential-lineage provenance in the sanitized quota-header feed while fencing stale lease cleanup.
- Make Pi effort history compatible with both host context-entry APIs, preserve ordered structured system-prompt blocks, and keep every cache strategy within Anthropic's four-breakpoint limit.
- Bind persisted main-quota ordering to the account-bound snapshot's embedded `checkedAt` value, preventing a concurrent unbound `mainQuotaCheckedAt` value from making stale state replace a newer in-memory or on-disk observation.
- Harden global Claustrum takeover as a resumable fail-closed transition: repeated commands accept already tombstoned fallbacks, failed partial commits never restore whole-file snapshots over concurrent account edits, local fallback login is refused before OAuth while custody is active, and main-account Prime uses the resident vault credential for quota checks and sends with version-fenced 401 reporting.
- Keep OpenCode's request-scoped Fable 5.1 effort plan available across automatic retries of the same transformed message, and fold effort changes removed by downstream prefix compaction into the retained baseline through a checksum-bound current-boundary anchor. This prevents transient retries and legitimate Magic Context trims from becoming local plan-correlation failures while preserving fail-closed validation for non-prefix loss.
- Match Claude Code's request billing lineage on OAuth OpenCode turns: pin one `cc_prompt_id` UUID to the causal user message across tool loops and retries, carry genuine direct or relay response request IDs as `cc_prev_req`, exclude background turns, and strip request lineage from reusable prewarm bodies before re-signing. Model-family checks also recognize OpenCode's `[1m]` context qualifier.
- Isolate loopback RPC servers and notification drains by project/session, serialize concurrent same-directory server replacement, and make plugin disposal release every per-instance background service without stopping a successor or a shared Prime manager still leased by another project.
- Fence no-reply Desktop fallback notices against newly created user messages before OpenCode publishes its busy status, and coalesce overtaken transition notices to the latest state so rapid turns neither duplicate provider requests nor strand a current notice behind stale text.

## 1.22.0

### Minor Changes

- Add Claude Fable 5.1 and limited-access Mythos 5.1 across the shared model catalogue, OpenCode request/routing/recovery paths, and Pi provider catalogue.
- Preserve OAuth Fable 5.1 prompt-cache prefixes across mid-conversation effort changes in OpenCode and Pi, and expose explicit `account-default`, `error`, or `drop_block` thinking-prefix mismatch behavior in sidecar config.
- Add opt-in OpenCode Claustrum custody for fallback OAuth credentials, with vault-owned refresh, cache-only request-path reads, version-fenced 401 reporting, sidecar failover, and custody status in account UI.

### Patch Changes

- Preserve OpenCode Fable 5.1 effort transitions when host lowering collapses tool-heavy or compacted assistant records, and keep marker correlation stable when later message transforms tag or persist the same user parts.
- Treat DNS lookup failures as transient OAuth refresh failures with a fixed five-minute retry interval—including already-persisted long backoffs—and keep sticky-balanced fallback routes usable while their current access token remains valid.
- Match Claude Code 2.1.258 request identity and final-body `cch` signing, keep the billing suffix stable through in-process session compaction, and apply configured Fable 5.1 thinking-prefix behavior only when replaying signed or redacted thinking in OpenCode or Pi.
- Reject provider-bound Claustrum custody tombstones locally before OAuth refresh without persisting a permanent auth failure, and ensure shutdown closes any replacement transport that finishes connecting after the Claustrum client is closed.
- Redact malformed JSON parser context before account sidecar and request-dump errors reach logs, preventing secrets from being repeated in diagnostic text while retaining path, line, and column metadata.
- Bind persisted OAuth refresh backoffs to the refresh-token fingerprint in OpenCode and Pi. Rotated credentials immediately escape stale `invalid_grant` latches, cross-process clears are fenced against stale writers, Claustrum outage fallback uses the same lineage check, and `/claude-account reset-backoff` explicitly clears main refresh and matching quota backoffs.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for contributing Fable/Mythos 5.1 support, Claude Code identity compatibility, Claustrum fallback custody and tombstone guards, parser-error redaction, and refresh-latch recovery.

## 1.21.0

### Minor Changes

- Keep quota, profile, refresh-backoff, Prime-lineage, and routing state attached to stable Claude account identities across OAuth token rotation, while treating unknown identity or quota as distinct from an absent account.
- Add an opt-in OpenCode host-local feed for sanitized response-header quota observations so another local CortexKit process can consume fresh account state without polling Anthropic's rate-limited usage endpoint.

### Patch Changes

- Coalesce main OAuth refreshes across OpenCode project plugin instances and let sticky 401 recovery adopt a concurrently rotated valid credential instead of refreshing it again.
- Prevent Pi from replaying foreign thinking signatures to Anthropic while preserving visible reasoning as text, and round-trip Anthropic `redacted_thinking` blocks for valid same-model continuation.
- Keep the OpenCode plugin entrypoint limited to the plugin factory so the host cannot invoke internal request-policy helpers as plugins.
- Update OpenTUI Core and Solid together to 0.5.7 and `@tsconfig/bun` to 1.0.11.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for contributing stable account identity and the host-local quota feed.

## 1.20.0

### Minor Changes

- Add opt-in `/claude-prime` scheduling that sends a minimal Haiku 4.5 request shortly after each OAuth account's five-hour quota reset so each window starts immediately.
- Add the OpenCode-only `/claude-start` command for an explicit synthetic one-token turn through the current session's normal model, routing, cache, and request pipeline.
- Capture Anthropic cache diagnostics in versioned `MC-CACHE-DIAG ` debug records and sanitized dump artifacts, preserving provider response IDs across normal requests and CacheKeep prewarms.
- Fix Pi OAuth billing rejection by relocating its documentation paragraph from top-level `system[]` to a cached block before the first user's text, with a safe whole-prompt fallback for unknown future Pi prompt layouts, and expose Claude Opus 5 in Pi's provider catalog.

### Patch Changes

- Deliver OpenCode Desktop recovery notices without triggering an extra billed provider turn on OpenCode 1.18 and newer, including holding the switch notice until the first successful Opus recovery response and revalidating the idle delivery lease after asynchronous status and message-history reads so a racing prompt cannot adopt the notice as its retry parent.
- Retry failed CacheKeep prewarms while the last confirmed cache can still be alive, and serialize overlapping manager ticks to avoid duplicate requests.
- Preserve fresh scoped-only fallback quota snapshots, permanent refresh-error classification across lock contention, and explicit re-login guidance for unusable fallback accounts.
- Finalize response-artifact writes before transformed streams complete, recover the first same-session request byte-diff baseline from disk after a restart, sweep stale partial dump files even below the size cap, and evict complete request artifact groups when enforcing that cap.
- Update OpenCode, OpenTUI, Pi SDK, Miniflare, Biome, TypeScript, and CI dependencies, including OpenCode 1.18 and OpenTUI 0.5 compatibility fixes.

Thanks to [@iceteaSA](https://github.com/iceteaSA) for contributing quota priming, cache diagnostics, and explicit lane starts.

Thanks to [@unspecd-dev](https://github.com/unspecd-dev) for diagnosing and contributing the Pi request-shape and Opus 5 changes.

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
