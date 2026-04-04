# CLAUDE.md

This file provides guidance to ZY Code when working with code in this repository.

## Commands

```bash
# Build
bun run build           # Full build (CLI + SDK) → dist/
bun run build:cli       # Build CLI only
bun run build:sdk       # Build SDK only

# Run
bun run start           # Run built CLI (dist/cli.js)
bun src/entrypoints/cli.tsx  # Run CLI directly without building (dev mode)

# Type check
bun tsc --noEmit
```

There is no test runner configured. Testing is done by running the CLI directly.

## Architecture

This is the Claude Code CLI — a terminal UI application built with **TypeScript + React (Ink)**, bundled by **Bun**.

### Entrypoints

- `src/entrypoints/cli.tsx` — CLI bootstrap: sets up environment, then delegates to `src/main.tsx`
- `src/entrypoints/mcp.ts` — MCP server entrypoint
- `src/entrypoints/sdk/` — SDK types for programmatic/external use

### Core

- `src/main.tsx` — Primary startup: initializes feature flags (GrowthBook), OAuth, MCP, MDM config, keychain prefetch, then launches the REPL. Intentionally fires async prefetches in parallel at the top before heavy imports.
- `src/QueryEngine.ts` — Main conversation/query engine; handles message streaming, tool calls, context management
- `src/tools.ts` — Tool registry; aggregates all available tools
- `src/commands.ts` — Slash command registry

### Tools (`src/tools/`)

Each tool follows a consistent three-file pattern within its own directory:
- `ToolName.ts` / `ToolName.tsx` — Implementation and tool definition
- `UI.tsx` — Ink React component for rendering in the terminal
- `prompt.ts` — System prompt text describing the tool to the model

### UI Layer (`src/components/`, `src/screens/`, `src/hooks/`)

The terminal UI is entirely React components rendered via **Ink**. Top-level screens are in `src/screens/` (e.g., `REPL.tsx`, `Doctor.tsx`). React hooks in `src/hooks/` manage state, keybindings, permissions, clipboard, and history.

### Services (`src/services/`)

- `api/` — Anthropic API client, retries, usage tracking
- `mcp/` — MCP server connection manager and OAuth
- `lsp/` — LSP client for IDE-like diagnostics
- `analytics/` — GrowthBook feature flags
- `oauth/` — Auth flows

### State (`src/state/`)

Centralized app state via `AppStateStore.ts` / `store.ts` with selectors.

### Build system (`build.ts`)

Uses `Bun.build()` with:
- Entry: `src/entrypoints/cli.tsx` → `dist/`
- Compile-time `define` macros: `MACRO.VERSION`, `MACRO.BUILD_TIME`, `MACRO.PACKAGE_URL`, `MACRO.FEEDBACK_CHANNEL`
- `process.env.USER_TYPE = "external"` gates Anthropic-internal code paths (tree-shaken at build time)
- External packages (not bundled): cloud SDKs (`bedrock`, `vertex`), native binaries, lazy-loaded packages (`sharp`, `yaml`, etc.)
- Custom plugins: resolves `react/compiler-runtime` and maps `color-diff-napi` to a local TypeScript fallback in `src/native-ts/`

### Monorepo packages (`packages/`)

- `packages/claude-for-chrome-mcp/` — MCP server for Chrome extension
- `packages/computer-use-mcp/` — MCP server for computer-use (screenshots, input simulation)
- `packages/computer-use-input/` — Input simulation
