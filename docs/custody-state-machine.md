# Custody state machine: global `claustrum` | `local` mode with main-account takeover

Design record for PR #196 (rework). This file is the artefact that gates implementation of the
mode transition; the PR comment stream (Rev 1, Rev 2, three addenda) is superseded by it. The
reasoning is kept in-tree because a diff will not carry it and every row here was paid for by a
ruling or an incident.

Status: **implementation baseline** (maintainer, 2026-09-05 06:04Z, PR #196). This document is the
baseline for the implementation pass; the maintainer reviews the result and owns final integration
and remaining corrections. The go-ahead is permission to build, **not** approval to merge or to
activate takeover against live credentials; no live migration or release is authorised by it. Three
constraints bind the implementation (§13). The branch still carries the superseded per-account
toggle, which will not be merged as-is.

## 1. Scope and vocabulary

Two global modes, persisted in `anthropic-auth.json`:

- `local` (default): the plugin refreshes and serves OAuth credentials from OpenCode's `auth.json`
  (main) and its own sidecar (fallbacks). No vault calls are made in this mode.
- `claustrum`: every OAuth route, **main included**, is served from the Claustrum vault through a
  handle-manifest binding. The vault is the sole refresher of every bound family.

Commands are exactly `/claude-account claustrum`, `/claude-account local`, and bare
`/claude-account` for status. There is no per-account custody toggle, no `claustrum.enabled`
flag, and no `on|off` synonym. Account membership is decided by the handle manifest, not by
configuration. API-key routes are out of scope and unaffected in both modes.

**Mode records intent; credential state proves servability.** `mode=claustrum` licenses the
takeover barrier and the custody serving path. It never by itself makes an account servable, and
a per-account verdict never by itself changes the mode.

## 2. The tombstone: one write set, one classifier, one wider refusal

Main's slot in `auth.json` cannot be empty: OpenCode runs a plugin's `auth.loader` only when a
stored entry exists (`provider/provider.ts:1604-1619`, `if (!stored) continue`), and an entry
that fails the `Info` decode is silently filtered by `Auth.all()` (`auth/index.ts:56-67`). An
absent or malformed slot therefore means **our request path does not exist**: no loader, no fetch
hook, no custody. Under `claustrum` the slot holds a non-secret tombstone whose only job is to
make the loader run.

### 2.1 WRITE set (production writes exactly this, nothing else)

```json
{ "type": "oauth", "access": "", "refresh": "claustrum-tombstone:v1:anthropic", "expires": 0 }
```

`access` is **empty**, and that is load-bearing, not cosmetic. OpenCode's `Info` schema is
`access: Schema.String` with no non-empty constraint, so the slot decodes and the loader runs
(verified live on 1.18.26 by the maintainer, reproduced on `openai`). Claustrum's deployed sealer
runs a shape gate that **aborts on empty access but accepts sentinel access**; an empty-access
tombstone therefore fails vault import by construction, independently of Claustrum's
reserved-prefix refusal (#28). Anything that later "tidies" this to carry a descriptive `access`
value silently re-arms the destructive import path. The constant carries this comment.

### 2.2 RECOGNISE (classifier: "is this MY provider's tombstone?")

```
auth.type === 'oauth' && auth.refresh === custodyTombstoneKey(provider)
```

`access` and `expires` are **not** conjuncts. Once the exact provider-scoped sentinel is present in
`refresh`, a different `access`/`expires` is a partial write or corrupt state that must still enter
the custody path, never approach local refresh. Every extra conjunct is another way to *miss*, and a
miss falls through to a wrong-state boot: the loader does not refuse, `mainAccountId` is minted,
quota-identity resolution runs its compat substitution, and the background refresh loop starts
before the exchange-level guard finally throws. A spurious match merely refuses to serve.

Both artefact shapes are pinned by tests: the empty-access shape production writes, and the
sentinel-access shape Claustrum's vendored golden encodes (legacy). A golden-only test is green
about a shape production never writes.

### 2.3 REFUSE (barrier: "is this tombstone material at all?")

Prefix-wide, at the last point before the irreversible act, on the **value committed** rather than
the record it came from:

- token exchange: `assertNotCustodyTombstone` is the first statement of `refreshClaudeOAuthToken`,
  keyed on `refresh.startsWith(CUSTODY_TOMBSTONE_PREFIX)`, before any `URLSearchParams` is built;
- send boundary: the bearer value is checked for the prefix before header construction.

These deliberately do **not** share a predicate with §2.2. Recognition is exact so a foreign
provider's tombstone is not adopted as ours; refusal is wide so a foreign provider's tombstone can
never reach Anthropic's token endpoint. Two reviewers on two plugins independently reached to merge
them in one afternoon; the merge would have narrowed the barrier to the classifier, which is the
same failure as having no barrier.

**Containment invariant, pinned by one test:** `refusal ⊋ recognition`. Every shape recognised at
the loader is refused at the exchange and the send boundary; the witness for strictness is a
**foreign-provider** tombstone (`claustrum-tombstone:v1:openai`), which recognition answers *no*
and refusal answers *yes*. A same-provider witness cannot distinguish the two predicates and so
cannot protect the split.

## 3. Axes

Evaluated independently for main and for **each enabled OAuth fallback**.

| axis | values | notes |
|---|---|---|
| `mode` | `local` · `claustrum` | global, durable; the only global write in the barrier |
| `binding` | `VALID` · `INVALID` · `ABSENT` | the account's entry `{label, handle, credentialId}` in our provider block of the shared handle manifest. `INVALID` = entry present, handle or credentialId fails validation `VALID` = a RESOLVED binding from the resolver, whichever source it came from: a manifest entry, or (transitionally, for the migration window and the crash-left / unreadable-manifest case) a plugin-written sidecar handle. Source is provenance, not authorization; the resolver owns the binding decision and startup migration converges sidecar handles into the manifest. What membership-by-manifest retires is the per-account *config flag* as an authority, not sidecar-held bindings. |
| `local` | `REAL` · `INERT` · `GONE` | main: `REAL` = usable material, `INERT` = recognise-set tombstone, `GONE` = slot absent **as observed through the SDK**. An unparseable main slot is unobservable: `Auth.all()` runs `Record.filterMap(decode)` (`auth/index.ts:65-66`), so a slot failing the `Info` schema reads as `undefined` and any later host write rewrites the file without it; for main, `GONE ≡ SLOT_ABSENT`. Fallback: `REAL` = usable refresh material, `INERT` = refresh material absent, row otherwise valid, `GONE` = `ROW_UNPARSEABLE` (our own store, so the distinction survives there; a row that is *absent* while a binding exists is the discovery operation, §7, not a coordinate) |
| `vault` | `USABLE` · `COLD` · `REAUTH` · `N/A` | resolved through the binding's handle. `COLD` = daemon unreachable or credential not resident (transient). `REAUTH` = record latched `needs_reauth`. `N/A` ⇔ `binding ∈ {ABSENT, INVALID}` |

Two facts about `GONE` for main, both from OpenCode source (`339536bc22`), change what it means:

- an absent slot never reaches `auth.loader`, so any reconciliation that must observe main's slot
  before the loader runs lives in the **plugin factory**, which is invoked during the first
  Provider-state construction via `plugin.list()` (`provider.ts:1436`) but **before** the provider
  reaches `auth.all()` and the loader pass (`:1591-1622`). An awaited write from the factory would be
  visible to the first loader; the plugin currently issues no such write (§5, C9).
- today `normalizeAccount` null-drops an unparseable fallback row and `Auth.all()` hides an absent
  or malformed slot. Reconciliation reads **raw** rows and slots so `GONE` is surfaced, and a `GONE`
  fallback's state secrets are **retained**, never pruned, never normalised into success.

## 4. Fences (three, never combined)

| fence | compares | when | effect |
|---|---|---|---|
| **RECORD_VERSION** | the `record_version` captured from the resolution that served *this* request's token, passed unchanged to `report_auth_failure` for *this* response | per request, on a 401 | provenance only. **Never** a startup coordinate, never affects availability. `record_version` is `expected_version + 1` on every vault `commit_refresh` (`store.rs:1931-1951`); an earlier draft that compared it at startup would have made an account unavailable every time the vault did its job |
| **IDENTITY** | vault `account_id` from `credential.get` **vs** the row's persisted `anthropicAccountUuid` | startup reconcile and each custody tick, only when `vault=USABLE` | **both present and unequal → `MISMATCH`** (refuse serve, no writes, surfaced). **Either absent → `UNLABELLED`**: serve; absence is not difference. The request-time bootstrap of the served token performs the same comparison per request and is the authoritative one (§4.1) |
| **PRE-COMMIT FINGERPRINT** | `sha256(len(access) ‖ access ‖ len(refresh) ‖ refresh)` of each account's local material as read inside the barrier's fences | persisted with the mode write; consulted by `RESUME_TAKEOVER` | **crash reconciliation only.** Distinguishes crash-left pre-commit material (fingerprint matches → resume) from material that changed after the barrier read (differs → `NEW_LOCAL_FAMILY_UNDER_CLAUSTRUM`, §5), because content alone cannot tell the two apart and the in-process login record does not survive the restart that the crash case is. **It does not make the host write safe** (§12.1): OpenCode's `Auth.set` sits outside every lock we hold, and a re-read immediately before `client.auth.set` is still check-then-write |

`credentialId` is **not** a startup comparand: `credential.get` returns `payload`, `expires_at_ms`,
`record_version`, `project_id?`, `account_id?`, `email?`, `org_name?` and **no credential id**
(`claustrum/crates/credentials-module/src/read_surface.rs:272-303`; the Rust source states
`account_id` is neither the credential id nor the handle). `credentialId` is the join key for the
quota feed and operator tooling only.

### 4.1 Identity provenance (Anthropic-specific; a port must not copy it)

On the vault side `account_id = account_id_for_adapter(adapter, token).or_else(stored identity)`
(`read_surface.rs:849-858`), and the live parse derives only for `openai`. For Anthropic the vault's
`account_id` is therefore the **operator-asserted** `ck auth set-identity` label, while our
request-time bootstrap of the served token is **provider-asserted**. The startup IDENTITY check
catches a swapped or mislabelled record; only the request-time check catches a label that is itself
wrong. Both yield `MISMATCH`; the request-time one is authoritative. For OpenAI the precedence
inverts (token claim wins; the vault's write sink refuses a contradicting label).

Fingerprint covers both tokens, length-prefixed. Between the barrier's read and its commit, local
refresh is inert (binding), OpenCode has no Anthropic refresh loop, Anthropic never rotates access
without refresh, and a host login writes a whole new family; so refresh-only and both-tokens are
equivalent in the true-positive direction. They differ on a torn `Auth.set` (new access, old
refresh): both-tokens refuses, refresh-only tombstones an access token that is dead without its
family. Same safety; both-tokens removes an assumption about the atomicity of a file we do not own.

## 5. `mode = claustrum`

Per account. `serve` is from the vault where it says `vault`; local material is **never** served in
this mode. Local refresh is inert wherever a binding exists (`VALID` or `INVALID`), independent of
vault reachability: a valid binding means the vault owns that family, and a cold daemon is not
evidence to the contrary. A corrupt binding must not silently re-enable a local refresher on a
vault-owned family.

| # | binding | local | vault | verdict | serve | local refresh | durable writes | retry | operator |
|---|---|---|---|---|---|---|---|---|---|
| C1 | VALID | INERT | USABLE | `CUSTODY_SERVE` | vault | inert | none | — | none |
| C2 | VALID | REAL, fingerprint **matches** | USABLE | fallback: `RESUME_TAKEOVER` · main: `TAKEOVER_INCOMPLETE_MAIN_REAL` (§13.1) | fallback: vault, after its commit · main: **no** | inert | fallback → drop refresh material under its lock · main → **none** | fallback: immediate · main: none | main: `ck auth migrate-plugin --allow-main` |
| C2′ | VALID | REAL, fingerprint **differs or absent** | any | `NEW_LOCAL_FAMILY_UNDER_CLAUSTRUM` | **no** | inert | **none** | none | **unresolved** (§12.2): `ck auth migrate-plugin --replace` then re-enter is consistent with every rule; "exit to `local` and the login stands" is not |
| C3 | VALID | INERT | COLD | `CUSTODY_UNAVAILABLE` | **no** (typed provider-unavailable) | inert | none | bounded custody retry on vault availability | none |
| C3′ | VALID | REAL | COLD | `TAKEOVER_INCOMPLETE_VAULT_UNAVAILABLE` | **no** | inert | **none**: no rollback, no drop. The destructive commit waits for `USABLE` (→ C2) because dropping material without proof the vault holds the family is destruction without evidence | on vault availability | none required; `local` + re-login only to abandon custody |
| C4 | VALID | any | REAUTH | `CUSTODY_CREDENTIAL_LATCHED` | **no** | inert | none | **none**: retry cannot fix a latched record | re-import into the vault; resumes without a mode change |
| C5 | VALID | any | USABLE ∧ IDENTITY mismatch | `CUSTODY_IDENTITY_MISMATCH` | **no** | inert | none | none | `set-identity` or re-bind; a different account may sit behind this handle |
| C6 | ABSENT | REAL | N/A | `NOT_ENROLLED` | **no** | **no** (this mode has no local refreshers) | none | none | `ck auth bind` after import, or `local` |
| C7 | ABSENT | INERT | N/A | `ORPHAN_TOMBSTONE` (main) / `ORPHAN_INERT` (fallback) | **no** | nothing to refresh | none | none | `bind`, or `local` + re-login |
| C8 | INVALID | any | N/A | `CORRUPT_BINDING` | **no** | **inert** | **none**: never auto-repair a manifest entry | none | `ck auth bind --replace`, or `local` |
| C9 | VALID | GONE (main) | USABLE · COLD · REAUTH | `TAKEOVER_INCOMPLETE_SLOT_ABSENT` | **no** | inert | **none** (plugin-side install into an absent slot is **withdrawn**, see below) | next boot | `ck auth migrate-plugin` restores the slot; or the host, once a fenced write exists |
| C10 | VALID | GONE (fallback = `ROW_UNPARSEABLE`) | any | `CORRUPT_ROW` | **no** | inert | **none**; state secrets retained | next reconcile | repair the row, or remove + re-discover |

Invariants pinning the combinations not rowed:

- `vault = N/A ⇔ binding ∈ {ABSENT, INVALID}`; a `VALID` binding always resolves to one of
  `USABLE | COLD | REAUTH`. Test: every `VALID` fixture produces a connector call; no `ABSENT`/`INVALID`
  fixture does.
- `binding = ABSENT ∧ local = GONE` for main is not a custody state: with no binding there is nothing
  to restore, so the slot stays as found and OpenCode's own not-logged-in applies (no install without
  a binding: that would fabricate custody).
- The recognise-set (§2.2) makes "partial tombstone write" a tombstone for every verdict; there is
  no separate local-axis value for it.
- **C9 no longer installs.** An earlier revision restored the tombstone into an absent slot so the
  loader would run and a typed verdict could exist. That write is withdrawn: with no lock, no CAS, a
  non-atomic host write, and the torn-read amplifier (§12.1), an install into an "absent" slot is
  the highest-blast-radius write this plugin could issue (it can wipe every provider's credentials),
  and its payoff was a typed verdict in place of the host's generic not-logged-in. The absent slot is
  named in status and restored by `ck auth migrate-plugin` or by the host once a fenced write lands
  (#46128). Two rules bind **any** host-slot write the plugin ever issues: (1) read
  `client.auth.all()` first and, if it is EMPTY, abort the write, warn once, retry next tick, since an
  empty map on a machine with any configured provider is a torn read until proven otherwise; (2)
  treat a slot as absent only after two reads at least 250 ms apart, both `undefined`, both with a
  NON-EMPTY `all()`. The install-on-`MISMATCH` divergence from the openai-auth port (§10) is moot
  while no install exists.

## 6. `mode = local`

No vault call is made in this mode (test: zero connector invocations under `mode=local`). The
`vault` axis is not consulted.

| # | binding | local | verdict | serve | local refresh | durable writes | operator |
|---|---|---|---|---|---|---|---|
| L1 | ABSENT | REAL | `LOCAL_SERVE` | local | yes | none | none |
| L2 | ABSENT | GONE | `DARK_PENDING_LOGIN` | no | no | none | `/login` |
| L3 | ABSENT | INERT | `AWAITING_LOGIN` | no | nothing to refresh | none | `/login`. **Expected**: this is the post-`/claude-account local` state before re-login |
| L4 | VALID | INERT · GONE | `AWAITING_LOGIN` with a lingering binding (exit ran; the clear did not land or was never reached) | no | inert (binding) | none | `/login`; the verified login clears the binding (§7) |
| L5 | VALID | REAL | `DARK_PENDING_VERIFIED_LOGIN` | **no** | inert (binding) | none | `/login` through our own path |
| L6 | INVALID | any | `CORRUPT_BINDING` | no | **no** | none | repair or remove the entry |

**L5 is the row the verified-login ruling creates.** Real material alongside a live binding means
material appeared without a login through our path: a restored backup, a hand-edit, a copied file.
"Material exists" is satisfiable by a restore and so cannot be the clearing signal; the binding keeps
refresh inert and the account stays dark until a real login clears it.

## 7. The takeover barrier (`/claude-account claustrum`)

An **all-accounts readiness barrier**, not an atomic commit: the writes span `auth.json`, the sidecar,
and the manifest, and cannot be made kill-atomic. The barrier makes every crash-visible intermediate
a state with a named verdict (§5) and a resume path.

0. Acquire, in this fixed total order: config write lock → cross-tenant manifest lock → per-account
   refresh locks (main, then fallbacks by sorted id). Hold all through step 4. Deadlock-free by total
   order; the manifest lock's TTL/renewal covers the awaited host write.
1. **Inside** the locks: capture each account's custody generation; re-read the manifest, the raw
   account rows, and the raw auth slot; compute each account's PRE-COMMIT FINGERPRINT. Any preflight
   computed before this point is advisory and discarded (stale by construction under concurrency).
2. Classify every enabled OAuth account as C1 or C2-eligible (VALID binding, USABLE vault, IDENTITY
   not mismatched) while fenced. Any other class → release, **zero writes**, typed refusal naming the
   first failing account and its class.
3. Persist `mode=claustrum` **and** the per-account fingerprints in one config write (config lock
   held). This is the barrier's durable marker and the only global write. Mode-first: a tombstone
   never coexists with `mode=local` during a normal commit, so observing that pair is evidence of
   tampering rather than an expected intermediate, and it is what makes `RESUME_TAKEOVER` possible
   at all (under mode-last every intermediate is indistinguishable from a hand-written tombstone).
4. Idempotent per-account commits, fallbacks only. Fallback → drop local refresh material (no-op
   if absent); fallback rows live under our own locks, so this half is fenced. Main → **no write**
   (§13.1): the slot must already satisfy the recognise-set at step 2 or the barrier refused before
   step 3. (A plugin-side `client.auth.set(WRITE set)` would not be fenced against the host,
   §12.1; a fingerprint re-read immediately before it narrows the window without closing it.)
5. Any failure after step 3: retain the mode, keep **all** local refresh inert (the binding alone
   inerts it, mode-independent), release, surface. The next reconcile resumes **only** incomplete
   accounts (C2), under their own locks; it never re-runs a transition for accounts already in C1.

Against other processes: enable/disable and **our** login path take the config lock, so they
serialise with steps 0–4; other tenants' manifest writes take the cross-tenant lock, so they
serialise too; a generation bump observed at step 4 aborts **that** account's commit only, the others
proceed, and resume covers it. The host's `Auth.set` serialises with nothing we hold (§12.1).

Serving is per-account and independent of the barrier: main may serve from the vault while a
fallback sits in C3, and the reverse. Nothing about serving account A depends on account B, so no
aggregate state exists.

## 8. Operation transitions

| operation | mode | precondition | effect | fence |
|---|---|---|---|---|
| `/claude-account claustrum` | local | barrier §7 | mode + fingerprints, then per-account commits | §7 |
| `/claude-account local` | claustrum | — | `mode=local` only. **No material writes, no manifest writes.** Bindings stay; every bound account becomes L4/L5 and stays dark until a verified login clears it. A transient inability to prove vault state never transfers refresh authority back to local; abandoning custody is this explicit command plus re-login | config lock |
| local login (`Claude Pro/Max` authorize) | claustrum | — | **refused before the browser opens or anything is written**: `Exit Claustrum mode first: /claude-account local` | none needed |
| verified login | local | login completed through **our** OAuth path (in-process record) **∧** real material observed via the live `getAuth` re-read | commit the new family, **then** clear that account's binding, both under config + manifest locks in one fence; bump the generation → L1 | config + manifest locks |
| enable account | claustrum | binding VALID ∧ vault USABLE ∧ IDENTITY not mismatched (COLD is a typed refusal, not a wait) | `enabled=true` | config lock |
| enable account | local | — | `enabled=true` | config lock |
| disable | any | — | `enabled=false`; binding unchanged; vault material untouched | config lock |
| remove account | claustrum | — | row removed; **its** binding removed under the manifest lock; vault material **retained** (`ck auth` owns vault removal; the plugin never writes the vault) | config + manifest locks |
| add new OAuth account | claustrum | vault-side tooling created the credential **and** the binding in our provider block | reconcile **discovers** a VALID binding with no row → creates `{id: label, enabled: false, no refresh material, no identity}`, appended to the fallback order. INERT from birth: there is never a moment where a row exists, is enabled, and lacks a usable vault binding. **Discovery writes no identity**; the row binds `anthropicAccountUuid` from the first served token's bootstrap, never from the vault's operator-asserted label and never from a placeholder (a placeholder would `MISMATCH` the real claim forever) | config lock, manifest re-read inside it |
| manifest change (other tenant) racing the barrier | — | — | serialised by the cross-tenant lock; if it lands between steps 1 and 4 → generation bump → that account's commit aborts → resume | manifest lock + generation |
| enable/disable racing the barrier | — | — | serialised by the config lock | config lock |

**Adding a new account today.** No verb on Claustrum master writes our provider block
(`mint-handle` prints a handle; `migrate-opencode` writes an OpenCode-shaped entry even under
`--serve-by anthropic-auth`; `migrate-plugin --serve anthropic-auth` writes our block but takes a
plugin-**exported** file, so it migrates accounts we already hold). Two paths:

- direct, once it lands: `ck auth bind --serve anthropic-auth --label <label> --id <credential_id>`
  (scoped on the Claustrum side): mint → verify the handle resolves → write `{label, handle,
  credential_id}` under the cross-tenant lock → verify → **revoke the handle on any failure after
  mint**. Refuses an existing label without `--replace`; refuses a credential id outside the tenant's
  allowed prefix; never touches our account rows. Chosen over a plugin-side verb because a handle
  must never sit at rest between two commands when one can mint-and-persist with revoke-on-failure.
- interim (every step exists): `/claude-account local` → `/login` →
  `ck auth migrate-plugin --from <export> --replace` → `/claude-account claustrum`.

**Exit-edge dependency.** The verified-login clear requires the manifest writer (Slice 2,
`feat/custody-manifest`), which lands before this transition. It is plugin-side in the same phase.

**`OPENCODE_AUTH_CONTENT`.** `Auth.all()` short-circuits to that env payload when set, so the live
`getAuth` re-read can never observe a re-login and the binding would never clear: the exact
dark-account loop the exit edge exists to prevent. Reconciliation detects the variable and fails
loudly rather than degrading into it.

## 9. Verified facts this design rests on

| fact | source |
|---|---|
| `auth.loader` runs only for a stored slot; decode failures are filtered before it | OpenCode `339536bc22`: `provider/provider.ts:1604-1619`, `auth/index.ts:14-21, 56-67` |
| plugin factories run during first Provider-state construction, before the loader pass | `provider.ts:1396-1438, 1591-1622`, `plugin/index.ts:170-242` |
| login does **not** re-invoke `auth.loader`; `Auth.set` writes `auth.json` and emits nothing | `provider/auth.ts:188-221`, `auth/index.ts:73-80` |
| the `getAuth` handed to the loader is live: `get → all()` re-reads `auth.json` per call | `auth/index.ts:58-71` |
| `access: ""` decodes; the loader runs; the request reaches our fetch | maintainer probe on 1.18.26; `Info` schema `access: Schema.String` |
| Claustrum's deployed sealer aborts on empty access, accepts sentinel access | Claustrum, `digest()` run against all three shapes |
| #28 reserved-prefix refusal covers the OpenCode import entrance, **not** the write sink (`put --replace` still accepts a tombstone) | Claustrum master `decab7f`; sink guard is a follow-up |
| `credential.get` returns no credential id; `account_id` is neither credential id nor handle | `read_surface.rs:272-303` |
| `account_id` for Anthropic is the stored `set-identity` label (live parse derives only for `openai`) | `read_surface.rs:849-858`, `oauth_login.rs:533` |
| `record_version` advances on every `commit_refresh` | `store.rs:1931-1951`, `engine_tests.rs:418-427` |
| no Claustrum master verb writes our provider block | Claustrum master `decab7f`: `opencode_migration.rs:232, 628` |

## 10. Deliberate divergences from the openai-auth port

Both plugins hold the same contract (write set, recognise/refuse split, fences, barrier shape,
transition table). These differ on purpose and are stated so neither is read as an oversight:

1. ~~Install on `MISMATCH` for a GONE main slot~~ — moot: both ports have withdrawn plugin-side
   install into an absent slot (§5 invariants, §12.1). Converged.
2. **Fallback artefact under custody**: we **drop** refresh material (`INERT` = absent); they write
   tombstoned rows. One recognise rule covers both because it keys on the refresh sentinel only.
   Do not "harmonise" by adding the sentinel to our fallback rows: that imports a masquerade risk
   (a truthy sentinel in `access`) into a tree that currently cannot have it.
3. **Identity provenance** (§4.1): operator-asserted at the vault for us, provider-asserted for them.

## 11. Open items (external)

- Maintainer approval of §5–§8 (gates implementation of the transition).
- Claustrum: `ck auth bind` (§8); sink-level tombstone refusal (defence in depth, after the
  manifest-lock PR). The instrument re-point is **done and self-actuating** (2026-09-05 05:55Z):
  sealer and latch-watch read the tombstone predicate per tick, so nothing on that side is a
  flip-time action.
- **Operator runbook for this deployment (not a runtime dependency; §13.3):** (a) probe the
  **installed** `ck-auth` binary for the typed tombstone refusal **with a real-material positive
  control in the same run**, and assert zero audit-chain movement (an announcement is a trigger to
  run the probe, not evidence); (b) send the exact flip time (UTC + epoch) to the Claustrum seat
  **before** the write, and treat the handover as observed only when they return the `CUSTODY_MODE`
  edge from the sealer log and the `EXCLUDE_NOW ''` edge from latch-watch with timestamps. This is
  how this operator verifies the live flip; the command's own completion contract is §13.3.
- Manifest-lock contract: case-folding aliasing of nonces on case-insensitive volumes (raised with
  the contract owner, unruled).

## 12. Unresolved questions (design, not implementation)

These are open. The maintainer's ruling (2026-09-05) is that they need a source-backed answer before
any code; this section records them so they are not lost in the handoff.

### 12.1 The host-write race is not closed

Everything the barrier fences is ours: config, sidecar, manifest, per-account refresh locks.
`auth.json` is the host's, and OpenCode's `Auth.set` (the login callback,
`provider/auth.ts:188-221` → `auth/index.ts:73-80`) takes no lock we can share. So for main:

- a login can complete between the barrier's step 4 re-read and `client.auth.set`, and the fresh
  family is **overwritten by the tombstone**. Re-reading a matching fingerprint immediately before
  the write is still check-then-write; it shrinks the window to the width of one RPC, it does not
  remove it.
- restoring a tombstone into an absent slot (the former C9 install, now withdrawn) had the same race
  in the other direction, plus the torn-read amplifier below: a login can land in the "absent" slot
  between the factory's read and its write, and the read itself may have been torn.

The fingerprint is therefore **crash reconciliation only** (§4).

**Source of the race** (OpenCode `339536bc22`, `packages/opencode/src/auth/index.ts:73-89`):
`Auth.set` is `all()` → spread → `writeJson`. No lock, no compare-and-set, no expected-value check,
and the write itself is **not atomic**: `util/filesystem.ts:61-84` is an in-place `writeFile`, not
temp-and-rename, so a concurrent reader can observe a partial file. No write event exists, and the
loader is memoised init-once. There is nothing at the host to honour; the gap is tracked upstream as
[anomalyco/opencode#46128](https://github.com/anomalyco/opencode/issues/46128) ("auth.json writes
are unlocked whole-file rewrites", open). Consequences beyond our slot:

- it rewrites the **whole file**, so two concurrent `set`s on *different* keys are last-writer-wins.
  A tombstone write on `anthropic` can clobber a concurrent `openai` login and vice versa; any
  plugin that writes its slot during another plugin's login loses one of them. This is a property
  of the host's auth store, not of custody.
- a fresh login that lands in the window is **lost** if the tombstone overwrites it (ordering B).
  Whether that also kills the vault's family is **unverified for both providers**: coexisting
  lineages have been observed only for two *refreshes* of one grant, and a fresh login mints a
  *new grant*, a different operation; an earlier claim that OpenAI lineages survive a fresh login
  was withdrawn by its author on that basis. If a fresh login invalidates the prior lineage,
  ordering B leaves the account dark; if not, the cost is one re-login. The probe that settles it
  (refresh `R_old` once, complete a fresh login, refresh `R_old'` again) carries the hazard it
  measures on a vault-held account and is operator-gated. The fingerprint preserves the
  single-refresher invariant in both orderings; only losslessness differs. Either way the
  transition stays blocked (§13.1).
- **the torn-read amplifier turns a lost race into a wiped store.** `Auth.all()` is
  `readJson(file).pipe(Effect.orElseSucceed(() => ({})))` (`auth/index.ts:65`) over a non-atomic
  writer, so a read racing another writer's in-place `writeFile` can parse a truncated file and
  yield an **empty auth map**. Two consequences: (i) a single `client.auth.get(key) === undefined`
  is not evidence the slot is absent, it may be a torn read; (ii) any `Auth.set` issued from that
  state spreads `{}` and rewrites `auth.json` containing **only the writer's key**, destroying every
  other provider's credentials. A plugin that installs into an "absent" slot during another
  plugin's login can wipe the store, not merely lose the race.
- **`OPENCODE_AUTH_CONTENT` is a deterministic clobber, not a race.** A child process started with
  that variable (`workspace.ts:532-533`) reads auth from the env snapshot in preference to the file
  (`auth/index.ts:59-61`), and every `Auth.set` it performs rewrites the file from that snapshot,
  restoring pre-tombstone material for the child's whole lifetime. This is a **checkable
  precondition** (scan `/proc/*/environ` for the variable before the transition), which is what §8's
  "fail loudly" concretely means.

**Mitigations that do not need a host primitive** (candidates; none closes the cross-process case):
(1) a process-local mutex shared by the barrier and every plugin-owned login entry, the login
holding it until a `client.auth.get` readback observes the host's write, which closes the
same-process race because both sides are our code; (2) a post-write readback after each tombstone
write, so ordering A is detected in the same run rather than on the next boot; (3) the cross-process
residual (a login in another OpenCode window) **declared** in the transition's confirmation text,
never hidden; (4) a **convergent write** for the main-slot install, proposed by the Claustrum seat on
the #196 thread and buildable inside `ck auth migrate-plugin --allow-main` where the imported bytes
are already in hand: import first → write the tombstone → settle → re-read; a slot **byte-equal to
the imported material** means a clobber by an env-snapshot child (rewrite, bounded retries), while
**different real material** means a newer family landed (refuse loud, never overwrite). The residual
is detected, bounded, and loud, which is the most a host without a fence can give. Whether that
satisfies §13.1's "source-backed synchronisation" is the maintainer's call.

**What closes it** is small and belongs in OpenCode: a per-key compare-and-set,
`Auth.set(key, info, { expect })` rejecting when `current[key] ≠ expect`, or an advisory lock that
`set`/`remove` take. Not filed; a change to a third-party repo is the operator's and maintainer's
call.

### 12.2 A raced login versus "bindings clear only after verified login"

C2′ (`NEW_LOCAL_FAMILY_UNDER_CLAUSTRUM`) describes real material under custody that the barrier did
not classify: most plausibly a login that raced the transition. An earlier draft offered "exit to
`local`; the login stands" as one operator resolution. That contradicts §6/§8: the raced login did
not complete through **our** path with an in-process record, so under `local` it is L5
(`DARK_PENDING_VERIFIED_LOGIN`), not L1, and its binding does not clear. Either the verified-login
rule admits some evidence other than our in-process record (and then what, and how is it
distinguished from a restored backup, which is the case the rule exists for), or a raced login is
never allowed to stand and the only resolution is a fresh vault import.

**Resolution proposed (strictness), for the maintainer's ruling:** a login that landed outside the
plugin's own path (raced, restored backup, another process) is **never** verified. It lands L5; its
binding never auto-clears; the only exits are the plugin's own in-process verified login (new
family, clears) or `ck auth`. The rule exists to reject restored backups, and a raced login is
indistinguishable from one by content, so it gets the same treatment. The openai-auth port adopted
this. One sub-question stays open: whether L5 **serves** its access token until expiry (no refresh,
which still satisfies §13.2) or refuses as the table currently says; both are consistent with the
rulings, and the difference is availability versus caution on a credential the vault may have
rotated.

### 12.3 Smaller

- `OPENCODE_AUTH_CONTENT` (§8) makes the live `getAuth` re-read blind; "fail loudly" is stated, the
  detection point is not.
- The `enable` precondition under `claustrum` requires `USABLE`; whether a `REAUTH`-latched account
  may be enabled-but-dark (so it resumes without a second operator action after re-import) is
  unstated.
## 13. Implementation constraints (binding, from the 06:04Z go-ahead)

1. **The host-write race stays open and the unsafe transition stays BLOCKED.** The main-slot
   write (`client.auth.set` of the tombstone, §7 step 4 main) is not fenced against OpenCode's
   `Auth.set`, and plugin-side restoration into an absent slot is withdrawn outright (C9, §12.1).
   **What the command does today, under the block:** the plugin issues **no** main-slot write at
   all. Main's tombstone is written by the operator-driven vault import
   (`ck auth migrate-plugin --allow-main`, the settled ownership of main import), and the barrier
   treats "main's slot already holds the recognise-set" as a **precondition**: at step 2, main
   classifies C1 only if the slot is already INERT; a REAL main slot is a typed refusal
   (`main is still local; run ck auth migrate-plugin --allow-main first`) issued **before** step 3,
   so no mode write and no fallback commit happens (the barrier is all-or-nothing readiness).
   Consequently C2 (`RESUME_TAKEOVER`) applies to **fallbacks only**; a REAL main under
   `mode=claustrum` is `TAKEOVER_INCOMPLETE_MAIN_REAL` (refuse, inert, no writes, same operator
   recovery). When a source-backed synchronisation lands, the plugin-side write can be added
   behind that same precondition without changing any verdict. The command does not describe the
   fingerprint as a fix and does not weaken the invariant so a test passes. The fallback half of the
   barrier (fenced by our own locks), the serving path, and every independent task proceed.
   Regression coverage must **demonstrate the exact interleaving** (a host write
   between our re-read and our write, for both the tombstone install and absent-slot restoration)
   and assert that the transition is blocked; a passing fingerprint-only test is not proof of
   safety and must not be presented as one.
2. **Returning to `local` never makes a surviving binding's material refreshable by itself.** A
   raced or restored local credential under a live binding stays inert until a login verified
   through our own path clears the binding (L4/L5). No wording anywhere says a raced login "stands".
3. **Production correctness is separate from local operational observation.** The Claustrum-seat
   steps in §11 (sending a flip time, receiving sealer/latch-watch log edges) are an **operator
   runbook** for this deployment, not a runtime dependency of the command and not part of its
   completion contract. Completion is machine-checkable inside the plugin and, under §13.1,
   contains no plugin write to main's slot: for **main**, the slot re-reads as the recognise-set
   (the precondition, verified, not a write of ours); for each **fallback**, its local refresh
   material re-reads as absent (our write); for every account, `credential.get` through the binding
   succeeds, status reports `CUSTODY_SERVE`, and zero local refresh attempts are observed.

Regression coverage required by the go-ahead: host-write interleaving (blocked, both directions),
crash/resume, concurrent mode changes, verified-login binding clearance.
