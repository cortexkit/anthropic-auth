# Anthropic credential custody

This document describes how OpenCode and Pi decide where Claude credentials come from, and what each setup step may change. It describes the native account release; earlier releases used per-host sidecar credentials and are not covered here.

## Authority

Each host has its own Claustrum enrollment record: a token file and a ceremony state file beside it (`<host>-enrollment.json` and `<host>-enrollment-state.json`). In this document a *host* is OpenCode or Pi, and Claustrum is a local credential-vault service. The enrollment record, not account settings, decides whether the host uses its local account pool or the Claustrum vault. Each enrollment has a name, which Claustrum calls the consumer: `anthropic-auth-opencode` or `anthropic-auth-pi`. In the table, "for this host" means the state file names the host's own enrollment name:

| Token file | Ceremony state file | Authority |
| --- | --- | --- |
| absent | absent | `local`: the host's local account pool |
| absent | pending, denied or blocked request | `local`: the request never produced vault access |
| absent | approved, naming `anthropic-auth-<host>` | `claustrum`: vault authority is kept, but with no token the vault cannot authorize requests, so they refuse instead of falling back to local accounts |
| valid | absent, or well-formed for this host | `claustrum`: use vault authorization; requests require a grant to read Claude OAuth credentials in category `anthropic-native` |
| malformed | approved, naming `anthropic-auth-<host>` | `claustrum`, refusing as above |
| malformed | absent, or not approved | unreadable |
| any | malformed, unsafe, or naming a different enrollment name | unreadable |

The ceremony state file records the progress of the enrollment request; `approved` means the request was approved in Claustrum. A valid token file selects the vault even if setup was interrupted before it wrote the ceremony state file. **Disconnect from the vault** removes both files and returns the host to `local`. It refuses, and leaves both files in place, when the state file fails the safety checks (a symbolic link, another owner, or permissions wider than owner-only) or names a different enrollment name.

The record lives at `~/.local/state/cortexkit/anthropic-auth/<host>-enrollment.json` (under `$XDG_STATE_HOME` when set; on Windows `~` is `%USERPROFILE%`, see [paths on each OS](environment.md#paths-on-windows-macos-and-linux)), or at the path named by `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` or `PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`. OpenCode and Pi enroll independently, as `anthropic-auth-opencode` and `anthropic-auth-pi`, and can be disconnected or revoked independently.

An unreadable record never counts as local custody. Requests the plugin would serve refuse: in OpenCode 1, requests through an OAuth-typed Anthropic entry; in OpenCode 2, requests carrying the fixed, non-secret placeholder that the plugin's sign-in stores in OpenCode, which marks a request as one the plugin serves; in Pi, requests to the extension's provider. Local sign-in, local account changes and vault sign-in also refuse until the record is repaired or the host is disconnected. Ordinary API-key authentication that the plugin does not own passes through unchanged in every authority state.

## Storage

Each host keeps its files next to its old sidecar path (`~/.config/opencode/` for OpenCode, `~/.pi/agent/` for Pi, with `~` as `%USERPROFILE%` on Windows, or the directory of `OPENCODE_ANTHROPIC_AUTH_FILE` / `PI_ANTHROPIC_AUTH_FILE`):

| File | Role |
| --- | --- |
| `anthropic-auth.json`, `anthropic-auth-state.json` | Old sidecar files. Read once as the source for migration; not used afterwards. Their path also decides where the other files are created. |
| `anthropic-auth-pool.json`, `anthropic-auth-pool-state.json` | Local account pool: accounts, API-key routes and settings, and their private credential state. |
| `anthropic-auth-native-state.json`, `anthropic-auth-custody-roster.json` | Local runtime metadata. |
| `anthropic-auth-migration.json` | Migration journal. |
| `anthropic-auth-vault-settings.json`, `anthropic-auth-vault-store-state.json`, `anthropic-auth-vault-state.json`, `anthropic-auth-vault-roster.json`, `anthropic-auth-vault-routing-state.json` | Vault-mode settings, account metadata and session affinity (which account each session stays on), kept apart from every local file. |

The local pool is shared by every process of that host, including the `opencode-anthropic-auth` CLI for OpenCode. When setup configures both hosts, it refuses if any of their storage paths resolve to the same file, because two hosts writing one file would overwrite each other's accounts and state.

## Local custody

### Migration

`npx @cortexkit/opencode-anthropic-auth setup` without vault custody establishes local authority for each selected host. Setup is offline in the sense that every OpenCode, LiteCode and Pi process must be stopped; it can still use the network, for example for Claude sign-in. It rechecks that the processes are stopped before each write. OpenCode 2 alone uses [empty initialization](opencode-2.md#empty-initialization), without opening OpenCode 1 auth or a host database. OpenCode 1, `--opencode=both` and Pi use migration:

- imports the old sidecar's fallback OAuth accounts, API-key routes and settings into the local pool, and carries sticky routing assignments over;
- moves OpenCode's stored Claude OAuth login into the pool as the main account and leaves an inert placeholder in OpenCode's auth slot: a fixed, non-secret OAuth-shaped marker that is not a usable credential and only tells OpenCode to route Claude requests through the plugin. A stored OpenCode API key is left as it is;
- moves Pi's stored Anthropic OAuth login into the pool and removes it from Pi's auth file, only with explicit consent (`--remove-pi-auth` when running with `--yes`).

Request serving refuses until migration has committed. It never falls back to old host tokens.

An empty-init journal also authorizes local use. A later OpenCode 1 setup can import legacy accounts while that pool has no account data, preserving native preferences and gap-filling session pins without replacing native pins. Credentials, account rows or private account metadata make the pool populated; preferences and pins alone do not. A direct migration library call then refuses `pool-populated`. The setup CLI's OpenCode 1 callback instead skips import, leaves the separate login and legacy sidecars unchanged, and installs only a placeholder if the host slot is absent. Completed migration authority with account data is reused and never re-imported, and a later separate OAuth login is never overwritten. A completed authority with no account data, either empty-init or a retired legacy migration whose first OpenCode 1 setup found nothing to import, imports a later OpenCode 1 login on an explicit setup run with hosts stopped: the login moves into the pool before the host slot gets the placeholder, and the journal becomes a version-5 `legacy-import` record.

### Recovery with `setup --login`

Before importing a stored main OAuth login, migration uses the account UUID in the legacy main profile only when that profile's recorded access-token fingerprint matches the host login. It does not query Anthropic for identity. If that proof is missing, migration stops without changing credentials and reports:

```text
Stop OpenCode and Pi, then run npx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum. Existing credentials have not been changed.
```

For OpenCode 1 and Pi, `setup --login` runs a Claude sign-in during setup, requires the sign-in to resolve a Claude account UUID, establishes or reuses local authority, and stores that account as the main account in the local pool. The equivalent recovery command is `npx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum`. Generation-2-only setup [refuses `--login`](opencode-2.md#setup-login-and-host-selection). `--login` and `--claustrum` are separate choices; setup rejects them together with `Local sign-in and vault setup are two separate choices. Use --login or --claustrum, not both.`

### Local sign-in while running

- OpenCode 1: **Claude Pro/Max** saves the account into the local pool as main and stores only the inert placeholder (a fixed, non-secret marker, not a credential) in OpenCode.
- OpenCode 2: **Claude Pro / Max (native account pool)** saves the account into the local pool.
- Pi and both OpenCode versions: the `/claude` menu's **Start OAuth sign-in** and **Finish OAuth sign-in** add accounts to the pool.

All local sign-in paths refuse while the host is enrolled in the vault (`Disconnect from the vault first.`) and recheck enrollment before writing.

## Vault custody

### Vault setup

`setup --claustrum`, or answering yes to the vault question, enrolls each selected host while it is stopped. The Claustrum daemon (v0.2.0 or newer) must be running and `ck` installed. For each host, setup:

1. proposes or resumes the `anthropic-auth-<host>` enrollment and approves it with `ck auth enroll approve`;
2. grants read access to the `anthropic-native` category for the approved name: `ck auth grant --principal enrolled:<approved name> --selector-kind category --selector anthropic-native --operation read`. The approved name is `anthropic-auth-<host>` unless the operator chose another `--name` at approval, as a second host of the same kind must;
3. refreshes the vault inventory and requires its default Anthropic credential (`oauth:anthropic`) to have a vault-reported account identity. Otherwise it stops with `The vault has no verified default Claude account. Sign in through the vault and rerun setup.`

Vault setup writes only the selected host's enrollment files and, for Pi with consent, Pi's auth file (below). It does not read, import, change or delete the local pool, the migration journal, local runtime metadata or routing assignments. It never imports local OAuth into the vault, and never writes OpenCode's auth file.

For Pi, a stored Anthropic login (OAuth or API key) would take precedence over the vault. With consent, setup moves it into a private stash under the enrollment directory (`pi-auth-slot/anthropic.json`) and leaves an inert placeholder API key in Pi's auth file. The shared Pi slot helper performs both steps under a lock. Without consent, setup stops.

If the vault reports that an earlier enrollment request was replaced by a newer one, already used, or no longer exists, setup clears that request and stops; run setup again to propose a new one. Denied and other refused requests stay blocked until **Reset host enrollment** clears them.

### Serving

While a host is enrolled, Claustrum's scoped inventory is the only account authority. The default `oauth:anthropic` record is the main account. Newly logged-in vault accounts (`ck auth login --provider anthropic`) are discovered without a restart, and receive an initial quota fetch. If the vault's default account changes to a different Claude account, sessions pinned to the old default are assigned afresh; other session pins are kept.

Every model request, quota or profile query, quota-window priming request and cache keepalive request obtains scoped authorization at dispatch, with at least five minutes of remaining token lifetime. A replayable direct or HTTP-relay request that receives a genuine upstream 401 is reauthorized once, and retried only if the vault returns a newer record version for the same account; otherwise the rejected version is reported. A WebSocket response may already be streaming when its 401 arrives, so it is reported rather than replayed. A relay 401 without Anthropic request provenance falls back direct when configured, or returns 502, and never marks an account invalid. A failed or revoked authorization never falls back to a local credential. Access and enrollment tokens never appear in account settings, status or sidebar output.

Local accounts are never served, refreshed, quota-polled, kept warm or shown while the host is enrolled. They remain unchanged and return after disconnect. API-key routes in the local pool are local accounts and follow the same rule.

If the vault has no usable Claude account, requests refuse. Add accounts in the vault with `ck auth login --provider anthropic`, or disconnect the host from the vault.

### Menu actions while enrolled

The `/claude` menu shows `Accounts are managed in the vault. Disconnect from the vault to use local accounts.` Vault accounts can still be enabled or disabled, and **Reset account backoff** still works. Sign-in, API-key additions, removal, reordering, **Reset host enrollment** and custody setup guidance are hidden, and refused if requested. When custody cannot be read, the menu shows the same reduced set so that **Disconnect from the vault** stays available.

## Host gates

### OpenCode 1

OpenCode 1 activates the plugin's provider only for an OAuth-typed Anthropic entry. Ordinary OpenCode API keys, from **Create an API Key** or **Manually enter API Key**, are passed through unchanged in both custody modes.

| Custody | OpenCode Anthropic entry | Outcome |
| --- | --- | --- |
| any | API key, or none | Stock OpenCode behavior; the plugin does not serve |
| local | inert placeholder | Existing local-pool admission, subject to local authority and account availability below |
| claustrum | inert placeholder | Served from the vault |
| claustrum | any other OAuth login | Refused: `This host uses the credential vault, but OpenCode holds a separate Anthropic login. Remove it and choose the vault login, or disconnect from the vault.` |
| unreadable | OAuth entry | Refused |

For local OAuth entries, a separate OpenCode sign-in must have both access and refresh tokens. The pool has a usable sign-in when it contains an enabled local OAuth account not marked unsupported; API-key routes, disabled accounts and vault accounts do not count. Account selection or authorization can still refuse an individual request.

| OpenCode Anthropic entry | Setup journal | Pool has a usable sign-in | Outcome |
| --- | --- | --- | --- |
| The plugin's placeholder, a separate sign-in or an incomplete OAuth entry | Missing | Does not matter | Setup required: `migration-required` |
| The plugin's placeholder, a separate sign-in or an incomplete OAuth entry | Not finished (`building`, `verified` or `activation-installed`) | Does not matter | Resume setup: `migration-incomplete` |
| The plugin's placeholder | `committed` or `retired` | Does not matter | Existing placeholder behavior: serve only an eligible pool account, never the marker |
| A separate OpenCode sign-in | `committed` or `retired` | Yes | Serve from the native pool, not the separate sign-in |
| A separate OpenCode sign-in | `committed` or `retired` | No | Refused: `Native OAuth requires inert OpenCode activation; run offline setup` |
| Anything else OAuth-typed, including an incomplete sign-in | `committed` or `retired` | Does not matter | The same offline-setup refusal; the entry is neither the plugin's placeholder nor a complete sign-in |

Malformed or conflicting journals refuse rather than granting local permission. The plugin uses only native accounts for authorization, refresh and identity, never the separate OpenCode login's tokens.

On each local OpenCode 1 Accounts render, a separate complete sign-in with a committed or retired journal and a usable local pool sign-in shows the notice "OpenCode's separate Anthropic login is not used. Add that account through /claude Accounts if needed, or remove the separate login from OpenCode." once; changing the slot to the plugin's placeholder removes the line, a failed notice read shows nothing, and OpenCode 2 and Pi never show it.

**Claude via credential vault** is offered only while the host holds an enrollment token. It checks OpenCode's Anthropic slot without changing it, and writes the placeholder only into an empty slot of an enrolled host. An occupied slot is refused with `OpenCode already holds an Anthropic login; remove it before choosing the vault login`. An unreadable slot is also refused.

### OpenCode 2

OpenCode 2 offers **Claude Pro / Max (native account pool)** for local custody and **Claude vault accounts** for vault custody. Each refuses under the other custody mode, and both refuse when the enrollment record cannot be read. A completed sign-in stores a fixed, non-secret placeholder in OpenCode. The plugin serves a request only when its credential equals that placeholder exactly; any real OAuth token or API key is left untouched. Startup never creates or replaces an OpenCode connection.

OpenCode 2 supports direct and HTTP relay transport only. A selected WebSocket relay is refused before dispatch with `request refused: WebSocket relay is not supported on OpenCode 2; select HTTP relay or direct transport`.

### Pi

Pi's built-in Anthropic provider implementation is replaced, keeping the `anthropic` provider ID and the same model IDs. The provider authenticates from the custody source, not from Pi's stored login. In local custody, a leftover stored Pi Anthropic OAuth credential blocks serving until setup migrates it with consent.

## Disconnect

**Disconnect from the vault** is offered while a host is enrolled, and when its enrollment record cannot be read. It requires confirmation:

```text
Disconnect this host from the vault and return to local accounts? The vault keeps this host's enrollment approved until an operator revokes it there.
```

The action can clear malformed data, but it refuses unsafe storage and records for another host or plugin. Check the host's enrollment path, ownership and private permissions before retrying. Do not delete enrollment files by hand. See [disconnect recovery](vault.md#disconnect-and-recovery).

OpenCode's stored sign-ins are never read or changed. For Pi, disconnect first restores the stashed login byte-for-byte in place of the placeholder, then ends the enrollment. If Pi's auth file already holds a different login, disconnect stops, keeps both logins and the enrollment, and reports the conflict for resolution with setup. After a successful disconnect the host is in local custody, and a previously migrated local pool can serve again. If the pool has never been migrated, stop the hosts and run `setup --no-claustrum`; disconnect never performs migration.

## Enrollment lifecycle

Only the setup command proposes and polls enrollment. Host startup, the `/claude` menu and request serving read the owner-only enrollment files and never create a request or schedule polling. **Reset host enrollment** (local custody only) clears denied or blocked local enrollment state under lock, and never proposes a replacement; run setup afterwards. A live pending request is not reset, and an approved token cannot be reset this way.
