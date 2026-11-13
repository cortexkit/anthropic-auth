import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { isAbsoluteForPlatform } from '@cortexkit/common-auth/settings'

/** Pass one process's inputs through every settings path decision. */
export interface PathResolutionOptions {
  env?: Readonly<Record<string, string | undefined>>
  home?: string
  platform?: NodeJS.Platform
  realpath?: (path: string) => Promise<string>
}

export function resolvePathOptions(options: PathResolutionOptions = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const configuredHome = platform === 'win32' ? env.USERPROFILE : env.HOME
  const home =
    configuredHome && isAbsoluteForPlatform(configuredHome, platform)
      ? configuredHome
      : (options.home ?? homedir())
  return {
    env,
    home,
    platform,
    realpath: options.realpath ?? realpath,
    paths: platform === 'win32' ? win32 : posix,
  }
}
