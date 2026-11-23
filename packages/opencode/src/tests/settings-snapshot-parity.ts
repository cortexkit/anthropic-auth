import { expect } from 'bun:test'
import { promptCacheSnapshot } from '../../../core/src/tests/prompt-cache-snapshot'
import releaseSnapshots from './fixtures/settings-2.11.2.json'

export function cacheKeepWarmSnapshot<T extends { body: string }>(
  warm: T,
  source: 'release' | 'current',
) {
  const body = JSON.parse(warm.body)
  // Older OpenCode warms sent the previous-message ID; current warms must not.
  if (source === 'current') expect(body).not.toHaveProperty('diagnostics')
  else expect(body.diagnostics).toEqual({ previous_message_id: null })
  return { ...warm, body: promptCacheSnapshot(body) }
}

export function expectedReleaseSnapshot(
  host: 1 | 2,
  sample: 'explicit' | 'absent',
) {
  const released = releaseSnapshots[`oc${host}-${sample}`]
  // The feed setting is gone. The wire reader in both snapshots is OpenCode 2's.
  const { quota_header_feed_enabled: _removed, ...outputs } =
    released.readers.outputs
  // The frozen OpenCode 1 sample already has the five-minute request bytes and
  // CacheKeep body sizes that OpenCode 2 should now produce with no override.
  const short = releaseSnapshots['oc1-absent']
  return {
    ...released,
    warms: released.warms.map((warm) => cacheKeepWarmSnapshot(warm, 'release')),
    readers: {
      outputs,
      wire: {
        ...released.readers.wire,
        cache1hEnabled: sample === 'explicit',
        // The shared OpenCode 2 wire policy sends a null predecessor on the first turn.
        cacheDiagnosticsPreviousMessageId: null,
      },
    },
    ...(host === 2 &&
      sample === 'absent' && {
        request: { ...released.request, body: short.request.body },
        logs: short.logs,
      }),
  }
}
