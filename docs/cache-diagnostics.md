# Cache diagnostics

## Measure-only beta

The Anthropic API opt-in `cache-diagnosis-2026-04-07` (sent in the `anthropic-beta` header) asks for cache diagnostics; it does not change cache controls or routing. OpenCode 1 and 2 capture the response's opaque top-level message ID and send it as `diagnostics.previous_message_id` on the next eligible request in that session. The first eligible request sends `null`.

Keep-warm requests on OpenCode do not opt in to cache diagnostics or change the previous-message ID. In older OpenCode 1 logs, `prewarm_cachekeep` identifies a keep-warm response.

`MC-CACHE-DIAG ` records and the beta-list side channel are emitted only at debug level. Choose **Logging level** → `debug` in `/claude` → **Diagnostics**. An empty stream can mean no activity or a lower log level: compare it with an independent activity witness such as usage rows, billing or dumps before drawing conclusions.

## Version 2 record

Each record is one JSON line after the exact prefix `MC-CACHE-DIAG `, including its trailing space.

| Field | Meaning |
| --- | --- |
| `v` | Schema version `2` |
| `source` | Observation path; known values `turn`, `start`, `prewarm_cachekeep`; tolerate future values |
| `synthetic` | Whether plugin machinery generated the observation |
| `account_id` | Opaque persisted routing/account identifier; do not validate its string shape |
| `betas_hash` | 16-character lowercase xxHash64 (seed 0) of the sorted sent beta list |
| `requested_model` | Optional sent model, only when different from the response model |
| `session_id` | OpenCode session affinity |
| `ts_ms_received` | Integer local receipt time |
| `model` | Anthropic response model |
| `is_subagent` | Original request context |
| `ttl_sent` | Last valid sent cache breakpoint: `1h`, `5m` or JSON null |
| `cache_read` | `usage.cache_read_input_tokens` |
| `cache_creation` | `usage.cache_creation_input_tokens` |
| `input_tokens` | `usage.input_tokens` |
| `ephemeral_5m_tokens`, `ephemeral_1h_tokens` | The corresponding `usage.cache_creation` counters |
| `message_id` | Response top-level `id` |
| `previous_message_id` | Sent previous ID or JSON null |
| `diag_state` | `absent`, `server_null`, `pending` or `populated`; always a string |
| `miss_reason` | Optional `diagnostics.cache_miss_reason.type` |
| `cache_missed_input_tokens` | Optional provider miss magnitude; not a usage token count |

Required usage counters must be finite and nonnegative. A malformed required counter rejects the whole record. Only valid message envelopes produce records; errors or malformed responses do not become `absent` diagnostics.

Known sources map to `synthetic` as follows: `turn` → false, `start` → true, `prewarm_cachekeep` → true. Lane-start observations use `start`. On disagreement the supplied `synthetic` wins, a warning is emitted, and the record is retained. Unknown sources must not be rejected. Version 1 cannot distinguish turns from prewarms retroactively; version 2 states the source.

The first observation of a beta hash in a process also emits `MC-CACHE-DIAG-BETAS {"hash":"…","betas":[…]}` with the sorted list. Count records using `MC-CACHE-DIAG `, not `MC-CACHE-DIAG`: the latter also matches beta side-channel lines.

## Interpreting results

| `diag_state` | Response shape |
| --- | --- |
| `absent` | No `diagnostics` property |
| `server_null` | `diagnostics: null` |
| `pending` | `diagnostics.cache_miss_reason: null` |
| `populated` | Object reason with a nonempty string `type`, including `unavailable` |

Check `cache_read` before `miss_reason`: a positive cache read is an observed fact, while a reason is an interpretation. An appended turn can have a `*_changed` reason and still read the full earlier prefix. Do not subtract `cache_missed_input_tokens` from usage: it is a byte-derived pre-tokenization magnitude and can exceed `input_tokens`.

Diagnostics are scoped to the provider's cache fingerprint, organization and workspace. Prompt-affecting changes, including beta-header changes for structured output, can produce `unavailable`; fingerprints also expire. Requests below the cacheable minimum or without breakpoints can return `diagnostics: null` despite real changes. Gate interpretation on independent observed cache activity. These records do not guarantee hits.

A short-gap `previous_message_not_found` reason is also captured as a canary when the previous ID was received less than five minutes earlier.

## Dumps and history analysis

When dumps are enabled, `.response.json` holds status and parsed response metadata without response content. Lane-start filenames include `-start-`; CacheKeep uses `-prewarm-cachekeep-`. Treat related request bodies as sensitive local data. See [dump handling](transports.md#diagnostics-and-dumps) and [the OpenCode history analyzer](cache.md#diagnostics-and-history-analysis) for retrospective estimates.

Implementation: [schema and record validation](../packages/core/src/cache-diagnostics.ts), emission in [OpenCode 1](../packages/opencode/src/index.ts) and [OpenCode 2](../packages/opencode/src/v2/wire.ts), and [wire opt-in](../packages/opencode/src/transform.ts).
