# Changelog

All notable changes to ZY Code are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 - 2026-08-21

First public preview. ZY Code began as a fork of Claude Code 2.1.88 and has evolved independently
into a multi-provider terminal coding agent.

### Highlights

- Run subscription, API-key, gateway, and local model connections side by side.
- Mix providers by workload tier and automatically fail over between ordered model candidates.
- Extend the agent with external tools, built-in tool overrides, MCP servers, skills, hooks,
  plugins, custom commands, and workflows.
- Use a terminal interface designed for English and Chinese users across macOS, Linux, and Windows.

### Added

- A provider-neutral model layer covering Anthropic, OpenAI-compatible Chat Completions, OpenAI
  Responses, Google Gemini, and registered cloud or local providers.
- Named connections in `auth.json`, including multiple accounts for the same underlying provider
  and subscription channels such as xAI Grok and ChatGPT Codex.
- Advanced, standard, and compact model tiers with per-tier provider selection, ordered candidates,
  authentication and quota failover, and cross-session sticky selection.
- A model capability registry for context limits, pricing, beta headers, thinking, effort levels,
  provider-specific parameter mapping, and time-scheduled rates.
- Multi-currency usage and cost tracking with session persistence.
- Interactive workflows for reading and editing files, shell execution, planning, code review,
  goals, background work, monitoring, scheduling, and subagents.
- Resumable sessions, persistent memory, context compaction, tool-result offloading, and diagnostic
  commands for long-running work.
- Project and user external Tool directories, lightweight JSON Schema tool definitions, supported
  built-in Tool replacement, `/tools`, and live reload through `/reload-tools`.
- MCP servers, bundled and user skills, plugins, hooks, custom commands, and workflow scripts.
- Permission rules, approval prompts, project instructions, sandbox integration, and configurable
  permission modes.
- English and Simplified Chinese interfaces, documentation, command descriptions, shortcuts, and
  relative-time formatting.

### Changed

- Removed assumptions that the runtime, authentication, models, headers, pricing, and capabilities
  belong to a single vendor; provider behavior is now resolved through registries and adapters.
- Split credentials from settings and moved provider URLs and API formats into named connections,
  with migrations for earlier configuration layouts.
- Reworked thinking and effort handling into declarative provider and per-model mappings, including
  runtime capability downgrade when an API rejects thinking parameters.
- Added precise multi-model tokenization, configurable output limits, model-level beta headers, and
  preservation of reasoning content across compatible APIs.
- Refactored shared state and runtime capabilities into explicit stores and injected runtime
  contexts, and moved domain logic out of generic utility modules.
- Expanded hook coverage with richer lifecycle events, batch tool events, message display hooks,
  and safer external execution behavior.
- Improved context compaction with progress events, failure safeguards, persisted cost state, and
  more predictable resume behavior.
- Reworked the Ink terminal experience with fullscreen switching, native cursor support, mouse
  selection and hover, sticky scrolling, virtualized message keys, and clearer tool grouping.
- Improved Windows support with PowerShell fallback, Git Bash detection, Unicode clipboard fixes,
  CJK-width handling, Windows Terminal and JetBrains terminal rendering fixes, and memory trimming.
- Strengthened API conversion and streaming behavior for Google, OpenAI-compatible, and other
  providers, including tool-call deduplication and malformed tool-use validation.
- Added memory and performance diagnostics, heap snapshots, runtime memory monitoring, and native
  reference release after large tool results are offloaded.

### Security

- Added destructive command-substitution detection and safer shell parsing paths.
- Hardened memory-directory access with resolved-path containment checks.
- Added hard-deny permission rules, MCP secret redaction, and consistent permission filtering before
  tools are exposed to the model.

### Known limitations

- This is an early preview; configuration, extension APIs, and some workflows may change.
- The built-in `WebSearch` requires a self-hosted OpenSERP service at `127.0.0.1:7000`, or an
  external `WebSearch` override.
- IDE integration remains experimental and is hidden from command discovery.
- Mobile application links are not yet available, so `/mobile` is hidden from command discovery.
- `/fork` and `/peers` retain development stubs but are hidden from command discovery.
- Some sandbox, keychain, browser, and native computer-use capabilities are platform-specific.
