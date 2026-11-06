# CacheKeep session registry

The session registry is a versioned, local, read-only interface for tools that
want to estimate whether a session's Anthropic prompt cache is still warm.
It contains metadata, never request bodies, headers, account credentials or
tokens. It is evidence of accepted requests, not a query of Anthropic's cache
and not a guarantee that a future request will hit the same cached prefix.

## Location and permissions

Each host writes under `<data>/cortexkit/anthropic-auth/cachekeep-sessions/`:

| Host | Subdirectory |
| --- | --- |
| OpenCode 1 and OpenCode 2 | `opencode` |
| Pi | `pi` |

`<data>` is `XDG_DATA_HOME` when set (trimmed and resolved as a path), otherwise
the host home directory's `.local/share`. These rules apply on every OS:

| OS | Default registry root |
| --- | --- |
| Linux | `~/.local/share/cortexkit/anthropic-auth/cachekeep-sessions/` |
| macOS | `~/.local/share/cortexkit/anthropic-auth/cachekeep-sessions/` |
| Windows | `%USERPROFILE%\.local\share\cortexkit\anthropic-auth\cachekeep-sessions\` |

Home uses `HOME` on Unix; Windows prefers `USERPROFILE`, then `HOME`; the OS
home directory is the fallback. This is not macOS's `Library` or Windows's
`AppData` folder. `XDG_STATE_HOME` does not select this data folder.

`OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` and
`PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` override the respective host's entire
registry directory, without adding a host subdirectory. Explicit overrides
continue to take precedence and do not also publish to the default folders.

Directories are owner-only (`0700` on POSIX, owner-only ACLs on Windows).
Files are owner-only (`0600` on POSIX, owner-only ACLs on Windows), written to
an exclusive temporary file and atomically renamed into place. Each process
instance owns `<pid>-<uuid>.json`; several files can exist for one host, and
several instances can report the same session. Ignore files not ending in
`.json`, including unfinished temporary files. Do not modify registry files.

For one release, default-path writers also publish to the old system-temp
folder, `<temp>/opencode-anthropic-auth/cachekeep-sessions/{opencode,pi}`.
Readers in the plugin merge both locations so 2.5.3 processes and newer
processes can coexist. The temp root is the OS temp directory (`TMPDIR` on
Unix, normally `TEMP` on Windows). New integrations should use the data folder.

The first release shipping this data-folder interface is the transition
release; the following release removes the compatibility paths. Version 2.5.3
predates the data-folder interface.

OpenCode 2's **private restart store**, which does contain compressed replay
bodies, is separate and is not this public interface. It lives under
`<data>/cortexkit/anthropic-auth/cachekeep-restore/<storage-id-hash>/`, with the
same owner-only protections. It writes only there. For the transition release,
an empty new store loads once from the old
`<temp>/cortexkit-anthropic-auth-cachekeep-<storage-id-hash>/` folder. Successfully
restored files are saved in the new store before their old copies are removed;
stale old records are discarded. This fallback is removed immediately after
the transition release, as defined above.

## Version 1 record

```json
{
  "version": 1,
  "updatedAt": 1800000000000,
  "sessions": [
    {
      "id": "ses_example",
      "cacheExpiresAt": 1800003600000,
      "nextPrewarmAt": 1800003300000,
      "ttlMs": 3600000,
      "lastTouchAt": 1800000000000,
      "lastTouchKind": "response",
      "warmStopped": { "at": 1800000060000, "reason": "disabled" }
    }
  ]
}
```

- `version`: required integer `1`. A breaking change gets a new version.
- `updatedAt`: required finite Unix timestamp in milliseconds, when this file
  was last published. It is a process lease, **not** a cache touch.
- `sessions`: required array. Each entry requires a nonempty string `id` and
  finite millisecond timestamps `cacheExpiresAt` and `nextPrewarmAt`.
- `cacheExpiresAt`: the estimated end of the known cache lifetime.
- `nextPrewarmAt`: the planned next replay, possibly adjusted for retries.
  For a stopped session it is historical; it does not promise another replay.
- `ttlMs` (optional): the cache TTL actually sent, in milliseconds.
- `lastTouchAt` (optional): timestamp of the last accepted response or
  successful keep-warm replay. Failed sends, waits, lease refreshes and process
  restarts do not advance it.
- `lastTouchKind` (optional): `"response"` or `"warm"`.
- `warmStopped` (optional): warming has stopped, but the known cache lifetime
  has not necessarily ended. `at` is the stop timestamp and `reason` is one of
  `cost-cap`, `schedule`, `evicted`, `policy-refused`, `retries-exhausted`,
  `session-forgotten`, `disabled`.
- `writer` may also be present as an internal process-protocol stamp. Readers
  do not need it to interpret cache lifetime.

All additions are optional. Ignore unknown fields at both levels; older files
remain valid without the new fields. Stopped sessions retain **only metadata**
until `cacheExpiresAt`, then disappear. A new accepted turn can resume tracking
and clears `warmStopped`. A normal host shutdown removes its own lease files;
it does not prove that the cache expired.

## Reader rules

1. Read all `.json` files for the relevant host. Skip unreadable or malformed
   records and unsupported versions. Validate required fields; skip malformed
   session entries rather than rejecting valid neighbors.
2. A record is current only when `updatedAt <= now` and
   `now - updatedAt <= 180000` (180 seconds). Skip older **and future** records.
3. Merge current records by session id, keeping the entry with the largest
   `cacheExpiresAt`. Equal expiries need no particular tie-breaking order.
4. A cache counts as expired only when the record is current and the entry has
   valid `lastTouchAt` and positive `ttlMs`, and `lastTouchAt + ttlMs <= now`.
   Before that deadline it is estimated warm, whether or not warming stopped.
   Without these optional facts, cache lifetime is unknown to this rule.
5. A missing session, missing file, stale record, future record or vanished
   process means **unknown, never expired**. Do not infer expiry from absence
   or from `warmStopped`. Refresh observations before taking action.

The plugin refreshes leases while running. It may clean up another process's
file only after the lease expires **and** that process is provably gone. A
possibly live process's stale file is not deleted. A finite, nonnegative
`updatedAt` at or before `now` that is more than five minutes before
`now - OS uptime` proves that the record predates the last boot, even if its
pid was reused. The five-minute margin allows for clock imprecision. Invalid
or future timestamps never supply that proof. This conservative cleanup does
not make a stale record current.

See [CacheKeep](cache.md#cachekeep) for warming policy and costs, and
[environment variables](environment.md#paths-on-windows-macos-and-linux) for
the shared cross-platform path conventions.
