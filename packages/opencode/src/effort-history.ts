import { createHash } from 'node:crypto'
import {
  type AdaptiveEffort,
  defaultAdaptiveEffort,
  logger,
  normalizeAdaptiveEffort,
  pinsEffortOnEveryRequest,
  resolveClaudeModelCapabilities,
  supportsPerMessageEffort,
} from '@cortexkit/anthropic-auth-core'

const MAX_EFFORT_MARKERS = 512
const MAX_TRACKED_EFFORT_PLANS = 1024
const MAX_TRACKED_EFFORT_PLAN_HISTORY = 4096
const MARKER_CHECK_HEX_LENGTH = 32
const SCOPE_HEX_LENGTH = 32
const MESSAGE_ID_PATTERN = '[A-Za-z0-9_-]{1,128}'
const LEGACY_MARKER_PREFIX = '<cortexkit-internal-effort '
const LEGACY_PLAN_MARKER_PREFIX = '<cortexkit-internal-effort-plan '
const INTERNAL_MARKER_WRAPPER_PATTERN = /^\s*(?:§[0-9]+§\s*)+$/

const EFFORT_CODES: Record<AdaptiveEffort, string> = {
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: 'z',
}
const EFFORTS_BY_CODE = Object.fromEntries(
  Object.entries(EFFORT_CODES).map(([effort, code]) => [code, effort]),
) as Record<string, AdaptiveEffort>

export const EFFORT_MARKER_PREFIX = '<cortexkit-internal-effort-v2 '
export const EFFORT_ANCHOR_PREFIX = '<cortexkit-internal-effort-anchor-v1 '
export const EFFORT_PLAN_REQUEST_HEADER = 'x-cortexkit-effort-plan'

export type OpenCodeEffortMarkerPlan = {
  scope: string
  baseline: AdaptiveEffort
  markerCount: number
  digest: string
  transitionTokens: readonly string[]
  anchorToken?: string
  sessionId: string
  messageId: string
}

type RequestEffortPlan = {
  scope: string
  baseline: AdaptiveEffort
  markerCount: number
  digest: string
}

export class EffortMarkerCorrelationError extends Error {
  constructor(
    message: string,
    readonly check = 'unspecified',
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'EffortMarkerCorrelationError'
  }
}

type OpenCodeMessageInfo = {
  id?: unknown
  sessionID?: unknown
  role?: unknown
  model?: {
    providerID?: unknown
    modelID?: unknown
    variant?: unknown
  }
}

type MutableOpenCodePart = Record<string, unknown> & {
  type?: unknown
  text?: unknown
  ignored?: unknown
  mime?: unknown
}

type MutableOpenCodeMessage = {
  info?: OpenCodeMessageInfo
  parts?: MutableOpenCodePart[]
}

type ParsedTransitionMarker = {
  scope: string
  boundary: string
  effort: AdaptiveEffort
  token: string
}

type ParsedEffortAnchor = {
  scope: string
  boundary: string
  effort: AdaptiveEffort
  digest: string
  token: string
}

type ParsedUserMessage = {
  value: unknown
  transitions: ParsedTransitionMarker[]
  anchors: ParsedEffortAnchor[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Group a model id into the per-message-effort family whose user turns share
 * one effort timeline. Every model that takes effort markers (Fable 5.1/5.2,
 * Opus 5.5 and Sonnet 5.5) is its own family, and turns sent to a different
 * family in the same session are left out: an Opus 5.5 timeline never counts
 * Sonnet 5.5 or Fable 5.1/5.2 turns, and the reverse.
 */
function perMessageEffortFamily(model: unknown): string | undefined {
  // Models whose capability row allows effort markers; the family is the
  // row's id without its `claude-` prefix, such as `fable-5-2`.
  const capabilities = resolveClaudeModelCapabilities(model)
  if (!capabilities || capabilities.effortMarkers === 'none') return undefined
  return capabilities.id.replace(/^claude-/, '')
}

function userEffortFamily(
  item: MutableOpenCodeMessage | undefined,
): string | undefined {
  if (item?.info?.role !== 'user') return undefined
  if (item.info.model?.providerID !== 'anthropic') return undefined
  return perMessageEffortFamily(item.info.model.modelID)
}

function userEffort(item: MutableOpenCodeMessage): AdaptiveEffort {
  return (
    normalizeAdaptiveEffort(item.info?.model?.variant) ??
    defaultAdaptiveEffort(item.info?.model?.modelID)
  )
}

function hasLowerableUserPart(item: MutableOpenCodeMessage): boolean {
  return (
    item.parts?.some((part) => {
      if (part.type === 'text') {
        return part.ignored !== true && part.text !== ''
      }
      if (part.type === 'file') {
        return (
          part.mime !== 'text/plain' && part.mime !== 'application/x-directory'
        )
      }
      return part.type === 'compaction' || part.type === 'subtask'
    }) ?? false
  )
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function markerScope(sessionId: string): string {
  return digest(`scope:${sessionId}`).slice(0, SCOPE_HEX_LENGTH)
}

function markerCheck(payload: string): string {
  return digest(`cortexkit-effort-v2:${payload}`).slice(
    0,
    MARKER_CHECK_HEX_LENGTH,
  )
}

function transitionMarker(
  scope: string,
  boundary: string,
  effort: AdaptiveEffort,
): string {
  const effortCode = EFFORT_CODES[effort]
  const payload = `transition:${scope}:${boundary}:${effortCode}`
  return `${EFFORT_MARKER_PREFIX}scope="${scope}" boundary="${boundary}" effort="${effortCode}" check="${markerCheck(payload)}"/>`
}

function parseTransitionMarker(text: string): ParsedTransitionMarker | null {
  const match = text.match(
    new RegExp(
      `^${EFFORT_MARKER_PREFIX}scope="([0-9a-f]{${SCOPE_HEX_LENGTH}})" boundary="(${MESSAGE_ID_PATTERN})" effort="([lmhxz])" check="([0-9a-f]{${MARKER_CHECK_HEX_LENGTH}})"/>$`,
    ),
  )
  if (!match) return null
  const [, scope, boundary, effortCode, check] = match
  const effort = EFFORTS_BY_CODE[effortCode ?? '']
  if (!scope || !boundary || !effortCode || !check || !effort) return null
  const payload = `transition:${scope}:${boundary}:${effortCode}`
  if (markerCheck(payload) !== check) return null
  return { scope, boundary, effort, token: text }
}

function effortAnchor(
  scope: string,
  boundary: string,
  effort: AdaptiveEffort,
  planHash: string,
): string {
  const effortCode = EFFORT_CODES[effort]
  const payload = `anchor:${scope}:${boundary}:${effortCode}:${planHash}`
  return `${EFFORT_ANCHOR_PREFIX}scope="${scope}" boundary="${boundary}" effort="${effortCode}" digest="${planHash}" check="${markerCheck(payload)}"/>`
}

function parseEffortAnchor(text: string): ParsedEffortAnchor | null {
  const match = text.match(
    new RegExp(
      `^${EFFORT_ANCHOR_PREFIX}scope="([0-9a-f]{${SCOPE_HEX_LENGTH}})" boundary="(${MESSAGE_ID_PATTERN})" effort="([lmhxz])" digest="([0-9a-f]{64})" check="([0-9a-f]{${MARKER_CHECK_HEX_LENGTH}})"/>$`,
    ),
  )
  if (!match) return null
  const [, scope, boundary, effortCode, planHash, check] = match
  const effort = EFFORTS_BY_CODE[effortCode ?? '']
  if (!scope || !boundary || !effortCode || !planHash || !check || !effort) {
    return null
  }
  const payload = `anchor:${scope}:${boundary}:${effortCode}:${planHash}`
  if (markerCheck(payload) !== check) return null
  return { scope, boundary, effort, digest: planHash, token: text }
}

function isInternalMarkerWrapperOnly(text: string): boolean {
  return text.trim() === '' || INTERNAL_MARKER_WRAPPER_PATTERN.test(text)
}

function legacyMarkerPattern(): RegExp {
  return new RegExp(
    `(?:${LEGACY_PLAN_MARKER_PREFIX}nonce="[^"]+" baseline="[^"]+" count="[^"]+" sig="[0-9a-f]+"/>|${LEGACY_MARKER_PREFIX}nonce="[^"]+" effort="[^"]+" sig="[0-9a-f]+"/>)`,
    'g',
  )
}

function transitionMarkerPattern(): RegExp {
  return new RegExp(
    `${EFFORT_MARKER_PREFIX}scope="[0-9a-f]{${SCOPE_HEX_LENGTH}}" boundary="${MESSAGE_ID_PATTERN}" effort="[lmhxz]" check="[0-9a-f]{${MARKER_CHECK_HEX_LENGTH}}"/>`,
    'g',
  )
}

function effortAnchorPattern(): RegExp {
  return new RegExp(
    `${EFFORT_ANCHOR_PREFIX}scope="[0-9a-f]{${SCOPE_HEX_LENGTH}}" boundary="${MESSAGE_ID_PATTERN}" effort="[lmhxz]" digest="[0-9a-f]{64}" check="[0-9a-f]{${MARKER_CHECK_HEX_LENGTH}}"/>`,
    'g',
  )
}

function stripMarkers(
  text: string,
  onTransition?: (transition: ParsedTransitionMarker) => void,
  onAnchor?: (anchor: ParsedEffortAnchor) => void,
): { text: string; removed: number } {
  let removed = 0
  let stripped = text
  const withoutLegacy = text.replace(legacyMarkerPattern(), '')
  if (
    withoutLegacy !== text &&
    INTERNAL_MARKER_WRAPPER_PATTERN.test(withoutLegacy)
  ) {
    removed += [...text.matchAll(legacyMarkerPattern())].length
    stripped = withoutLegacy
  }
  stripped = stripped.replace(transitionMarkerPattern(), (token) => {
    const transition = parseTransitionMarker(token)
    if (!transition) return token
    onTransition?.(transition)
    removed++
    return ''
  })
  stripped = stripped.replace(effortAnchorPattern(), (token) => {
    const anchor = parseEffortAnchor(token)
    if (!anchor) return token
    onAnchor?.(anchor)
    removed++
    return ''
  })
  return { text: stripped, removed }
}

function removeInternalMarkers(messages: MutableOpenCodeMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue
    message.parts = message.parts.flatMap((part) => {
      if (
        part.type !== 'text' ||
        typeof part.text !== 'string' ||
        !part.text.includes('<cortexkit-internal-effort')
      ) {
        return [part]
      }
      const stripped = stripMarkers(part.text)
      if (stripped.removed === 0) return [part]
      if (isInternalMarkerWrapperOnly(stripped.text)) return []
      part.text = stripped.text
      return [part]
    })
  }
}

function planDigest(
  scope: string,
  baseline: AdaptiveEffort,
  markerCount: number,
  transitionTokens: readonly string[],
  currentBoundary?: string,
): string {
  const boundaryToken = currentBoundary ? `:${currentBoundary}` : ''
  const planToken = `plan:${scope}:${EFFORT_CODES[baseline]}:${markerCount.toString(36)}${boundaryToken}`
  return digest([planToken, ...transitionTokens].join('\n'))
}

export function encodeOpenCodeEffortPlan(
  plan: OpenCodeEffortMarkerPlan,
): string {
  return [
    'v2',
    plan.scope,
    EFFORT_CODES[plan.baseline],
    plan.markerCount.toString(36),
    plan.digest,
  ].join('.')
}

function parseRequestEffortPlan(
  value: string | undefined,
): RequestEffortPlan | null {
  if (!value) return null
  const match = value.match(
    /^v2\.([0-9a-f]{32})\.([lmhxz])\.([0-9a-z]+)\.([0-9a-f]{64})$/,
  )
  if (!match) return null
  const [, scope, baselineCode, countCode, planHash] = match
  const baseline = EFFORTS_BY_CODE[baselineCode ?? '']
  const markerCount = Number.parseInt(countCode ?? '', 36)
  if (
    !scope ||
    !baseline ||
    !planHash ||
    !Number.isSafeInteger(markerCount) ||
    markerCount < 0 ||
    markerCount > MAX_EFFORT_MARKERS
  ) {
    return null
  }
  return { scope, baseline, markerCount, digest: planHash }
}

/**
 * Annotate effort-changing user turns before OpenCode lowers its internal
 * message records. Markers are stable by session/message identity so later
 * transforms may persist and restore them without changing request lineage.
 */
export function markOpenCodeEffortTransitions(
  messages: MutableOpenCodeMessage[],
): OpenCodeEffortMarkerPlan | null {
  const currentUser = messages.findLast((item) => item.info?.role === 'user')
  const family = userEffortFamily(currentUser)
  if (!currentUser || !family) return null

  removeInternalMarkers(messages)
  if (!Array.isArray(currentUser.parts) || !hasLowerableUserPart(currentUser)) {
    return null
  }
  const sessionId = currentUser.info?.sessionID
  const messageId = currentUser.info?.id
  if (typeof sessionId !== 'string' || typeof messageId !== 'string') {
    throw new EffortMarkerCorrelationError(
      'Cannot correlate per-message effort markers without session and message IDs',
    )
  }
  const scope = markerScope(sessionId)

  const compaction = messages.findLast(
    (item) =>
      item.info?.role === 'user' &&
      item.parts?.some((part) => part.type === 'compaction'),
  )
  const compactionId =
    typeof compaction?.info?.id === 'string' ? compaction.info.id : undefined
  let baseline: AdaptiveEffort | undefined
  let activeEffort: AdaptiveEffort | undefined
  if (compaction && userEffortFamily(compaction) === family) {
    baseline = userEffort(compaction)
    activeEffort = baseline
  }

  const transitionTokens: string[] = []
  for (const item of messages) {
    const info = item.info
    if (info?.role !== 'user') continue
    if (
      compactionId &&
      typeof info.id === 'string' &&
      info.id <= compactionId
    ) {
      continue
    }
    if (userEffortFamily(item) !== family || !hasLowerableUserPart(item)) {
      continue
    }

    const effort = userEffort(item)
    if (!baseline) {
      baseline = effort
      activeEffort = effort
      continue
    }
    if (effort === activeEffort) continue
    if (transitionTokens.length >= MAX_EFFORT_MARKERS) {
      throw new EffortMarkerCorrelationError(
        'Too many per-message effort changes in the active context',
      )
    }
    if (!Array.isArray(item.parts) || typeof info.id !== 'string') {
      throw new EffortMarkerCorrelationError(
        'Cannot mark a per-message effort change without message identity',
      )
    }
    const token = transitionMarker(scope, info.id, effort)
    item.parts.push({ type: 'text', text: token })
    transitionTokens.push(token)
    activeEffort = effort
  }

  if (!baseline) return null
  const planHash = planDigest(
    scope,
    baseline,
    transitionTokens.length,
    transitionTokens,
    transitionTokens.length > 0 ? messageId : undefined,
  )
  const anchorToken =
    transitionTokens.length > 0
      ? effortAnchor(scope, messageId, activeEffort ?? baseline, planHash)
      : undefined
  if (anchorToken) currentUser.parts.push({ type: 'text', text: anchorToken })
  return {
    scope,
    baseline,
    markerCount: transitionTokens.length,
    digest: planHash,
    transitionTokens,
    anchorToken,
    sessionId,
    messageId,
  }
}

function consumeInternalMarkers(body: Record<string, unknown>): {
  messages: ParsedUserMessage[]
} {
  const values = Array.isArray(body.messages) ? body.messages : []
  const messages: ParsedUserMessage[] = []

  for (const value of values) {
    const transitions: ParsedTransitionMarker[] = []
    const anchors: ParsedEffortAnchor[] = []
    if (!isRecord(value) || value.role !== 'user') {
      messages.push({ value, transitions, anchors })
      continue
    }

    const stripText = (text: string) =>
      stripMarkers(
        text,
        (transition) => transitions.push(transition),
        (anchor) => anchors.push(anchor),
      )

    if (typeof value.content === 'string') {
      const stripped = stripText(value.content)
      value.content =
        stripped.removed > 0 && isInternalMarkerWrapperOnly(stripped.text)
          ? ''
          : stripped.text
    } else if (Array.isArray(value.content)) {
      value.content = value.content.flatMap((block) => {
        if (
          !isRecord(block) ||
          block.type !== 'text' ||
          typeof block.text !== 'string'
        ) {
          return [block]
        }
        const stripped = stripText(block.text)
        if (
          stripped.removed > 0 &&
          isInternalMarkerWrapperOnly(stripped.text)
        ) {
          return []
        }
        return [{ ...block, text: stripped.text }]
      })
    }
    messages.push({ value, transitions, anchors })
  }

  body.messages = messages.map((message) => message.value)
  return { messages }
}

function isToolResultContinuation(
  messages: ParsedUserMessage[],
  userMessageIndex: number,
): boolean {
  const userMessage = messages[userMessageIndex]?.value
  const assistantMessage = messages[userMessageIndex - 1]?.value
  if (
    !isRecord(userMessage) ||
    userMessage.role !== 'user' ||
    !Array.isArray(userMessage.content) ||
    userMessage.content.length === 0 ||
    !isRecord(assistantMessage) ||
    assistantMessage.role !== 'assistant' ||
    !Array.isArray(assistantMessage.content)
  ) {
    return false
  }
  const toolUseIds = new Set(
    assistantMessage.content.flatMap((block) =>
      isRecord(block) &&
      block.type === 'tool_use' &&
      typeof block.id === 'string'
        ? [block.id]
        : [],
    ),
  )
  return userMessage.content.every(
    (block) =>
      isRecord(block) &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      toolUseIds.has(block.tool_use_id),
  )
}

function hasOnlyToolContinuationsAfterAnchor(
  messages: ParsedUserMessage[],
  anchorMessageIndex: number,
): boolean {
  if (anchorMessageIndex < 0) return false
  const trailingUserIndexes = messages.flatMap((message, index) =>
    index > anchorMessageIndex &&
    isRecord(message.value) &&
    message.value.role === 'user'
      ? [index]
      : [],
  )
  return (
    trailingUserIndexes.length > 0 &&
    trailingUserIndexes.every((index) =>
      isToolResultContinuation(messages, index),
    )
  )
}

function providerMessageId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.id === 'string') return value.id
  return typeof value.message_id === 'string' ? value.message_id : null
}

function resolveExpectedPlan(
  requestPlan: RequestEffortPlan,
  resolvedPlan: OpenCodeEffortMarkerPlan | undefined,
): {
  transitions: ParsedTransitionMarker[]
  anchor: ParsedEffortAnchor | null
} | null {
  if (!resolvedPlan) return null
  if (
    resolvedPlan.scope !== requestPlan.scope ||
    resolvedPlan.baseline !== requestPlan.baseline ||
    resolvedPlan.markerCount !== requestPlan.markerCount ||
    resolvedPlan.digest !== requestPlan.digest ||
    resolvedPlan.transitionTokens.length !== requestPlan.markerCount
  ) {
    throw new EffortMarkerCorrelationError(
      'Per-message effort marker request plan mismatch',
    )
  }
  const transitions = resolvedPlan.transitionTokens.map((token) =>
    parseTransitionMarker(token),
  )
  const anchor = resolvedPlan.anchorToken
    ? parseEffortAnchor(resolvedPlan.anchorToken)
    : null
  const expectedEffort = transitions.at(-1)?.effort ?? requestPlan.baseline
  if (
    transitions.some((transition) => transition === null) ||
    transitions.some((transition) => transition?.scope !== requestPlan.scope) ||
    (requestPlan.markerCount > 0 &&
      (!anchor ||
        anchor.scope !== requestPlan.scope ||
        anchor.boundary !== resolvedPlan.messageId ||
        anchor.effort !== expectedEffort ||
        anchor.digest !== requestPlan.digest)) ||
    (requestPlan.markerCount === 0 && anchor !== null) ||
    requestPlan.digest !==
      planDigest(
        requestPlan.scope,
        requestPlan.baseline,
        requestPlan.markerCount,
        resolvedPlan.transitionTokens,
        resolvedPlan.markerCount > 0 ? resolvedPlan.messageId : undefined,
      )
  ) {
    throw new EffortMarkerCorrelationError(
      'Per-message effort marker request plan mismatch',
    )
  }
  return {
    transitions: transitions as ParsedTransitionMarker[],
    anchor,
  }
}

type BodyPlanResolution = {
  effectiveBaseline: AdaptiveEffort
  // One entry per wire message that receives an effort system message, as
  // "<message index>:<effort>", with the effort read from the plan.
  systemMarkers: string[]
}

/**
 * Match the body's surviving transition markers against the end of a plan's
 * transition list. A later message transform may trim old history, so leading
 * transitions can be missing; the last missing one sets the effective
 * baseline. Throws when the body is not such a suffix of the plan.
 */
function resolveBodyAgainstPlan(
  planTransitions: readonly ParsedTransitionMarker[],
  planBaseline: AdaptiveEffort,
  messages: readonly ParsedUserMessage[],
  anchor: ParsedEffortAnchor | undefined,
): BodyPlanResolution {
  const transitions = messages.flatMap((message) => message.transitions)
  const found = transitions.length
  const trimmedPrefix = planTransitions.length - found
  if (trimmedPrefix < 0) {
    throw new EffortMarkerCorrelationError(
      `Per-message effort marker correlation failed: expected ${planTransitions.length}, found ${found}`,
    )
  }
  const expectedSuffix = planTransitions.slice(trimmedPrefix)
  if (
    transitions.some(
      (transition, index) => transition.token !== expectedSuffix[index]?.token,
    )
  ) {
    throw new EffortMarkerCorrelationError(
      'Per-message effort marker non-prefix loss',
    )
  }
  const removedTransitions = planTransitions.slice(0, trimmedPrefix)
  if (
    anchor &&
    removedTransitions.some(
      (transition) => transition.boundary === anchor.boundary,
    )
  ) {
    throw new EffortMarkerCorrelationError(
      'Per-message effort marker non-prefix loss',
    )
  }
  const systemMarkers: string[] = []
  let seen = 0
  messages.forEach((message, index) => {
    if (message.transitions.length === 0) return
    seen += message.transitions.length
    systemMarkers.push(`${index}:${expectedSuffix[seen - 1]?.effort}`)
  })
  return {
    effectiveBaseline: removedTransitions.at(-1)?.effort ?? planBaseline,
    systemMarkers,
  }
}

/**
 * Two plans for the same user message are prefix-trim consistent when the
 * shorter one is the longer one with its oldest transitions folded into the
 * baseline: its transitions are the longer plan's last ones, and its baseline
 * is the effort of the last transition it drops (or the longer plan's
 * baseline when it drops none).
 */
function isPrefixTrimConsistent(
  first: {
    baseline: AdaptiveEffort
    transitions: readonly ParsedTransitionMarker[]
  },
  second: {
    baseline: AdaptiveEffort
    transitions: readonly ParsedTransitionMarker[]
  },
): boolean {
  const [longer, shorter] =
    first.transitions.length >= second.transitions.length
      ? [first, second]
      : [second, first]
  const dropped = longer.transitions.length - shorter.transitions.length
  if (
    shorter.transitions.some(
      (transition, index) =>
        transition.token !== longer.transitions[dropped + index]?.token,
    )
  ) {
    return false
  }
  const foldedBaseline =
    dropped > 0 ? longer.transitions[dropped - 1]?.effort : longer.baseline
  return shorter.baseline === foldedBaseline
}

/**
 * Find the recorded plan behind a body anchor that differs from the header
 * plan's anchor, and return it only when sending the body under the header
 * plan is provably the same as sending it under that plan.
 *
 * OpenCode runs the messages transform on every tool-loop step, so the same
 * user message can be planned again after its history window moved (for
 * example when a compaction marker moved). A message transform that runs
 * after ours can then put back the anchor text we appended on an earlier
 * step. Returns null in every other case, and the caller refuses the request.
 */
function equivalentRecordedPlan(input: {
  anchor: ParsedEffortAnchor
  anchorCount: number
  headerPlan: OpenCodeEffortMarkerPlan
  headerTransitions: readonly ParsedTransitionMarker[]
  headerAnchor: ParsedEffortAnchor
  recordedVersions: readonly OpenCodeEffortMarkerPlan[]
  messages: readonly ParsedUserMessage[]
}): OpenCodeEffortMarkerPlan | null {
  const { anchor, headerPlan, headerAnchor } = input
  // The anchor's checksum was verified when it was parsed from the body.
  if (
    input.anchorCount !== 1 ||
    anchor.scope !== headerAnchor.scope ||
    anchor.boundary !== headerAnchor.boundary
  ) {
    return null
  }
  const bodyPlan = input.recordedVersions.find(
    (version) =>
      version.sessionId === headerPlan.sessionId &&
      version.messageId === headerPlan.messageId &&
      version.digest !== headerPlan.digest &&
      version.anchorToken === anchor.token,
  )
  if (!bodyPlan) return null
  try {
    const bodyExpected = resolveExpectedPlan(
      {
        scope: bodyPlan.scope,
        baseline: bodyPlan.baseline,
        markerCount: bodyPlan.markerCount,
        digest: bodyPlan.digest,
      },
      bodyPlan,
    )
    if (
      !bodyExpected?.anchor ||
      bodyExpected.anchor.token !== anchor.token ||
      bodyExpected.anchor.effort !== headerAnchor.effort ||
      !isPrefixTrimConsistent(
        {
          baseline: headerPlan.baseline,
          transitions: input.headerTransitions,
        },
        { baseline: bodyPlan.baseline, transitions: bodyExpected.transitions },
      )
    ) {
      return null
    }
    const underHeader = resolveBodyAgainstPlan(
      input.headerTransitions,
      headerPlan.baseline,
      input.messages,
      anchor,
    )
    const underBody = resolveBodyAgainstPlan(
      bodyExpected.transitions,
      bodyPlan.baseline,
      input.messages,
      anchor,
    )
    if (
      underHeader.effectiveBaseline !== underBody.effectiveBaseline ||
      underHeader.systemMarkers.join('\n') !==
        underBody.systemMarkers.join('\n')
    ) {
      return null
    }
  } catch (error) {
    if (error instanceof EffortMarkerCorrelationError) return null
    throw error
  }
  return bodyPlan
}

/**
 * Consume request-correlated markers and, when enabled for a model that
 * supports per-message effort, insert Anthropic effort system messages.
 * `recordedVersions` lists every plan still recorded for the
 * resolved plan's user message; it is consulted only when the body's anchor
 * differs from the header plan's.
 */
export function applyOpenCodeEffortMarkers(
  body: Record<string, unknown>,
  enabled: boolean,
  requestPlanHeader?: string,
  resolvedPlan?: OpenCodeEffortMarkerPlan,
  recordedVersions: readonly OpenCodeEffortMarkerPlan[] = [],
): { found: number; inserted: number } {
  if (!Array.isArray(body.messages)) return { found: 0, inserted: 0 }
  const requestPlan = parseRequestEffortPlan(requestPlanHeader)
  if (requestPlanHeader && !requestPlan) {
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal per-message effort request plan',
    )
  }

  const expectedPlan = requestPlan
    ? resolveExpectedPlan(requestPlan, resolvedPlan)
    : null
  const expectedTransitions = expectedPlan?.transitions ?? null

  const hasCandidate = body.messages.some((value) => {
    if (!isRecord(value) || value.role !== 'user') return false
    if (
      typeof value.content === 'string' &&
      value.content.includes('<cortexkit-internal-effort')
    ) {
      return true
    }
    return (
      Array.isArray(value.content) &&
      value.content.some(
        (block) =>
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('<cortexkit-internal-effort'),
      )
    )
  })

  if (!hasCandidate) {
    if (!requestPlan) return { found: 0, inserted: 0 }
    if (requestPlan.markerCount !== 0) {
      // Without any surviving anchor we cannot prove a prefix trim, even when
      // an older request plan still resolves. Log only shape and trusted plan
      // metadata so the next occurrence can distinguish full history removal
      // from downstream marker stripping without exposing user content.
      const lastUserMessageIndex = body.messages.findLastIndex(
        (message) => isRecord(message) && message.role === 'user',
      )
      const lastUserMessage = body.messages[lastUserMessageIndex]
      const lastUserContent =
        isRecord(lastUserMessage) && Array.isArray(lastUserMessage.content)
          ? lastUserMessage.content
          : []
      throw new EffortMarkerCorrelationError(
        `Per-message effort marker correlation failed: expected ${requestPlan.markerCount}, found 0`,
        'missing_all_markers',
        {
          markerCount: requestPlan.markerCount,
          resolvedPlan: expectedPlan !== null,
          plannedBoundaryId: expectedPlan?.anchor?.boundary ?? null,
          expectedAnchorHash: expectedPlan?.anchor
            ? digest(expectedPlan.anchor.token)
            : null,
          retainedMessageCount: body.messages.length,
          retainedUserMessageCount: body.messages.filter(
            (message) => isRecord(message) && message.role === 'user',
          ).length,
          lastUserMessageIndex,
          lastUserTextBlockCount: lastUserContent.filter(
            (block) => isRecord(block) && block.type === 'text',
          ).length,
          lastUserToolResultBlockCount: lastUserContent.filter(
            (block) => isRecord(block) && block.type === 'tool_result',
          ).length,
        },
      )
    }
    if (
      !expectedTransitions &&
      requestPlan.digest !==
        planDigest(requestPlan.scope, requestPlan.baseline, 0, [])
    ) {
      throw new EffortMarkerCorrelationError(
        'Per-message effort marker request plan mismatch',
      )
    }
    // Only models with `effortMarkers: "always"` (Fable 5.1/5.2) pin top-level
    // effort on a request without surviving markers; the other models keep
    // the host's request unchanged here.
    if (enabled && pinsEffortOnEveryRequest(body.model)) {
      const outputConfig = isRecord(body.output_config)
        ? { ...body.output_config }
        : {}
      outputConfig.effort =
        expectedTransitions?.at(-1)?.effort ?? requestPlan.baseline
      body.output_config = outputConfig
    }
    return { found: 0, inserted: 0 }
  }

  const consumed = consumeInternalMarkers(body)
  const transitions = consumed.messages.flatMap(
    (message) => message.transitions,
  )
  const anchors = consumed.messages.flatMap((message) => message.anchors)
  const found = transitions.length
  if (!requestPlan) {
    // Marker-shaped user text without a trusted internal plan remains untouched.
    if (found === 0) return { found: 0, inserted: 0 }
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal per-message effort request plan',
    )
  }

  for (const message of consumed.messages) {
    // Consecutive host user records collapse into one wire message, so a
    // boundary may legitimately carry several transitions. The flat checks
    // below pin their order and identity; every one still needs its scope
    // verified, not just the first.
    for (const transition of message.transitions) {
      if (transition.scope !== requestPlan.scope) {
        throw new EffortMarkerCorrelationError(
          'Per-message effort marker scope mismatch',
        )
      }
    }
    if (message.anchors.length > 1) {
      throw new EffortMarkerCorrelationError(
        'Multiple internal per-message effort anchors on one user boundary',
      )
    }
  }
  const anchorMessageIndex = consumed.messages.findIndex(
    (message) => message.anchors.length === 1,
  )
  const lastUserMessageIndex = consumed.messages.findLastIndex(
    (message) => isRecord(message.value) && message.value.role === 'user',
  )
  const anchor = anchors[0]
  const lastUserMessage = consumed.messages[lastUserMessageIndex]?.value
  const validToolContinuationSuffix = hasOnlyToolContinuationsAfterAnchor(
    consumed.messages,
    anchorMessageIndex,
  )
  if (
    requestPlan.markerCount > 0 &&
    (anchors.length !== 1 ||
      (anchorMessageIndex !== lastUserMessageIndex &&
        !validToolContinuationSuffix) ||
      !anchor ||
      anchor.scope !== requestPlan.scope)
  ) {
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal per-message effort anchor placement',
      'anchor_placement',
      {
        anchorBoundaryId: anchor?.boundary ?? null,
        plannedBoundaryId: expectedPlan?.anchor?.boundary ?? null,
        lastUserMessageId: providerMessageId(lastUserMessage),
        anchorMessageIndex,
        lastUserMessageIndex,
        validToolContinuationSuffix,
        anchorsFound: anchors.length,
        markerCount: requestPlan.markerCount,
        scope: requestPlan.scope,
        foundScope: anchor?.scope ?? null,
        expectedAnchorHash: expectedPlan?.anchor
          ? digest(expectedPlan.anchor.token)
          : null,
        foundAnchorHash: anchor ? digest(anchor.token) : null,
        anchorMatchesExpected:
          expectedPlan?.anchor != null &&
          anchor?.token === expectedPlan.anchor.token,
      },
    )
  }
  if (requestPlan.markerCount === 0 && anchors.length !== 0) {
    throw new EffortMarkerCorrelationError(
      'Unexpected internal per-message effort anchor',
    )
  }
  if (expectedPlan?.anchor && anchor?.token !== expectedPlan.anchor.token) {
    const equivalentPlan =
      anchor && resolvedPlan && expectedTransitions
        ? equivalentRecordedPlan({
            anchor,
            anchorCount: anchors.length,
            headerPlan: resolvedPlan,
            headerTransitions: expectedTransitions,
            headerAnchor: expectedPlan.anchor,
            recordedVersions,
            messages: consumed.messages,
          })
        : null
    if (!equivalentPlan) {
      throw new EffortMarkerCorrelationError(
        'Mismatched internal per-message effort anchor token',
        'anchor_token',
        {
          anchorBoundaryId: anchor?.boundary ?? null,
          plannedBoundaryId: expectedPlan.anchor.boundary,
          lastUserMessageId: providerMessageId(lastUserMessage),
          anchorMessageIndex,
          lastUserMessageIndex,
          anchorsFound: anchors.length,
          markerCount: requestPlan.markerCount,
          scope: requestPlan.scope,
          foundScope: anchor?.scope ?? null,
          expectedAnchorHash: digest(expectedPlan.anchor.token),
          foundAnchorHash: anchor ? digest(anchor.token) : null,
          anchorMatchesExpected: false,
        },
      )
    }
    // The request still goes out exactly as the header plan dictates. Log the
    // substitution so a later message transform restoring stale anchors stays
    // visible; hashes and ids only, never prompt text.
    logger.warn(
      'effort-history',
      'accepted an earlier effort anchor whose plan gives the same efforts',
      {
        check: 'anchor_token_equivalent_plan',
        plannedBoundaryId: expectedPlan.anchor.boundary,
        markerCount: requestPlan.markerCount,
        foundPlanMarkerCount: equivalentPlan.markerCount,
        markersFound: found,
        expectedAnchorHash: digest(expectedPlan.anchor.token),
        foundAnchorHash: anchor ? digest(anchor.token) : null,
      },
    )
  }
  let effectiveBaseline = requestPlan.baseline
  if (expectedTransitions) {
    effectiveBaseline = resolveBodyAgainstPlan(
      expectedTransitions,
      requestPlan.baseline,
      consumed.messages,
      anchor,
    ).effectiveBaseline
  } else {
    if (found !== requestPlan.markerCount) {
      throw new EffortMarkerCorrelationError(
        `Per-message effort marker correlation failed: expected ${requestPlan.markerCount}, found ${found}`,
      )
    }
    const actualDigest = planDigest(
      requestPlan.scope,
      requestPlan.baseline,
      requestPlan.markerCount,
      transitions.map((transition) => transition.token),
      anchor?.boundary,
    )
    if (requestPlan.digest !== actualDigest) {
      throw new EffortMarkerCorrelationError(
        'Per-message effort marker request plan mismatch',
      )
    }
    const expectedEffort = transitions.at(-1)?.effort ?? requestPlan.baseline
    if (
      anchor &&
      (anchor.effort !== expectedEffort || anchor.digest !== requestPlan.digest)
    ) {
      throw new EffortMarkerCorrelationError(
        'Missing or invalid internal per-message effort anchor',
      )
    }
  }

  const applyConfig = enabled && supportsPerMessageEffort(body)
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of consumed.messages) {
    const transition = message.transitions.at(-1)
    if (transition && applyConfig) {
      rewritten.push({
        role: 'system',
        content: [],
        output_config: { effort: transition.effort },
      })
      inserted++
    }
    rewritten.push(message.value)
  }
  body.messages = rewritten
  // Models with `effortMarkers: "always"` (Fable 5.1/5.2) always pin the earliest
  // effort. The other models change top-level effort only when a marker
  // carries the later effort.
  if (applyConfig && (inserted > 0 || pinsEffortOnEveryRequest(body.model))) {
    const outputConfig = isRecord(body.output_config)
      ? { ...body.output_config }
      : {}
    outputConfig.effort = effectiveBaseline
    body.output_config = outputConfig
  }
  return { found, inserted }
}

export class OpenCodeEffortPlanTracker {
  private readonly plans = new Map<string, OpenCodeEffortMarkerPlan>()
  // A prefix trim may re-record the same user message before an older request
  // header is consumed. Keep both versions, but revoke them together on clear.
  private readonly history = new Map<string, OpenCodeEffortMarkerPlan>()
  private readonly historyByMessage = new Map<string, Set<string>>()

  record(plan: OpenCodeEffortMarkerPlan): void {
    const key = this.key(plan.sessionId, plan.messageId)
    const stored = { ...plan, transitionTokens: [...plan.transitionTokens] }
    this.remember(key, stored)
    this.plans.delete(key)
    this.plans.set(key, stored)
    while (this.plans.size > MAX_TRACKED_EFFORT_PLANS) {
      const oldest = this.plans.keys().next().value
      if (typeof oldest !== 'string') break
      this.plans.delete(oldest)
    }
  }

  clear(sessionId: string, messageId: string): void {
    const key = this.key(sessionId, messageId)
    this.plans.delete(key)
    for (const header of this.historyByMessage.get(key) ?? []) {
      this.history.delete(header)
    }
    this.historyByMessage.delete(key)
  }

  markHeaders(input: {
    sessionId: string
    messageId: string
    headers: Record<string, string>
  }): boolean {
    const key = this.key(input.sessionId, input.messageId)
    const plan = this.plans.get(key)
    if (!plan) return false
    // The host retries the same StreamInput without re-running the messages
    // transform. Refresh both indexes so active retries remain recent.
    input.headers[EFFORT_PLAN_REQUEST_HEADER] = this.remember(key, plan)
    this.plans.delete(key)
    this.plans.set(key, plan)
    return true
  }

  resolveHeader(
    value: string | undefined,
  ): OpenCodeEffortMarkerPlan | undefined {
    return value ? this.history.get(value) : undefined
  }

  /**
   * Every plan version still recorded for one user message, in the order
   * they were first recorded.
   * The fetch hands these to `applyOpenCodeEffortMarkers` so it can recognise
   * an anchor from an earlier version that gives the same efforts.
   */
  versionsFor(
    sessionId: string,
    messageId: string,
  ): OpenCodeEffortMarkerPlan[] {
    const headers = this.historyByMessage.get(this.key(sessionId, messageId))
    return [...(headers ?? [])].flatMap((header) => {
      const plan = this.history.get(header)
      return plan ? [plan] : []
    })
  }

  private remember(key: string, plan: OpenCodeEffortMarkerPlan): string {
    const header = encodeOpenCodeEffortPlan(plan)
    const previous = this.history.get(header)
    if (previous && this.key(previous.sessionId, previous.messageId) !== key) {
      // A zero-transition header has no current-boundary anchor: successive
      // same-effort turns in one session legitimately encode identically. It
      // can name only the latest owner, so move its reverse-index entry before
      // replacing it. A transition-bearing or cross-session collision remains
      // an error rather than resurrecting someone else's request plan.
      if (
        previous.markerCount !== 0 ||
        plan.markerCount !== 0 ||
        previous.sessionId !== plan.sessionId
      ) {
        throw new EffortMarkerCorrelationError(
          'Per-message effort plan header collision',
        )
      }
      const priorKey = this.key(previous.sessionId, previous.messageId)
      const priorVersions = this.historyByMessage.get(priorKey)
      priorVersions?.delete(header)
      if (priorVersions?.size === 0) this.historyByMessage.delete(priorKey)
    }
    this.history.delete(header)
    this.history.set(header, plan)
    const versions = this.historyByMessage.get(key) ?? new Set<string>()
    versions.add(header)
    this.historyByMessage.set(key, versions)
    while (this.history.size > MAX_TRACKED_EFFORT_PLAN_HISTORY) {
      const oldest = this.history.entries().next().value
      if (!oldest) break
      const [oldHeader, oldPlan] = oldest
      this.history.delete(oldHeader)
      const oldKey = this.key(oldPlan.sessionId, oldPlan.messageId)
      const oldVersions = this.historyByMessage.get(oldKey)
      oldVersions?.delete(oldHeader)
      if (oldVersions?.size === 0) this.historyByMessage.delete(oldKey)
    }
    return header
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }
}
