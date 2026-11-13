# OpenCode settings release oracle

`settings-2.11.2.json` was captured on Linux x64 with Bun 1.3.14 from the last
published release before the settings move, currently tag `v2.11.2`, commit
`5d87a95c1f33be50a3872cb6389e5deab4775068`. The capture uses that release's
source, frozen lockfile and freshly built Core, not the implementation under test.

To reproduce, create the reference archive locally from the checkout root:

```sh
git archive v2.11.2 -o packages/opencode/snapshot-release-reference.tar
```

Then run `bash packages/opencode/src/tests/fixtures/capture-settings-release.sh`
on the Linux runner with Bun 1.3.14 first on PATH and network enabled for the
release's frozen install. Return `packages/opencode/src/tests/fixtures/settings-2.11.2.json`
and remove the temporary archive afterwards. The script adds exports for two
private Core readers in its throwaway release tree; their implementations stay
unchanged. Never regenerate the oracle from the current implementation to accept
new output.

Both OpenCode host startup tests select local and Claustrum legacy stores, with
Pi's sources absent or explicitly identical. Each explicit fixture sets every
moved field. A second fixture leaves `claudeCache.enabled` and `quota.enabled`
absent. Every before/after observation is serialized and compared with the release
oracle, not only with the other phase. No settings record is snapshotted.

The observer exercises Core's named readers, OpenCode 1's actual private predicate
expressions, OpenCode 2's wire policy, quota maintenance selection and lifecycle
tick. The inventory test closes the observation list against the schema's shared
and OpenCode cache/quota readers. Reader keys for every moved field are also
checked against the schema inventory.

Request capture follows the direct OAuth transform/header pipeline with the
host's effective cache/fast settings; it does not contact Anthropic or exercise
credential admission. Device, session and request identities are fixed before
serialization, with no byte scrubbing. OpenCode 1 uses its persistent cache
reader and OpenCode 2 uses its wire policy, preserving their different absent
cache behavior. The shared keep-warm manager receives the resulting request,
uses an injected clock and inert timers, and runs a due tick. The explicit fixture
tracks and sends a warm request; the absent fixture records a kept-off target
and sends no warm request. Dump filenames use an injected ISO timestamp and a
fixed relative scratch path before capture, so their log records are retained.

Logs retain the logger's level/channel/message/redacted-payload records, without
wall-clock prefixes. Startup move diagnostics and the settings path itself are
outside the unchanged-consumer capture: moving the settings intentionally changes
those. The host tests separately assert authority, paths and source preservation.
The install-path matrix exercises real OpenCode 1 and 2 startup, legacy writes in
separate installs, named-file moves, and shared sidebar preferences independently
of the release observer.
