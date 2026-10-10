import { isCancel, note, text } from '@clack/prompts'
import {
  authorize,
  exchange,
  resolveClaudeCodeIdentity,
} from '@cortexkit/anthropic-auth-core'
import type { NativeOfflineLogin } from './native-local'
import type { HarnessKind } from './types'

export async function loginNativeOffline(
  host: HarnessKind,
): Promise<NativeOfflineLogin> {
  const authorization = await authorize('max')
  note(
    authorization.url,
    `Claude sign-in for ${host === 'pi' ? 'Pi' : 'OpenCode'}`,
  )
  const code = await text({
    message: 'Paste the Claude callback URL or authorization code:',
  })
  if (isCancel(code)) throw new Error('Claude sign-in cancelled')
  const result = await exchange(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )
  if (result.type !== 'success') throw new Error('Claude sign-in failed')
  const identity = await resolveClaudeCodeIdentity(
    result.access,
    undefined,
    undefined,
  )
  if (!identity.accountUuid)
    throw new Error('Claude sign-in did not establish an account UUID')
  return {
    accountIdentity: identity.accountUuid,
    credential: {
      type: 'oauth',
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
    },
  }
}
