# Accounts, routing and quota

A native account pool holds the Claude subscription accounts and optional API-key routes for one host. OpenCode 1 and 2 share OpenCode's pool; Pi has a separate pool. Enrollment authority selects either that local pool or the vault, never a mixture of both.

## Local storage

OpenCode defaults to `~/.config/opencode/`; Pi defaults to `~/.pi/agent/`. On Windows these are `%USERPROFILE%\.config\opencode\` and `%USERPROFILE%\.pi\agent\` (see [paths on each OS](environment.md#paths-on-windows-macos-and-linux)). The directory containing `OPENCODE_ANTHROPIC_AUTH_FILE` or `PI_ANTHROPIC_AUTH_FILE`, when set, determines the corresponding native path set. Files have distinct roles:

| File | Contents |
| --- | --- |
| `anthropic-auth-pool.json` | Local account rows, route definitions, settings and local quota metadata |
| `anthropic-auth-pool-state.json` | Private local credentials |
| `anthropic-auth-native-state.json` | Per-account runtime metadata, including profile, validation and Prime state |
| `anthropic-auth-pool-routing-state.json` | Default local session pins, keyed by hashed session IDs |
| `anthropic-auth-migration.json` | Authority and migration journal |

The legacy `anthropic-auth.json` and `anthropic-auth-state.json` are import sources, not live serving stores. Use [stopped-host setup](installation.md#recommended-setup) to import them. [Empty initialization](opencode-2.md#empty-initialization) is different: it creates authority without importing credentials. Later import preserves native preferences and existing native session pins while the pool has no account data. Once populated, native tokens are never merged from a separate host login, even for the same account UUID.

For empty-init authority, the local routing destination is `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` or `PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE` when set, otherwise the path derived from the native pool config. A completed legacy import records its routing destination in the journal, and serving uses that recorded file. Preferences or session pins alone do not make a pool populated; private account entries do, even with no public account rows.

## Adding and managing accounts

For OpenCode 2, [connect the main account through the registered provider login](opencode-2.md#empty-initialization) before adding other accounts. `/claude` → **Accounts** manages the pool; it does not change which Anthropic connection OpenCode uses for model requests. **View status** shows the main account and each fallback's enabled/disabled state.

Use `/claude` → **Accounts** to start and finish OAuth sign-in, add an API-key fallback, enable/disable, reorder, remove or reset backoff. Local changes refuse while enrolled in the vault. The [OpenCode CLI](commands.md#opencode-cli) also offers `login`, `api add` and `list` for OpenCode local custody only.

OAuth login must resolve a verified Claude account UUID. Credentials and refresh operations stay in the native runtime; the host's inert marker is never a credential. Re-login an account with a permanent `invalid_grant` failure rather than copying tokens between stores. The plugin never uses a separate OpenCode 1 login's access or refresh tokens.

## Routing modes

| Mode | Policy |
| --- | --- |
| `main-first` | Prefer the main account, then eligible fallbacks |
| `fallback-first` | Prefer eligible fallback accounts before main |
| `sticky-balanced` | Assign cold sessions using spendable quota and keep session affinity across requests and restarts |

Change mode in `/claude` → **Routing**. **Reset routing session** clears the current session's pin; it does not remove accounts. Pins are quota-aware session-affinity hints, not credentials. Changing the selected model can require a fresh assignment. Model-specific exhaustion can move among OAuth accounts, but paid API-key fallback requires confirmed general OAuth exhaustion, not just an exhausted model-specific limit or a display percentage rounded up to 100%.

Sticky-balanced waits on the assigned account only when every exhausted window blocking the requested model has a known future reset and the latest reset plus deterministic session jitter fits before this session's prompt cache expires on that same account. The cache lasts one hour with 1-hour caching enabled (any mode), otherwise five minutes; unknown TTL also uses five minutes. No recent accepted response on this account means no hold. This includes five-hour, seven-day and matching model-scoped limits, but not another model's scope. In `/claude` → **Routing** → **Longest wait on the same account**, choose **Don't wait** (`0`), **15 minutes** (`15`, the default), or **Until the cache expires** (`max`). The wait must fit both the cache lifetime and the selected budget. Unknown, invalid or past blocking resets, or a reset beyond that bound, allow migration. OpenCode 1 returns `Retry-After`; Pi waits inside the plugin with the reset time shown in its working message; Escape cancels immediately. After the bounded wait it rechecks quota, admission and account identity, then resends on the same account or ends with an error that Pi will not automatically retry if the account is still blocked. OpenCode 2 caps each wait at 15 minutes. With `max`, it can hold again on the next retry without extending the cache lifetime; each hold consumes one of the host's ten retries. OpenCode 2 holds the same way after a 429: OpenCode waits that long, then retries on the same account, which keeps its pin. It does not hold after output has started, in a session that has used both the plugin's connection and another Anthropic credential, or when the account cannot serve the model during the wait (a model-scoped limit at zero, a configured minimum remaining quota (quota floor) or a killswitch block); those move.

## Quota and limits

Quota shows five-hour, seven-day and model-scoped windows when available. OpenCode's **Refresh quota** action requests fresh readings; Pi shows the summary without a refresh action. Passive response headers and quota API polling have different coverage: headers can update standard windows without supplying model-scoped limits.

Quota figures use the shared wording, such as `5h 40% left, resets 2h29m` and `7d 70% left, resets 3d23h`. Readings older than fifteen minutes include their age, such as `checked 1d6h ago`. Extra usage is shown as `credits 40% left` or `credits spent`, followed by the amount spent and the monthly limit in your account's currency: `credits 75% left · $25.00/$100.00`, `credits spent · $100.35/$100.00`. Without a limit (or without amounts), only the credit figure is shown. In a narrow OpenCode sidebar, amounts that would make the line too wide are shown without cents (`$1,250/$5,000`), and the collapsed sidebar's one-line form is unchanged.

`quota.minimumRemaining.five_hour` and `.seven_day` are minimum **remaining** percentages, not usage percentages (`5h` and `1w` are menu aliases). `quota.failClosedOnUnknownQuota` controls unknown readings where no positive killswitch floor applies. Killswitch thresholds are separate hard blocks:

- A positive five-hour or seven-day floor blocks missing readings for that window regardless of `failClosedOnUnknownQuota`.
- A positive `scoped` minimum-remaining percentage blocks missing model-specific quota information. An explicitly empty scoped-window list means no separate window applies.
- OpenCode can edit killswitch thresholds in **Limits**; Pi does not expose those edits.

The optional `quotaHeaderFeed.enabled` setting is OpenCode-only, disabled by default and requires restart. It publishes allowlisted quota observations, opaque identity and timestamps to owner-only temporary lease files, not tokens, request bodies, model IDs or refresh errors. It shares observations already obtained from responses rather than making new quota API requests.

## Settings and custody

Use menu actions for routing, cache, CacheKeep, fast mode, diagnostics and supported limits. `claudeCache.mode` accepts `explicit`, `automatic` or `hybrid`; `cacheKeep` controls keepalive, and `relay` controls an optional transport. See [cache](cache.md#cache-modes) and [transports](transports.md#relay) for their effects and costs.

Vault settings, roster and routing use a separate `anthropic-auth-vault-*` namespace. While enrolled, local credentials are not served, refreshed, polled or kept warm. See [vault accounts](vault.md#accounts-while-enrolled) and the [authority table](custody-state-machine.md#authority).
