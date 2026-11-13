import { snapshotSettings } from '../settings-snapshot-fixture'
import { observeSettings } from '../settings-snapshot-observe'

// Run only in the tagged release tree, never to accept changed implementation output.
const output = process.argv[2]
if (!output) throw new Error('Pass the release snapshot output path')
const observations: Record<string, unknown> = {}
for (const host of [1, 2] as const)
  for (const [name, absent] of [
    ['explicit', false],
    ['absent', true],
  ] as const)
    observations[`oc${host}-${name}`] = await observeSettings(
      snapshotSettings(absent),
      host,
    )
await Bun.write(output, `${JSON.stringify(observations, null, 2)}\n`)
