import { homedir } from 'node:os'
import * as nodePath from 'node:path'

export function getHostHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir()
  )
}

export function getHostDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathApi: Pick<typeof nodePath, 'join' | 'resolve'> = nodePath,
): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  return xdg
    ? pathApi.resolve(xdg)
    : pathApi.join(getHostHome(env, platform), '.local', 'share')
}
