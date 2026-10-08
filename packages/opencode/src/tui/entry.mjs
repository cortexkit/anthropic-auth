// Prefer the host OpenTUI runtime registry when it exists. OpenTUI 0.4.x
// registers these virtual modules process-wide, allowing the precompiled TUI to
// share the host's single Solid/OpenTUI runtime when loaded from node_modules.
const runtimeProbe = `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`

function isMissingRuntimeRegistry(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(
      message,
    ) && message.includes('opentui:runtime-module:')
  )
}

async function loadLegacyTui() {
  let mod
  try {
    await import(runtimeProbe)
  } catch (error) {
    if (!isMissingRuntimeRegistry(error)) {
      console.error('Anthropic Auth TUI runtime registry probe failed', error)
      throw error
    }
    // Older hosts and bare Bun do not provide the virtual registry. Their source
    // loader still applies the Solid transform, so retain the raw TSX fallback.
    mod = await import('../tui.tsx')
  }

  if (!mod) {
    try {
      mod = await import('../tui-compiled/tui.tsx')
    } catch (error) {
      console.error('Anthropic Auth compiled TUI failed to load', error)
      throw error
    }
  }
  return mod.default
}

let legacyModule

// Both hosts load the same subpath. Keep OC1's id/tui object shape and put
// OC2's setup on that default object too; named exports alone are insufficient
// for consumers that select the default definition after importing the module.
export const id = 'cortexkit.anthropic-auth'

/** @type {import('@opencode-ai/plugin/tui').TuiPlugin} */
export const tui = async (...args) => {
  legacyModule ??= loadLegacyTui()
  const plugin = await legacyModule
  return plugin.tui(...args)
}

/** @type {import('@opencode/plugin/tui').Plugin.Definition['setup']} */
export const setup = async (context) => {
  // OpenCode 2 already routes RPC through the active project. Importing its
  // TUI must not load the OpenCode 1 renderer or start that renderer's separate
  // loopback notification poller.
  const { setupAnthropicTui } = await import('../../dist/v2/tui.js')
  return setupAnthropicTui(context)
}

export default { id, tui, setup }
