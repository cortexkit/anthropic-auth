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
  else {
    expect(body.diagnostics).toEqual({ previous_message_id: null })
    delete body.fallbacks
  }
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
  const request =
    host === 2 && sample === 'absent' ? short.request : released.request
  const logs = host === 2 && sample === 'absent' ? short.logs : released.logs
  const { laneStart, ...wire } = released.readers.wire

  // Client mode keeps `server-side-fallback-2026-07-01` but no longer opts into server routing.
  // These checksums sign the frozen request bytes without the `fallbacks` field.
  const body = JSON.parse(request.body)
  delete body.fallbacks
  const cch = sample === 'explicit' ? 'c1eaa' : '00d39'
  body.system[0].text = body.system[0].text.replace(
    /\bcch=[0-9a-f]{5};/,
    `cch=${cch};`,
  )
  const bodyText = JSON.stringify(body)
  const removedBytes = request.body.length - bodyText.length
  return {
    ...released,
    warms: released.warms.map((warm) => cacheKeepWarmSnapshot(warm, 'release')),
    readers: {
      outputs,
      wire: {
        ...wire,
        cache1hEnabled: sample === 'explicit',
        serverSideFallbackEnabled: false,
        refusalFallbackMode: 'client',
        laneStart,
        // The shared OpenCode 2 wire policy sends a null predecessor on the first turn.
        cacheDiagnosticsPreviousMessageId: null,
      },
    },
    request: { ...released.request, body: bodyText },
    logs: logs.map((record) => {
      const { payload } = record
      if (
        record.channel !== 'cachekeep' ||
        record.message !== 'stopped warming session' ||
        !payload ||
        !('bodyBytes' in payload) ||
        payload.bodyBytes === undefined ||
        payload.totalBodyBytes === undefined
      )
        return record
      return {
        ...record,
        payload: {
          ...payload,
          bodyBytes: payload.bodyBytes - removedBytes,
          totalBodyBytes: payload.totalBodyBytes - removedBytes,
        },
      }
    }),
  }
}
