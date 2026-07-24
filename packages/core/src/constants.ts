export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const AUTHORIZE_URLS = {
  console: 'https://platform.claude.com/oauth/authorize',
  max: 'https://claude.com/cai/oauth/authorize',
} as const

export const CODE_CALLBACK_URL =
  'https://platform.claude.com/oauth/code/callback'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

export const AXIOS_USER_AGENT = 'axios/1.15.2'

export const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

export const REFRESH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

export const TOOL_PREFIX = 'mcp_'

export const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
]
export const FAST_MODE_BETA = 'fast-mode-2026-02-01'

export function mergeAnthropicBetas(
  existing: string | null | undefined,
  betas: string[],
) {
  const incoming = (existing ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean)
  return [...new Set([...incoming, ...betas])].join(',')
}

export function isFastModeSupportedModel(model: unknown) {
  return (
    typeof model === 'string' &&
    (model.startsWith('claude-opus-4-6') ||
      model.startsWith('claude-opus-4-7') ||
      model.startsWith('claude-opus-4-8') ||
      model.startsWith('claude-opus-5'))
  )
}

export const OPENCODE_IDENTITY_PREFIX = 'You are OpenCode'
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

export const PARALLEL_TOOL_CALLS_SYSTEM_PROMPT = [
  '<use_parallel_tool_calls>',
  'For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling independent tools in parallel whenever possible. For example, when reading 3 known files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple independent read-only commands like `ls` or `list_dir`, run all of those commands in parallel. Err on the side of maximizing parallel tool calls for independent work rather than running too many tools sequentially.',
  '',
  'Do not parallelize tool calls when one call depends on the output of another call. If a tool call needs an ID, filename, search result, or any other value returned by a previous tool call, run the first call, wait for its result, then run the dependent call using the real returned value. Never invent placeholder IDs, guessed task IDs, or other guessed values for dependent tool calls just to place them in the same parallel block.',
  '</use_parallel_tool_calls>',
].join('\n')

export const CCH_SALT = '59cf53e54c78'
export const CCH_POSITIONS = [4, 7, 20]
export const CLAUDE_CODE_VERSION = '2.1.177'
export const CLAUDE_CODE_BUILD_HASH = '3bf'
export const CLAUDE_CODE_ENTRYPOINT = 'cli'
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.94.0'
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = 'v24.3.0'

export const USER_AGENT = 'claude-cli/2.1.177 (external, cli)'

export const CACHE_1H_MODES = ['explicit', 'automatic', 'hybrid'] as const
export type Cache1hMode = (typeof CACHE_1H_MODES)[number]
export const DEFAULT_CACHE_1H_MODE: Cache1hMode = 'explicit'

/**
 * Anchors that identify paragraphs to remove from the system prompt.
 * Any paragraph (text between blank lines) containing one of these
 * strings is removed entirely.
 *
 * This is resilient to upstream rewording — as long as the anchor
 * string (typically a URL) still appears somewhere in the paragraph,
 * the removal works regardless of how the surrounding text changes.
 */
export const PARAGRAPH_REMOVAL_ANCHORS = [
  // Help/feedback block — references the OpenCode GitHub repo
  'github.com/anomalyco/opencode',
  // OpenCode docs guidance — references the OpenCode docs URL
  'opencode.ai/docs',
]

/**
 * Inline text replacements applied after paragraph removal.
 * These handle cases where "OpenCode" appears inside a paragraph
 * we want to keep (so we can't remove the whole paragraph).
 */
export const TEXT_REPLACEMENTS: { match: string; replacement: string }[] = [
  { match: 'if OpenCode honestly', replacement: 'if the assistant honestly' },
  {
    match:
      'Here is some useful information about the environment you are running in:',
    replacement: 'Environment context you are running in:',
  },
]
