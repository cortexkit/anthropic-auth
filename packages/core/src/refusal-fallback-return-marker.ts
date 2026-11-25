import { messageThreadCachePrefix } from './message-threads.ts'
import { refusalBodyRecord } from './refusal-fallback-prefix.ts'

type Body = Record<string, unknown>

function contentBlocks(message: Body) {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content)
      ? message.content
      : undefined
}

function cacheControl(value: Body) {
  const control = refusalBodyRecord(value.cache_control ?? value.cacheControl)
  return control?.type === 'ephemeral' ? control : undefined
}

function lifetime(control: Body) {
  return control.ttl ?? '5m'
}

function markedHolders(
  body: Body,
  candidate?: { message: Body; blockIndex: number; control: Body },
) {
  const marked: { holder: Body; control: Body; replaceable: boolean }[] = []
  const add = (
    value: unknown,
    replaceable: boolean,
    controlOverride?: Body,
  ) => {
    const holder = refusalBodyRecord(value)
    const control = controlOverride ?? (holder && cacheControl(holder))
    if (holder && control) marked.push({ holder, control, replaceable })
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) add(tool, false)
  if (Array.isArray(body.system))
    for (const block of body.system) add(block, true)
  if (Array.isArray(body.messages))
    for (const value of body.messages) {
      const message = refusalBodyRecord(value)
      if (message)
        for (const [index, block] of (contentBlocks(message) ?? []).entries())
          add(
            block,
            true,
            candidate?.message === message && candidate.blockIndex === index
              ? candidate.control
              : undefined,
          )
    }
  return marked
}

/** Spend one of the source request's slots on the prefix kept warm during a round. */
export function restoreRefusalFallbackReturnMarker(body: Body, source: Body) {
  if (
    !Array.isArray(source.messages) ||
    !Array.isArray(body.messages) ||
    body.cache_control ||
    body.cacheControl
  )
    return false

  for (
    let messageIndex = source.messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const saved = refusalBodyRecord(source.messages[messageIndex])
    const savedBlocks = saved && contentBlocks(saved)
    if (!savedBlocks) continue
    for (
      let blockIndex = savedBlocks.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const savedBlock = refusalBodyRecord(savedBlocks[blockIndex])
      const control = savedBlock && cacheControl(savedBlock)
      if (!control) continue

      const prefix = messageThreadCachePrefix(source, messageIndex, blockIndex)
      const message = refusalBodyRecord(body.messages[messageIndex])
      const blocks = message && contentBlocks(message)
      const block = blocks && refusalBodyRecord(blocks[blockIndex])
      if (
        !prefix ||
        prefix !== messageThreadCachePrefix(body, messageIndex, blockIndex) ||
        !message ||
        !blocks ||
        !block
      )
        return false

      const original = cacheControl(block)
      const marked = markedHolders(body)
      const tail = marked.at(-1)
      if (!tail || lifetime(tail.control) !== lifetime(control)) return false
      if (original) return lifetime(original) === lifetime(control)

      // Preserve the newest tail and any tool markers. Prefer replacing the
      // earliest replaceable slot: the kept prefix already covers it.
      const excess = Math.max(0, marked.length + 1 - 4)
      const displaced = marked
        .filter((entry) => entry.replaceable && entry !== tail)
        .slice(0, excess)
      if (displaced.length !== excess) return false
      const ordered = markedHolders(body, {
        message,
        blockIndex,
        control,
      }).filter(
        ({ holder }) => !displaced.some((entry) => entry.holder === holder),
      )
      let short = false
      for (const entry of ordered) {
        if (lifetime(entry.control) === '5m') short = true
        else if (short) return false
      }
      message.content = blocks
      block.cache_control = { ...control }
      for (const { holder } of displaced) {
        delete holder.cache_control
        delete holder.cacheControl
      }
      return true
    }
  }
  return false
}
