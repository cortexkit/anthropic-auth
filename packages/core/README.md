# @cortexkit/anthropic-auth-core

Shared Anthropic OAuth, stable account identity, optional Claustrum fallback-custody primitives, model metadata, quota, host-local quota feed, routing, cache, cache-keepalive, fast mode, relay, dump, request-signing, thinking-binding, and Fable 5.1 mid-conversation effort helpers used by CortexKit's OpenCode and Pi integrations.

User-facing packages:

- `@cortexkit/opencode-anthropic-auth` for OpenCode
- `@cortexkit/pi-anthropic-auth` for Pi

Claude Haiku 5.5 (`claude-haiku-5-5`) has a 1M-token context window and 128K max output. Standard input/output rates are $0.10/$0.50 per million tokens; all rates increase fivefold above 100K total input, including cached tokens. Optional quota priming continues to send a minimal Haiku 4.5 request to start a new quota window.
