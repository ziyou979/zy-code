# ZY Code

[简体中文](README.zh-CN.md) | English

ZY Code is a terminal-first AI coding agent built with TypeScript, React, Ink, and Bun. It
connects your codebase to multiple model providers and gives the model a controlled set of tools
for reading, editing, searching, running commands, and coordinating longer development tasks.

> ZY Code `0.0.1` is an initial public preview. Some capabilities are incomplete, and configuration
> and extension APIs may change before the first stable release.

## Project lineage

ZY Code began as a fork of Claude Code 2.1.88 and has evolved independently since that point. The
project retains the terminal-agent foundation while developing its own multi-provider model layer,
named connection and subscription routing, Chinese localization, external tool system, terminal
renderer, cross-platform support, and long-running agent workflows.

ZY Code is an independent open-source project and is not affiliated with or endorsed by Anthropic.

## Why ZY Code?

- **Mix subscriptions and providers** — configure multiple subscription, API-key, gateway, and
  local connections at the same time instead of locking the whole agent to one provider.
- **Route work by model tier** — assign different connections to advanced, standard, and compact
  workloads, or define an ordered cross-provider fallback chain for any tier.
- **Work from the terminal** — an interactive Ink UI supports streaming responses, tool calls,
  diffs, plans, reviews, session history, and keyboard-driven workflows.
- **Keep execution under control** — permission rules, approval prompts, sandbox integration, and
  project-scoped instructions help constrain file, shell, and network access.
- **Bring your own tools** — load project or user tools from plain TypeScript/JavaScript files;
  supported built-ins can be replaced by exporting a tool with the same name.
- **Extend the agent** — connect MCP servers and add skills, hooks, plugins, and custom commands.
- **Handle larger tasks** — built-in context management, persistent memory, background work,
  subagents, model failover, and resumable sessions support long-running workflows.

## Mix models your way

Named connections make providers independent from model selection. For example, the main loop can
prefer an xAI subscription, switch to a DashScope API connection when authentication, rate limits,
or quota prevent continued use, and use a local model for compact workloads. The selected fallback
is remembered across sessions.

```jsonc
{
  "mainLoopModel": "standard",
  "models": {
    "advanced": { "provider": "grok-subscription", "model": "grok-4.6" },
    "standard": [
      { "provider": "grok-subscription", "model": "grok-4.6" },
      { "provider": "qwen-work", "model": "qwen3.8-max" }
    ],
    "compact": { "provider": "local", "model": "qwen3.5" }
  },
  "modelFailover": {
    "enabled": true,
    "maxConsecutiveFailures": 2
  }
}
```

Connections and credentials are stored separately in `~/.zy/auth.json`; model routing stays in
settings. See the [configuration reference](docs/configuration.md) for connection setup and
failover behavior.

## Customize and override tools

ZY Code loads external tools from the project-level `.zy/tools/` directory and the user-level
`~/.zy/tools/` directory. A new tool name extends the tool set; using the same name as a supported
built-in replaces that implementation while the external tool is active. Tool definitions use a
small framework-independent object with a description, JSON Schema, and async `call()` function.

> [!IMPORTANT]
> The built-in `WebSearch` requires a self-hosted [OpenSERP](https://github.com/karust/openserp)
> service at `http://127.0.0.1:7000`; ZY Code does not bundle or host this service. Deploy it
> yourself, for example with
> `docker run --rm -p 127.0.0.1:7000:7000 karust/openserp:latest serve -a 0.0.0.0 -p 7000`, or
> replace `WebSearch` with your own external tool as shown below.

The included [DuckDuckGo WebSearch demo](examples/external-tools/web-search-duckduckgo.ts) replaces
the built-in `WebSearch` tool without modifying ZY Code itself:

```bash
mkdir -p .zy/tools
cp examples/external-tools/web-search-duckduckgo.ts .zy/tools/web-search.ts
```

Restart ZY Code, or run `/reload-tools` to apply additions, edits, removals, and overrides in the
current session. Removing the override and reloading restores the built-in tool.

## Requirements

- [Bun](https://bun.sh/) 1.3 or later
- Git
- A terminal with true-color support is recommended
- macOS, Linux, or Windows

Some sandbox, keychain, browser, and native computer-use features are platform-specific. The core
CLI can run without them.

## Build from source

```bash
git clone https://github.com/ziyou979/zy-code.git
cd zy-code
bun install --frozen-lockfile
bun run build
bun run start
```

The build output is written to `dist/cli.js`. On first launch, the onboarding flow asks you to
choose an API provider, credentials, API format, and model tier.

For local development:

```bash
bun install
bun run dev
```

## Configuration

ZY Code keeps user configuration under `~/.zy` by default. Set `ZY_CONFIG_DIR` to use a different
location.

| Path | Purpose |
| --- | --- |
| `~/.zy/settings.json` | User settings, model tiers, permissions, hooks, and UI preferences |
| `~/.zy/auth.json` | Named provider connections and credentials |
| `.zy/settings.json` | Project settings intended to be shared with the repository |
| `.zy/settings.local.json` | Local project overrides; do not commit secrets |
| `~/.zy/model-capabilities.json` | Optional model capabilities, limits, pricing, and routing |
| `.mcp.json` | Project MCP servers |
| `AGENTS.md` | Project instructions for the coding agent |

Settings are merged from user, project, local, command-line, and managed-policy sources. See the
[configuration reference](docs/configuration.md) for the complete schema, precedence rules,
provider connections, model failover, permissions, hooks, MCP, and sandbox options.

Never commit API keys or `.zy/settings.local.json`.

## Development

```bash
bun run format          # Format source and tests
bun tsc --noEmit        # Type-check
bun test                # Run the test suite
bun run lint            # Run Biome checks
bun run quality         # Run the complete local quality gate
```

Useful references:

- [Architecture](docs/architecture.md)
- [Development guidelines](docs/development-guidelines.md)
- [Configuration reference](docs/configuration.md)
- [Feature flags](FEATURE_FLAGS.md)
- [Changelog](CHANGELOG.md)

The main directories are:

```text
src/entrypoints/   CLI, SDK, and MCP entry points
src/cli/           CLI bootstrap, options, commands, and transports
src/components/    Ink/React terminal UI
src/commands/      Interactive slash commands
src/tools/         Agent tools and their UI/prompt definitions
src/services/      Model, API, MCP, sandbox, settings, and other domain services
src/state/         Shared application state
src/i18n/          English and Simplified Chinese UI translations
packages/          Workspace packages for browser and computer-use integrations
tests/             Tests mirroring the source tree
```

## Contributing

Issues and pull requests are welcome. Before submitting a change:

1. Read `AGENTS.md` and the [development guidelines](docs/development-guidelines.md).
2. Keep user-visible text in both English and Simplified Chinese locale files.
3. Run `bun run format`, `bun tsc --noEmit`, and the relevant `bun test` targets.
4. Do not edit generated files in `dist/`.

When reporting a security issue, avoid opening a public issue containing credentials, private code,
or exploit details. Contact the maintainers privately instead.

## License

ZY Code is available under the [MIT License](LICENSE).
