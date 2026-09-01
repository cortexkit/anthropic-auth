import { createHash } from 'node:crypto'
import xxhashInit from 'xxhash-wasm'
import { CCH_POSITIONS, CCH_SALT, CLAUDE_CODE_VERSION } from './constants.ts'

type Message = {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

const CCH_SEED = 0x4d659218e32a3268n
const CCH_PLACEHOLDER = 'cch=00000;'
export const CCH_PATTERN = /\bcch=([0-9a-f]{5});/
const BILLING_HEADER_CCH_PATTERN =
  /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=([0-9a-f]{5});/
const BILLING_HEADER_CCH_PLACEHOLDER_PATTERN =
  /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=00000;/

let xxhashPromise: Promise<void> | null = null
let xxhash64Raw: ((input: Uint8Array, seed: bigint) => bigint) | null = null

async function ensureXxhash() {
  if (xxhash64Raw) return
  xxhashPromise ??= (async () => {
    const hasher = await xxhashInit()
    xxhash64Raw = hasher.h64Raw
  })()
  await xxhashPromise
}

/**
 * Extract text from the first user message's first text block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((message) => message.role === 'user')
  if (!userMsg) return ''

  const { content } = userMsg
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const textBlocks = content.filter(
      (block): block is { type: 'text'; text?: string } =>
        block.type === 'text',
    )
    const commandBlock = textBlocks.find((block) =>
      block.text?.includes('<command-name>'),
    )
    if (commandBlock?.text) {
      return commandBlock.text.slice(
        commandBlock.text.indexOf('<command-name>'),
      )
    }
    if (textBlocks[0]?.text) return textBlocks[0].text
  }

  return ''
}

/**
 * Compute Claude Code's cch token over the final serialized request body.
 *
 * Real Claude Code signs the full body bytes with xxHash64 using a fixed seed,
 * masks to 20 bits, and writes that value into the billing-header placeholder.
 */
export async function computeCCH(bodyBytes: Uint8Array): Promise<string> {
  await ensureXxhash()
  const hash = xxhash64Raw?.(bodyBytes, CCH_SEED) ?? 0n
  return (hash & 0xfffffn).toString(16).padStart(5, '0')
}

export async function computeXxhash64Hex(value: string): Promise<string> {
  await ensureXxhash()
  const hash = xxhash64Raw?.(new TextEncoder().encode(value), 0n) ?? 0n
  return hash.toString(16).padStart(16, '0').slice(0, 16)
}

export function resetBillingHeaderCCH(bodyString: string): string {
  return bodyString.replace(BILLING_HEADER_CCH_PATTERN, `$1${CCH_PLACEHOLDER}`)
}

export function extractBillingHeaderCCH(bodyString: string): string | null {
  return BILLING_HEADER_CCH_PATTERN.exec(bodyString)?.[2] ?? null
}

export async function signRequestBody(bodyString: string): Promise<string> {
  if (!BILLING_HEADER_CCH_PATTERN.test(bodyString)) return bodyString

  const unsignedBodyString = resetBillingHeaderCCH(bodyString)
  const canonicalBody = JSON.parse(unsignedBodyString) as Record<
    string,
    unknown
  >
  if ('model' in canonicalBody) canonicalBody.model = ''
  delete canonicalBody.max_tokens
  const token = await computeCCH(
    new TextEncoder().encode(JSON.stringify(canonicalBody)),
  )
  return unsignedBodyString.replace(
    BILLING_HEADER_CCH_PLACEHOLDER_PATTERN,
    `$1cch=${token};`,
  )
}

/**
 * Compute Claude Code's 3-character suffix for cc_version.
 */
export function computeCcVersionSuffix(
  firstUserText: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const sampledText = CCH_POSITIONS.map(
    (position) => firstUserText[position] ?? '0',
  ).join('')
  return createHash('sha256')
    .update(`${CCH_SALT}${sampledText}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Build the billing header with a cch placeholder.
 * signRequestBody() must run after final request serialization to replace it.
 */
export function buildBillingHeaderValue(
  messages: Message[],
  version: string = CLAUDE_CODE_VERSION,
  entrypoint: string,
  pinnedFirstUserText?: string,
): string {
  const suffix = computeCcVersionSuffix(
    pinnedFirstUserText ?? extractFirstUserMessageText(messages),
    version,
  )

  return (
    'x-anthropic-billing-header: ' +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    'cch=00000;'
  )
}
