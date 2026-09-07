import * as fs from 'node:fs/promises'
import { join } from 'node:path'

export type GoldenCustodyManifest = {
  version: number
  providers: Array<{
    provider: string
    serve: string
    accounts: Array<{
      label: string
      handle: string
      credential_id: string
      superseded?: string[]
      [key: string]: unknown
    }>
  }>
}

export async function loadGoldenCustodyManifest(): Promise<{
  text: string
  manifest: GoldenCustodyManifest
}> {
  const path = join(
    import.meta.dir,
    'fixtures',
    'claustrum-golden',
    'handles.json',
  )
  const text = await fs.readFile(path, 'utf8')
  return { text, manifest: JSON.parse(text) as GoldenCustodyManifest }
}
