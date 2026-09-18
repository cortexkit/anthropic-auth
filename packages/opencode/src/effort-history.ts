import { createHash } from 'node:crypto'
import {
  type AdaptiveEffort,
  isClaudeFable51Model,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'

const MAX_EFFORT_MARKERS = 512
const MAX_TRACKED_EFFORT_PLANS = 1024
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

function isFableUser(item: MutableOpenCodeMessage | undefined): boolean {
  return (
    item?.info?.role === 'user' &&
    item.info.model?.providerID === 'anthropic' &&
    isClaudeFable51Model(item.info.model.modelID)
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
  if (!currentUser || !isFableUser(currentUser)) return null

  removeInternalMarkers(messages)
  if (!Array.isArray(currentUser.parts) || !hasLowerableUserPart(currentUser)) {
    return null
  }
  const sessionId = currentUser.info?.sessionID
  const messageId = currentUser.info?.id
  if (typeof sessionId !== 'string' || typeof messageId !== 'string') {
    throw new EffortMarkerCorrelationError(
      'Cannot correlate Fable 5.1 effort markers without session and message IDs',
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
  if (compaction && isFableUser(compaction)) {
    baseline =
      normalizeAdaptiveEffort(compaction.info?.model?.variant) ?? 'high'
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
    if (!isFableUser(item) || !hasLowerableUserPart(item)) continue

    const effort = normalizeAdaptiveEffort(info.model?.variant) ?? 'high'
    if (!baseline) {
      baseline = effort
      activeEffort = effort
      continue
    }
    if (effort === activeEffort) continue
    if (transitionTokens.length >= MAX_EFFORT_MARKERS) {
      throw new EffortMarkerCorrelationError(
        'Too many Fable 5.1 effort changes in the active context',
      )
    }
    if (!Array.isArray(item.parts) || typeof info.id !== 'string') {
      throw new EffortMarkerCorrelationError(
        'Cannot mark a Fable 5.1 effort change without message identity',
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
      'Fable 5.1 effort marker request plan mismatch',
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
      'Fable 5.1 effort marker request plan mismatch',
    )
  }
  return {
    transitions: transitions as ParsedTransitionMarker[],
    anchor,
  }
}

/** Consume request-correlated markers and insert Anthropic effort system messages. */
export function applyOpenCodeEffortMarkers(
  body: Record<string, unknown>,
  enabled: boolean,
  requestPlanHeader?: string,
  resolvedPlan?: OpenCodeEffortMarkerPlan,
): { found: number; inserted: number } {
  if (!Array.isArray(body.messages)) return { found: 0, inserted: 0 }
  const requestPlan = parseRequestEffortPlan(requestPlanHeader)
  if (requestPlanHeader && !requestPlan) {
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal Fable 5.1 effort request plan',
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
      throw new EffortMarkerCorrelationError(
        `Fable 5.1 effort marker correlation failed: expected ${requestPlan.markerCount}, found 0`,
      )
    }
    if (
      !expectedTransitions &&
      requestPlan.digest !==
        planDigest(requestPlan.scope, requestPlan.baseline, 0, [])
    ) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker request plan mismatch',
      )
    }
    if (enabled && isClaudeFable51Model(body.model)) {
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
      'Missing or invalid internal Fable 5.1 effort request plan',
    )
  }

  for (const message of consumed.messages) {
    if (message.transitions.length > 1) {
      throw new EffortMarkerCorrelationError(
        'Multiple internal Fable 5.1 effort markers on one user boundary',
      )
    }
    const transition = message.transitions[0]
    if (transition && transition.scope !== requestPlan.scope) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker scope mismatch',
      )
    }
    if (message.anchors.length > 1) {
      throw new EffortMarkerCorrelationError(
        'Multiple internal Fable 5.1 effort anchors on one user boundary',
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
      'Missing or invalid internal Fable 5.1 effort anchor placement',
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
      'Unexpected internal Fable 5.1 effort anchor',
    )
  }
  if (expectedPlan?.anchor && anchor?.token !== expectedPlan.anchor.token) {
    throw new EffortMarkerCorrelationError(
      'Mismatched internal Fable 5.1 effort anchor token',
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
  let effectiveBaseline = requestPlan.baseline
  if (expectedTransitions) {
    const trimmedPrefix = expectedTransitions.length - found
    if (trimmedPrefix < 0) {
      throw new EffortMarkerCorrelationError(
        `Fable 5.1 effort marker correlation failed: expected ${requestPlan.markerCount}, found ${found}`,
      )
    }
    const expectedSuffix = expectedTransitions.slice(trimmedPrefix)
    if (
      transitions.some(
        (transition, index) =>
          transition.token !== expectedSuffix[index]?.token,
      )
    ) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker non-prefix loss',
      )
    }
    const removedTransitions = expectedTransitions.slice(0, trimmedPrefix)
    if (
      anchor &&
      removedTransitions.some(
        (transition) => transition.boundary === anchor.boundary,
      )
    ) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker non-prefix loss',
      )
    }
    effectiveBaseline =
      removedTransitions.at(-1)?.effort ?? requestPlan.baseline
  } else {
    if (found !== requestPlan.markerCount) {
      throw new EffortMarkerCorrelationError(
        `Fable 5.1 effort marker correlation failed: expected ${requestPlan.markerCount}, found ${found}`,
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
        'Fable 5.1 effort marker request plan mismatch',
      )
    }
    const expectedEffort = transitions.at(-1)?.effort ?? requestPlan.baseline
    if (
      anchor &&
      (anchor.effort !== expectedEffort || anchor.digest !== requestPlan.digest)
    ) {
      throw new EffortMarkerCorrelationError(
        'Missing or invalid internal Fable 5.1 effort anchor',
      )
    }
  }

  const applyConfig = enabled && isClaudeFable51Model(body.model)
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of consumed.messages) {
    const transition = message.transitions[0]
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
  if (applyConfig) {
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

  record(plan: OpenCodeEffortMarkerPlan): void {
    const key = this.key(plan.sessionId, plan.messageId)
    this.plans.delete(key)
    this.plans.set(key, {
      ...plan,
      transitionTokens: [...plan.transitionTokens],
    })
    while (this.plans.size > MAX_TRACKED_EFFORT_PLANS) {
      const oldest = this.plans.keys().next().value
      if (typeof oldest !== 'string') break
      this.plans.delete(oldest)
    }
  }

  clear(sessionId: string, messageId: string): void {
    this.plans.delete(this.key(sessionId, messageId))
  }

  markHeaders(input: {
    sessionId: string
    messageId: string
    headers: Record<string, string>
  }): boolean {
    const key = this.key(input.sessionId, input.messageId)
    const plan = this.plans.get(key)
    if (!plan) return false
    input.headers[EFFORT_PLAN_REQUEST_HEADER] = encodeOpenCodeEffortPlan(plan)
    // OpenCode retries the same StreamInput after transient provider failures.
    // Its message transform runs once before the retry loop, while chat.headers
    // runs for every attempt, so keep the plan available for the same message.
    // Refresh its insertion order so an actively retried plan remains recent.
    this.plans.delete(key)
    this.plans.set(key, plan)
    return true
  }

  resolveHeader(
    value: string | undefined,
  ): OpenCodeEffortMarkerPlan | undefined {
    if (!value) return undefined
    for (const plan of this.plans.values()) {
      if (encodeOpenCodeEffortPlan(plan) === value) return plan
    }
    return undefined
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }
}
