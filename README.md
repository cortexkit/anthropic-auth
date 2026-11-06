# CortexKit Anthropic Auth for OpenCode and Pi

Use Claude Pro/Max subscriptions in [OpenCode](https://opencode.ai) 1 and 2 with `@cortexkit/opencode-anthropic-auth`, or in [Pi](https://pi.dev) with `@cortexkit/pi-anthropic-auth`. Both integrations use the shared `@cortexkit/anthropic-auth-core` package.

## Why use it

- Multiple Claude accounts with ordered fallbacks, quota-aware routing and per-session account affinity.
- Prompt-cache controls and optional cache keepalive for active sessions.
- Optional Claustrum integration: Claustrum is a local credential-vault service that supplies Claude accounts instead of each application's local account pool.
- An optional user-owned Cloudflare relay to reduce repeated request uploads.

## Disclaimer

This project is not affiliated with or endorsed by Anthropic. Using Claude subscriptions outside Anthropic's official clients may violate Anthropic's terms and can lead to account restrictions or suspension. Use it at your own risk.

## Install

```bash
npx @cortexkit/opencode-anthropic-auth setup
```

After setup:

OpenCode 1: open `/claude` → **Accounts** to sign in.

OpenCode 2: connect Anthropic with **Claude Pro / Max (native account pool)** through `/connect` before adding more accounts in `/claude`; follow the [OpenCode 2 setup steps](docs/opencode-2.md#empty-initialization).

Pi: open `/claude` and use **Start OAuth sign-in**, then **Finish OAuth sign-in**.

## Documentation

- [Installation, configuration and manual registration](docs/installation.md#installation-and-configuration)
- [Features and host support](docs/features.md#features-and-host-support)
- [Models, thinking and fast mode](docs/models.md#models-thinking-and-fast-mode)
- [Accounts, routing and quota](docs/accounts-and-routing.md#accounts-routing-and-quota)
- [Settings and routing reference](docs/configuration.md#settings-and-routing-reference)
- [Vault custody](docs/vault.md#vault-custody)
- [Credential custody contract](docs/custody-state-machine.md#anthropic-credential-custody)
- [Commands and menus](docs/commands.md#commands-and-menus)
- [Cache, keepalive and quota priming](docs/cache.md#cache-keepalive-and-quota-priming)
- [CacheKeep session registry interface](docs/cachekeep-registry.md#cachekeep-session-registry)
- [Cache diagnostics](docs/cache-diagnostics.md#cache-diagnostics)
- [OpenCode 2](docs/opencode-2.md#opencode-2)
- [OpenCode sidebar and TUI preferences](docs/sidebar.md#opencode-sidebar-and-tui-preferences)
- [Environment variables](docs/environment.md#environment-variables)
- [Request rewriting and safety fallback](docs/request-rewriting.md#request-rewriting-and-safety-fallback)
- [Transports and request diagnostics](docs/transports.md#transports-and-request-diagnostics)
- [Troubleshooting](docs/troubleshooting.md#troubleshooting)
- [Development](docs/development.md#development)
- [Build modes](docs/build-modes.md#build-modes)
- [Upgrades, recovery and releases](docs/releases.md#upgrades-recovery-and-releases)

## License

[MIT](LICENSE)
