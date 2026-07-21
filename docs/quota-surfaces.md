# Anthropic quota surfaces

Three independent surfaces expose Claude plan quota and account identity to OAuth clients. All captured live on 2026-07-16 against two accounts of **different kinds** — `main`: personal Max plan (`organization_type: claude_max`, `rate_limit_tier: default_claude_max_20x`, extra usage disabled) and `work-alt`: Team seat (`organization_type: claude_team`, `seat_tier: team_tier_1`, `rate_limit_tier: default_claude_max_5x`, extra usage enabled and exhausted). Account kind drives which quota headers/fields appear. Structural mirror of the openai-auth catalogue: Codex exposes the same two ideas as `x-codex-*` response headers (passive) — Anthropic additionally has a rich poll endpoint.

| Surface | Transport | Freshness | Scoped per-model windows | Idle accounts |
| --- | --- | --- | --- | --- |
| Usage API (`GET /api/oauth/usage`) | active poll, per token | on demand | **yes** (`limits[]`) | **yes** — pollable without traffic |
| `anthropic-ratelimit-unified-*` headers | passive, on every `/v1/messages` response | every request | no | no — only accounts you send through |

The plugin combines surface 1 background polling (`fetchOAuthQuotaSnapshot` + `QuotaManager`) with passive response-header harvest from surface 2 across direct and relay transports.

---

## Surface 1 — usage API

```
GET https://api.anthropic.com/api/oauth/usage
authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Consumed by: `fetchOAuthQuotaSnapshot()` (`packages/core/src/accounts.ts`), which maps it to `OAuthQuotaSnapshot` (`five_hour`/`seven_day`/`scoped[]` + `checkedAt`).

### Top-level shape (observed 2026-07-16)

```jsonc
{
  "five_hour":   { /* window */ },
  "seven_day":   { /* window */ },
  // legacy per-model window slots — null on both probed accounts:
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "seven_day_cowork": null,
  "seven_day_omelette": null,
  // unreleased feature-flag slots (codenames) — null on both probed accounts:
  "tangelo": null,
  "iguana_necktie": null,
  "omelette_promotional": null,
  "nimbus_quill": null,
  "cinder_cove": null,
  "amber_ladder": null,
  "extra_usage": { /* extra-usage credits block */ },
  "limits":      [ /* unified limits array — the modern surface */ ],
  "spend":       { /* extra-usage spend detail */ },
  "member_dashboard_available": false
}
```

### Window object (`five_hour`, `seven_day`)

| Field | Type | Notes |
| --- | --- | --- |
| `utilization` | int percent | integer only — no sub-percent precision |
| `resets_at` | ISO 8601 (µs precision, +00:00) | end of current window |
| `limit_dollars` / `used_dollars` / `remaining_dollars` | null on plan accounts | presumably populated for pay-as-you-go/org billing |

### `limits[]` — the modern unified surface

One entry per active limit class. Observed kinds:

| `kind` | `group` | `scope` | Meaning |
| --- | --- | --- | --- |
| `session` | `session` | null | the 5h window |
| `weekly_all` | `weekly` | null | the 7d all-models window |
| `weekly_scoped` | `weekly` | `{ model: { id, display_name }, surface }` | per-model weekly carve-out (e.g. Fable promo) |

Entry fields:

| Field | Type | Notes |
| --- | --- | --- |
| `percent` | int | utilization |
| `severity` | `normal` \| `warning` \| … | observed `warning` at 77%; captured but not used for plugin tone |
| `resets_at` | ISO 8601 | per-limit reset |
| `scope.model.id` | string \| null | **null observed even for Fable** — only `display_name` present ("Fable"); this is why `scopedQuotaModelKey` normalizes display names |
| `is_active` | bool | **inferred:** marks the currently *binding* limit — on both accounts the entry with the highest percent carried `is_active: true` (main: Fable 15% > 7d 13% > 5h 4%; work-alt: session 77% > Fable 51% > weekly 40%). Not documented by Anthropic; treat as heuristic |

`limits[]` supersedes the legacy `seven_day_opus`/`seven_day_sonnet` slots (always null in our captures). The plugin reads `limits[]` for scoped windows (PR #108/#109 work: empty-`[]` presence contract, scoped killswitch).

### `extra_usage` + `spend` (extra-usage credits)

Observed on work-alt (enabled, **exhausted**): `monthly_limit: 10000` minor units, `used_credits: 10035`, `utilization: 100`; `spend.severity: "critical"`, `spend.limit.amount_minor: 10000`, `spend.cap.credits`, `can_purchase_credits: false`. On main (disabled): all null, `is_enabled: false` (header equivalent: `overage-disabled-reason: org_level_disabled`).

Money is `{ amount_minor, currency, exponent }` — e.g. `10035` minor / exponent 2 = $100.35.

Consumed for `/claude-quota` and expanded TUI/sidebar credit display. Extra usage remains display-only and does not affect routing.

### Response headers on the usage API itself

Only `anthropic-organization-id` + `request-id` — the `ratelimit-unified` family does NOT appear on the usage endpoint, only on `/v1/messages`.

---

## Surface 2 — `anthropic-ratelimit-unified-*` response headers

Present on every `/v1/messages` response (200s included; OAuth transport). Captured live 2026-07-16 on both accounts — the header SET is conditional on account state and kind, not fixed:

| Header | main — personal Max 20x (3%/12%, overage disabled) | work-alt — Team seat, Max-5x tier (78%/40%, credits exhausted) |
| --- | --- | --- |
| `…-unified-status` | `allowed` | `allowed` |
| `…-unified-reset` | `1784252400` (epoch **seconds**) | `1784246400` |
| `…-unified-representative-claim` | `five_hour` | `five_hour` |
| `…-unified-5h-status` | `allowed` | `allowed` |
| `…-unified-5h-utilization` | `0.03` (**fraction**, not percent) | `0.78` |
| `…-unified-5h-reset` | `1784252400` | `1784246400` |
| `…-unified-7d-status` | `allowed` | `allowed` |
| `…-unified-7d-utilization` | `0.12` | `0.4` |
| `…-unified-7d-reset` | `1784502000` | `1784628000` |
| `…-unified-fallback` | — absent | `available` |
| `…-unified-fallback-percentage` | `0.5` | `0.5` |
| `…-unified-overage-status` | `rejected` | `rejected` |
| `…-unified-overage-disabled-reason` | `org_level_disabled` | `org_spend_cap_reached` |
| `…-unified-overage-utilization` | — absent | `1.0` |
| `…-unified-overage-surpassed-threshold` | — absent | `1.0` |
| `…-unified-overage-reset` | — absent | `1785542400` |

Conditional headers (absent on main, present on work-alt): `fallback` appears once utilization is high enough that a client-side fallback is advisable (5h 78% > the 0.5 `fallback-percentage` threshold — consistent with `fallback-percentage` being the trip point); the three extra `overage-*` headers appear when extra-usage credits have actually been consumed (work-alt: 100% used, spend cap reached, `overage-reset` = when the monthly credit window resets). A header consumer must treat every non-core header as optional.

| Header | Semantics |
| --- | --- |
| `…-status` | overall admit decision (`allowed`; presumably `rejected`/throttle states near limits) |
| `…-reset` | top-level reset = reset of the representative claim |
| `…-representative-claim` | which window is currently binding (`five_hour`/`seven_day`) — header analogue of `limits[].is_active` |
| `…-5h-*` / `…-7d-*` | per-window status / **fractional** utilization (0.03 = 3%) / epoch-seconds reset |
| `…-fallback` | conditional — `available` appears when a window's utilization exceeds the fallback threshold (observed at 5h 0.78); Anthropic's hint that the client should consider failing over |
| `…-fallback-percentage` | the fallback trip point (0.5 on both accounts) — consistent with `fallback` appearing once utilization crosses it |
| `…-overage-status` / `…-overage-disabled-reason` | extra-usage credits admit state — `org_level_disabled` (feature off, main) vs `org_spend_cap_reached` (credits exhausted, work-alt) |
| `…-overage-utilization` / `…-overage-surpassed-threshold` / `…-overage-reset` | conditional — only once credits are consumed: fraction used (1.0), threshold crossed, epoch-seconds reset of the credit window |

### Differences vs the usage API

1. **No scoped per-model windows** — Fable/haiku carve-outs exist only in `limits[]`. Scoped killswitch + prime's model-aware checks cannot run on headers alone.
2. **Passive** — idle fallback accounts emit nothing; pre-visibility requires the poll.
3. **Coarser numbers** — fraction (2 decimals) vs integer percent; no severity, no dollars, no extra-usage detail beyond admit state.
4. **Free freshness** — every real request refreshes main's 5h/7d at zero API cost.

### Comparison with OpenAI/Codex (`x-codex-*`)

| | Anthropic | OpenAI/Codex |
| --- | --- | --- |
| Passive headers | `anthropic-ratelimit-unified-*` (5h/7d + overage) | `x-codex-primary/secondary-*` (5h/weekly) |
| Active poll endpoint | `GET /api/oauth/usage` (rich: scoped, severity, spend) | **none** — headers are the only quota surface |
| Scoped per-model windows | `limits[]` `weekly_scoped` | n/a |
| Representative/binding marker | `representative-claim` header + `is_active` (inferred) | `x-codex-…-over-…` style flags |

openai-auth is push-based by necessity (QuotaManager fed via `setMain`/`setFallback`); anthropic-auth combines the usage poll with passive header pushes on direct and relayed requests.

---

## Surface 3 — profile API (account kind)

```
GET https://api.anthropic.com/api/oauth/profile
authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Identity + plan metadata; the only surface exposing account KIND. Observed key fields:

| Field | main | work-alt | Notes |
| --- | --- | --- | --- |
| `account.has_claude_max` | `true` | `false` | personal-plan flag only — false for Team seats |
| `organization.organization_type` | `claude_max` | `claude_team` | the account-kind discriminator |
| `organization.rate_limit_tier` | `default_claude_max_20x` | `default_claude_max_5x` | **quota multiplier tier** — a Team tier-1 seat gets Max-5x-equivalent limits |
| `organization.seat_tier` | `null` | `team_tier_1` | Team seat level |
| `organization.has_extra_usage_enabled` | `false` | `true` | matches `extra_usage.is_enabled` in the usage API + `overage-*` headers |
| `organization.billing_type` | `stripe_subscription` | `stripe_subscription` | |
| `application.slug` | `claude-code` | `claude-code` | OAuth app identity |

Also returned: account/org uuids, email, subscription status/created, `enabled_plugins`. The plugin stores only `organization_type`, `rate_limit_tier`, the check time, and an access-token fingerprint. Profile reads run from boot/background sidebar hydration and quota/account display paths at most once per account per process, persist in the sidecar, and reuse matching-token results for seven days. Model request dispatch does not call the profile endpoint.

## Implemented behavior

- Direct and relayed `/v1/messages` responses harvest the unified 5h and 7d windows. Utilization fractions are multiplied by 100, then rounded; reset values are epoch seconds converted to ISO timestamps.
- Header pushes merge into the last poll snapshot. They preserve poll-owned `scoped`, including meaningful empty `[]`, and `extraUsage` credit data.
- Poll `limits[].is_active` owns `bindingWindow` when present. The header `representative-claim` fills the marker only when the poll did not supply one.
- Money stays in integer minor units with an explicit currency exponent. Formatting happens at the display boundary.
- `fallback: available` becomes `fallbackAdvised`; it appears only in expanded quota views and does not change routing.
- Profile metadata is sidecar-persisted, uses a seven-day TTL, and is absent from the request path.
- Relay HTTP harvest reads the Worker's genuine upstream response headers only when the relay handled the request. WebSocket harvest reads the genuine `response_start` headers through a callback even when the caller already received an optimistic response with synthetic headers. Relay-to-direct fallback remains owned by the direct-path harvest, so one upstream response produces one push.

## Gaps / opportunities

- Pi has a separate streaming response path and does not harvest quota headers in v1.

## Probe recipes

```bash
# usage API (token from opencode auth.json for main, anthropic-auth-state.json for fallbacks)
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "authorization: Bearer $TOKEN" -H "anthropic-beta: oauth-2025-04-20" | jq .

# headers (one minimal Haiku request; usage is measured from response accounting)
curl -sD - -o /dev/null https://api.anthropic.com/v1/messages?beta=true \
  -H "authorization: Bearer $TOKEN" -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: oauth-2025-04-20" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":1,"system":"Reply with 1 when you receive 0.","messages":[{"role":"user","content":"0"}]}' \
  | grep -i anthropic-ratelimit
```

Gotcha: fallback tokens in `anthropic-auth.json` (config) go stale — current tokens live in `anthropic-auth-state.json` (memory: two-file store; state holds runtime).
