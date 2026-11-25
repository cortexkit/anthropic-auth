# Shared settings file

OpenCode 1, OpenCode 2 and Pi share user settings in `anthropic-auth.jsonc`.
It is JSONC: comments and trailing commas are allowed. It contains settings,
not credentials. All settings are user-only; no project settings file is read,
watched or reported.

## Location

The full default path is resolved as follows. An absolute `XDG_CONFIG_HOME`
takes precedence on **every OS**, including Windows.

| OS | With an absolute `XDG_CONFIG_HOME` | Otherwise |
| --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/cortexkit/anthropic-auth.jsonc` | `$HOME/.config/cortexkit/anthropic-auth.jsonc` |
| macOS | `$XDG_CONFIG_HOME/cortexkit/anthropic-auth.jsonc` | `$HOME/.config/cortexkit/anthropic-auth.jsonc` |
| Windows | `%XDG_CONFIG_HOME%\cortexkit\anthropic-auth.jsonc` | `%APPDATA%\cortexkit\anthropic-auth.jsonc` |

For example, on Windows with `XDG_CONFIG_HOME=C:\Users\Ada\.config`, the
file is `C:\Users\Ada\.config\cortexkit\anthropic-auth.jsonc`. Without that
override, a typical path is
`C:\Users\Ada\AppData\Roaming\cortexkit\anthropic-auth.jsonc`. If `APPDATA`
is unavailable or not absolute, Windows falls back to
`%USERPROFILE%\AppData\Roaming\cortexkit\anthropic-auth.jsonc`. On Linux
and macOS, an unusable `HOME` falls back to the system home directory; Windows
uses the system home if `USERPROFILE` is unusable. Relative `XDG_CONFIG_HOME`
values are ignored.

Set `ANTHROPIC_AUTH_SETTINGS_FILE` to an **absolute file path** to choose a
different target. An empty or relative value is ignored and logged once.
Use the resolved settings path shown by `/claude` Status when diagnosing which
file an instance uses. Each target has its own move marker and protection copy.

## Setting names and schema

The JSON Schema ships in the Core package at
[`packages/core/schema/anthropic-auth.schema.json`](../packages/core/schema/anthropic-auth.schema.json)
(`@cortexkit/anthropic-auth-core/schema/anthropic-auth.schema.json` in an installed
package). Use it for the complete value domains and defaults. Names in this
file are flat, lower-case snake_case, not the legacy nested camelCase names.

| Area | Flat setting names |
| --- | --- |
| Routing | `routing_mode`, `max_same_account_wait`, `fallback_on` |
| Refresh | `refresh_enabled`, `refresh_interval_minutes`, `refresh_refresh_before_expiry_minutes` |
| Quota | `quota_enabled`, `quota_check_interval_minutes`, `quota_refresh_every_n_requests`, `quota_minimum_remaining_five_hour`, `quota_minimum_remaining_seven_day`, `quota_minimum_remaining_scoped`, `quota_fail_closed_on_unknown_quota`, `quota_show_toasts` |
| Killswitch | `killswitch_enabled`, `killswitch_default_five_hour`, `killswitch_default_seven_day`, `killswitch_default_scoped`, `killswitch_account_floors` |
| Cache | `claude_cache_enabled`, `claude_cache_mode`, `cache_keep_enabled`, `cache_keep_always`, `cache_keep_window`, `cache_keep_subagents` |
| Request features | `dump_enabled`, `prime_enabled`, `claude_fast_enabled`, `cost_zeroing_enabled` |
| Refusal fallback | `refusal_fallback`: `client` (default), `server` or `off` (see [refusal fallback](refusal-fallback.md)) |
| Logging | `log_level` |
| Thinking binding | `thinking_binding_prefix_mismatch_behavior` |
| Turn-end notes | `turn_end_note_tools` |
| Custom gateway | `gateway_url`, `gateway_headers` (see [Custom gateway](#custom-gateway)) |

`max_same_account_wait` takes `"off"`, `"15m"` (the default) or `"cache"`;
the menu calls it **Longest wait on the same account**. Floors are percentages
from 0 to 100. The default killswitch floors are 5-hour **5**, weekly **10**
and scoped **0**, with the killswitch **disabled**.

`cache_keep_window` is a list of `{ "start_hour": 9, "end_hour": 17 }` objects,
but supports **at most one entry**. Its default `[]` means no window. Two or
more entries are invalid: at startup there is no window; while running the last
good window stays in effect. The error is logged and shown in Status.

### What `"default"` means

`claude_cache_enabled`, `quota_enabled` and
`quota_fail_closed_on_unknown_quota` accept `"default"`, `"on"` and `"off"`,
not booleans. `"on"` and `"off"` are explicit choices on every host.
With `claude_cache_enabled` unset or set to `"default"`, OpenCode 1, OpenCode 2
and Pi use the five-minute cache. Choose `"on"` for one-hour caching or `"off"`
for five-minute caching. A [session cache policy](cache.md#per-session-runner-policy)
can override individual cache settings for that session.

For `quota_enabled`, `"default"` (also the value when unset) uses each reader's
own default:

| Setting | OpenCode 1 | OpenCode 2 | Pi |
| --- | --- | --- | --- |
| `quota_enabled` | Core quota policy, provider restriction and fallback polling are on; sidebar main-quota refresh and the host's main-quota routing check are off | Quota policy and polling are on | Core quota policy is on |

`log_level: "default"` defers to `OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL`, or `info`
if it is unset. The environment variable retains startup precedence.
`thinking_binding_prefix_mismatch_behavior: "account-default"` leaves thinking
prefix-mismatch handling to Anthropic, without sending a `block_binding`
override. `quota_fail_closed_on_unknown_quota: "default"`
retains the existing quota policy's unknown-quota behavior.

## Host and model overrides

A setting can be a direct value or an object containing `default`, `opencode`
and `pi`. Both OpenCode generations use `opencode`. Only these settings also
accept model keys:

- `claude_cache_enabled`
- `claude_cache_mode`
- `claude_fast_enabled`
- `cache_keep_enabled`
- `thinking_binding_prefix_mismatch_behavior`

```jsonc
{
  "schema_version": 1,
  "routing_mode": { "default": "main-first", "pi": "sticky-balanced" },
  "claude_cache_enabled": {
    "default": "default",
    "opencode": "off",
    "claude-opus-5-5": "on"
  },
  "cache_keep_window": [{ "start_hour": 9, "end_hour": 17 }]
}
```

Within a setting, precedence is **model key → host key → override `default`
→ declared default**. The object member named `default` is the fallback value;
the string value `"default"` for the three settings named above instead means the
per-reader behavior described above. A model key must name a row id from
[`model-capabilities.ts`](../packages/core/src/model-capabilities.ts). Requests
drop the `[1m]` qualifier and use the table's longest matching model id/suffix.
Unknown models use the no-model values. Unrecognized model override keys are
ignored, logged and named in Status.

`killswitch_account_floors`, `refusal_fallback`, `gateway_url` and `gateway_headers`
are exceptions: they take **no overrides**. The floors setting is a list of
complete `{account, host, five_hour, seven_day, scoped}` entries. `host` is
`opencode`, `pi` or `both`; each host applies its own and `both` entries. `account` is the local row id or vault roster route id, never an email
or account identity. Entries may not overlap for the same account and host.
The legacy aliases `5h` and `1w` are not valid keys here.

## Wait for a quota reset

`wait_for_reset` is a boolean, **false by default**. Set it to `true` in the
user settings file to keep a turn waiting when no Claude account can serve it
and every eligible account has a known, future quota reset. It also covers
accounts blocked by your quota floors. The wait ends at the earliest reset
that makes an account usable, plus the usual per-session jitter; an account
blocked by several windows must wait for the last of those windows to reset.

```jsonc
{ "schema_version": 1, "wait_for_reset": { "default": false, "pi": true } }
```

OpenCode 1 receives the real wait in `Retry-After`. Pi waits once inside the
plugin, refreshes quota and rechecks accounts before resending once; Escape
cancels throughout the wait. After a quota-limited reply, OpenCode 2 uses
one host retry to wait for the reset, up to eight days, then rechecks before
sending. New messages on an already exhausted pool still stop immediately.
Unknown resets or resets more than eight days away keep the ordinary behavior.

When any account can still serve, routing and `max_same_account_wait` work as
before. Unknown resets, sign-in or credential-store refusals, disabled
accounts, Thalamus routing holds and API-key routes do not gain long waits.
This is a pool-exhaustion option, not a per-model setting or a change to the
same-account migration budget. It accepts `default`, `opencode` and `pi`
host overrides, but no model overrides. `/claude` Settings Status lists its
current value on every host. There is no menu toggle; edit the file to opt in.

## Custom gateway

Claude sign-in (OAuth) model requests normally go only to
`https://api.anthropic.com`. To send them through your own gateway instead,
set both settings in your user settings file:

```jsonc
{
  "schema_version": 1,
  "gateway_url": "https://gateway.example.com/claude",
  "gateway_headers": { "X-Gateway-Key": "your gateway secret" }
}
```

- `gateway_url` is an absolute `https:` URL, or `http:` only for a loopback
  host (`127.0.0.1`, `[::1]` or `localhost`). It may have a path prefix, but no
  user name, password, query or fragment. Model requests go to
  `<gateway_url>/v1/messages?beta=true`. An empty value (the default) means no
  gateway.
- `gateway_headers` is an object of header names and string values added to
  every gateway request. The same rules as
  `ANTHROPIC_CUSTOM_HEADERS` apply: authentication, protocol, body-framing and
  the plugin's own internal headers (such as `authorization`, `x-api-key`,
  `anthropic-beta`, `anthropic-version`, `content-type`, `content-encoding`)
  are refused, and so are invalid names, line breaks in values, and the same
  name twice.

Neither setting takes host or model keys: one gateway, with its headers,
serves OpenCode 1, OpenCode 2 and Pi alike, so one host's gateway headers are
never sent to another gateway. An override object on either setting makes the
gateway invalid.

The gateway applies only to model requests on OpenCode 1, OpenCode 2 and Pi,
including keep-warm and Prime sends. A model request is a `POST` to
`api.anthropic.com` whose path ends in `/messages`, also when a provider
`baseURL` on `api.anthropic.com` adds a path or another version in front of it
(`/v2/messages` still goes to the gateway's `/v1/messages`); a path with `.` or
`..` segments is not treated as one, and neither is a sub-resource such as
`/v1/messages/count_tokens`. Sign-in, token refresh, usage and quota,
profile and every other Anthropic endpoint still go only to
`https://api.anthropic.com`, and API-key accounts keep their own base URL.
Through the gateway:

- Every request is a full request: message threads are not used, because a
  gateway may not support them.
- Request bodies are not gzipped; Claude Code compresses only to
  `api.anthropic.com`.
- The relay is not used for model requests. If a relay is also configured,
  the gateway wins for them and one warning says the relay is ignored. Nothing
  retries or falls back to `api.anthropic.com` directly. Other sign-in
  requests the gateway does not take still use the relay as before, and a
  WebSocket relay still refuses them.
- Redirects are refused, as for every sign-in request.
- TLS certificates are always checked.
- A loopback `http:` gateway is refused while `HTTP_PROXY` or `http_proxy` is
  set, because Bun would send those plain-text requests, with your sign-in
  token and gateway headers, through that proxy, and a repository's `.env`
  file can set the variable. Each such request fails with "Gateway refused: a
  proxy setting would carry plain-http requests"; one warning is logged,
  Status shows the same line, and nothing goes to `api.anthropic.com`
  instead. To allow it, list the gateway host in `NO_PROXY`, and also in
  `no_proxy` when that is set (an empty one lists no host): `*`, the exact
  host (`127.0.0.1`, `localhost` or `[::1]`) or `host:port` with the
  gateway's port, in a comma-separated list. An `https:` gateway is not
  affected: a proxy can only tunnel it, and its certificate is still checked.

Apart from the URL and the added headers, each request is the one the plugin
would send to Anthropic: same identity, billing header, signing, betas and
cache markers.

The gateway is honoured only from the settings file at its default location
for your operating system account: `~/.config/cortexkit/anthropic-auth.jsonc`
on Linux and macOS, and `cortexkit\anthropic-auth.jsonc` in your roaming
AppData folder on Windows. The plugin finds that location from the account
itself, never from the environment: the account database entry for your user
id on Linux (`getent`, or `/etc/passwd`), the directory record on macOS
(`dscl`), and the user's `Shell Folders` registry key on Windows (`reg.exe`
under `C:\Windows`). It looks once per process, when settings are first
read. `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` and
`ANTHROPIC_AUTH_SETTINGS_FILE` never decide it. The paths are compared after
resolving links, again every time the file is read, so a link that later
points elsewhere stops the gateway at once. When the file in use is reached
through another path than the default one (for example, the default path is a
link to it), the default path is watched as well, so removing or retargeting
it stops the gateway at once even though the file itself has not changed. If
the settings file in use is
anywhere else, a gateway it names is ignored, one warning is logged, and
Status says "Gateway ignored: settings file is not in its default location".
If the account's home folder cannot be found, the gateway is ignored the same
way and Status says so. Other settings in that file still apply.

These settings are read only from your own user settings file. A project file,
a provider `baseURL`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS` can
never set or change the gateway, and the `/claude` menu never writes it. A
separate install, or a host that has not moved to the settings file yet, uses
no gateway.

If either setting is invalid, there is **no gateway**: model requests go to
`https://api.anthropic.com` as usual, one warning is logged for that
configuration, and Status lists the invalid setting. The plugin never keeps
using an earlier gateway value after an invalid edit. The same holds while the
settings file is malformed or cannot be read: other settings keep their last
good values, but the gateway is not used until the file reads again.

Header values are treated as secrets. They are never logged, written to
request dumps, shown in Status or the sidebar, or sent to the TUI, and an error
from the gateway that repeats one has it replaced with `[REDACTED]`. Status shows
the gateway's origin and path prefix and the header names only.

## Editing and Status

Hand edits are watched and apply to later requests without a restart. Requests
use an in-memory snapshot and never wait for settings file I/O. Process-wide readers
use the no-model values. Keep-warm tracks accepted session requests and uses
the model of each tracked request for its three model-aware cache settings.

`/claude` Status shows no-model values and lists model overrides separately with
their row ids and values; it has no "current model". Once the shared file is in
use, OpenCode 2 and Pi Status show the killswitch's default floors filled in
(5-hour 5, weekly 10, scoped 0, still disabled) instead of an empty value.
This display change does not change effective behavior.

Menu actions write only changed settings, into the acting host's entry when one
decides the value, otherwise into the top-level value (or override `default`).
They never write model entries. Comments, key order and unknown keys are kept,
**except comments and formatting inside a list the action rewrites are lost**.
For example, changing one account's floors rewrites `killswitch_account_floors`
as a whole, keeping other entries' values but not their inline comments.
Malformed files and duplicate keys refuse menu writes; Status names read or
validation problems. Fix the reported file rather than editing an old store.

## The move and the files that stay

At host startup, the one-time move runs only when the target and its marker are
absent. It waits until every running copy is on this version and can be checked.
Update and restart every OpenCode and Pi installation to let it run. If a running
copy cannot be checked, the move waits rather than guessing. Until then, the host
keeps reading and writing its old settings. Stopped-host `setup` does not run the
move.

For the default target, the move reads both hosts' default-location stores,
using each host's current custody mode: `anthropic-auth-pool.json` in local
mode, `anthropic-auth-vault-settings.json` in vault mode. For an absolute
`ANTHROPIC_AUTH_SETTINGS_FILE`, or a private absolute `XDG_CONFIG_HOME` whose
real path differs from the home directory's `.config`, it reads **only the
running host's own resolved stores**. A missing source is skipped. If a vault
peer has a local store but has not yet created its vault settings, the move waits
until that peer has run once. An existing source that cannot be read or parsed
stops the move for that start.

Ordinary settings move only when explicitly stored. A value set on just one host
becomes a top-level value inherited by **both** hosts. Different explicit values
become `default` (OpenCode's value) plus `pi`; per-account floors carry host tags.
Protection settings keep at least each host's own effective protection, including
defaults it did not store explicitly. Sharing a lower value from one host does
not lower the other host's protection. These checks cover the move, adopting the
file while running, setup and recreating a missing file.

A host whose settings were not imported takes ordinary settings from the file
or its defaults, not from its old preferences. Before adopting the file, it also
makes a one-time protection check, at startup or while running: effective legacy
protection values, including defaults, that are stricter than what the host
resolves from the file are filled into that host's own override only where the
file does not already set that key at the host's level. This includes the
killswitch, quota floors, unknown-quota policy and same-account wait.
Missing per-account floors are added with that host's tag
when they exceed the file's default floors; existing account entries are not
replaced. A `moved.<host>` record (`opencode` or `pi`) records this check.
Ordinary legacy preferences are never merged. If its legacy protection
cannot be read, or the protection import cannot be written, the host keeps using
its old settings. It retries at a later settings check or the next start. Startup
logs also name legacy values that differ from the file.

The move leaves source files byte-identical and writes a
`<source file name>.MOVED_READPLEASE` note naming the target beside each existing
source. **The old files stay in use for what did not move.** Credentials,
account rows, main-account selection, account order, custody metadata, quota
readings, refresh state and prime counters remain in their existing stores.
Relay settings and the relay token remain paired there under their generation
stamp. Sidebar preferences remain in OpenCode's shared `tui-preferences.jsonc`
under the `anthropic-auth` key, not in this settings file.

An existing hand-made user file is authoritative too, subject to the same
one-time protection check; ordinary legacy preferences are not merged into it.
A successful move (even with no sources), or finding a hand-made file that
parses, writes the owner-only `moved` marker. The `MOVED_READPLEASE` notes are
informational; the plugin never uses them to decide authority. Do not delete the
marker to try to restore settings from stale stores.

### Where the records are kept

The plugin writes four owner-only records: `moved`, `moved.opencode`, `moved.pi`
and `applied.json`. It writes them under `<state root>/settings/<key>/` and also
beside the settings file as `<target>.moved`, `<target>.moved.opencode`,
`<target>.moved.pi` and `<target>.applied.json`. The state root is
`$XDG_STATE_HOME/cortexkit/anthropic-auth` if `XDG_STATE_HOME` is absolute;
otherwise it is `~/.local/state/cortexkit/anthropic-auth` on every OS. The key is
specific to the configured filename in its canonical parent folder; a symlink
at the filename does not change the key.

A marker in either location counts; an unreadable record is not treated as
missing. For `applied.json`, each host's newest recorded reading wins. If the
state folder cannot be used, the plugin warns and keeps using the records beside
the settings file. `/claude` Status, and the setup command (run with OpenCode and Pi stopped), show where the records are kept.

The copies beside the settings file keep 2.17.x working during mixed-version use
and after rollback. This release removes neither copy. A later release will stop
writing beside the settings file and remove those copies, with this release as
the oldest supported rollback.

### Setup

Setup adds missing values without overwriting what you set. An ordinary setting
is added only when the file has no value at the default or acting host's level.
Stricter protection from that host's old settings, including defaults, is kept at
the host's level only where you have not already set a value for that host.
Existing per-account floors are kept; missing ones are added with the host's tag.
If setup recreates a missing file, it preserves both hosts' protection under the
same rules as a menu write below, and refuses while either host's protection
cannot be read.

### Missing or invalid file

Deleting the file after the move does not move the old settings again. While
running, the watcher allows two seconds for an editor to recreate the file.
If it stays missing, non-protection settings take defaults and protection
settings keep the process's last good values. Status names the missing file.

Protection settings (killswitch, quota floors, unknown-quota policy and
same-account wait) are recovered as a complete set, never by skipping a bad
account entry. An unusable file keeps last-good protection values. At startup
the recovery order is this host's last-applied copy, then its readable legacy
store, then the restrictive fallback: killswitch on at the default floors,
unknown quota refused and same-account wait off.

The owner-only `applied.json` records hold a complete last-applied protection
set per host and no credentials. They are updated from usable user-file values
only. They are recovery copies, not settings files to edit.

A menu write that recreates a missing file preserves the writer's currently
applied protection values and the other host's recoverable protection set, then
applies the requested change. If they differ, host overrides and host-tagged
account floors preserve each host's own values. **The writer's values apply to
both hosts only when the other host never ran and has no protection set of its
own.** Recreation is refused while either host's protection cannot be read;
edit the settings file to set it explicitly instead. Status reports that the
file was recreated.

## Separate installs

Without an absolute `ANTHROPIC_AUTH_SETTINGS_FILE`, an install is separate if
one of its own settings-bearing store paths differs by real path from its host's
default:

- OpenCode: `OPENCODE_ANTHROPIC_AUTH_FILE`,
  `OPENCODE_ANTHROPIC_AUTH_STATE_FILE` or `OPENCODE_CONFIG_DIR` can make it
  separate, compared with the XDG-aware defaults.
- Pi: `PI_ANTHROPIC_AUTH_FILE`, `PI_CODING_AGENT_DIR` or `PI_AGENT_DIR` can make
  it separate, compared with the default agent directory under the user's home.

A variable resolving to the default path is not a separate install. Variables
for the other host do not count. A separate install does not move settings,
read or watch the shared file, or adopt schema defaults; its menus keep writing
its legacy store. A private `HOME` alone is not separate: it gets a shared file
under that home. An absolute `ANTHROPIC_AUTH_SETTINGS_FILE` explicitly opts into
that target even alongside a store override, and its move reads only the acting
host's resolved stores.

## Rollback

Rolling back to the **last published release (2.11.4 at the time of writing)**
remains possible: the move preserves the legacy settings, and subsequent store writes keep those
legacy sections intact. But that release does not read the new file, so a
rollback **loses settings changed after the move** and uses the older settings
left in each host's store. Record or back up your current settings before
rolling back, and reapply needed changes through the older release's controls.
Do not delete the old stores or the shared file as part of a settings rollback.
