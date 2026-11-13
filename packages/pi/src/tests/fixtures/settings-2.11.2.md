# Pi settings release oracle

`settings-2.11.2.json` was captured on Linux x64 with Bun 1.3.14 from tag
`v2.11.2`, commit `5d87a95c1f33be50a3872cb6389e5deab4775068`, using that
release's source, frozen lockfile and freshly built Core. It is not generated
from the implementation under test.

To reproduce, archive the tag **locally** from the checkout root:

```sh
git archive v2.11.2 -o packages/pi/snapshot-release-reference.tar
```

Then run `bash packages/pi/src/tests/fixtures/capture-settings-release.sh` on
the Linux runner with Bun 1.3.14 first on PATH and network enabled for the
release's frozen install. Remove the temporary archive afterwards. The capture
script exposes four existing private functions by adding exports in the
throwaway release tree; it does not change their implementations. Never run
the capture against the current implementation to accept changed output.

The explicit fixture holds every moved field; the absent fixture leaves both
`claudeCache.enabled` and `quota.enabled` absent. The test reads each fixture
through both local and Claustrum settings stores, before and after moving
their settings into the shared `anthropic-auth.jsonc` file, with OpenCode's
sources either absent or explicitly identical. No
settings record is snapshotted. Reader output keys are checked against the
schema's default-reader inventory, and the four schema-named Pi cache/quota
entry points are checked against `SETTINGS_THREE_WAY_READERS`, the schema's
list of consumers required to accept legacy booleans/absence and the file's
`on`/`off`/`default` values.

The observation harness feeds each selected store's effective settings into a
separate, isolated local credential fixture. This tests the same request,
admission, fallback, status and keep-warm consumers for both custody modes
without involving a live vault, changing custody, or copying credentials out
of a vault. Requests use the real Pi sender and injected fetch. Keep-warm uses
its real manager, an injected clock and inert timers, including a due tick.
The explicit fixture both tracks and warms; the absent fixture refuses tracking
and excludes the quota-ineligible fallback.

Device/session/request identities are fixed **before** serialization. The
snapshot retains every captured body byte and header, including warm requests.
Cache status omits only its separate persisted-path line: that path is intended
to change from the pool/vault settings file to the shared user file and is
asserted independently. Logs are the logger's
level/channel/message/redacted-payload records, without wall-clock formatting
prefixes; their serialized bytes are compared, not settings records. Startup
migration diagnostics are intentionally outside the unchanged-consumer capture.
