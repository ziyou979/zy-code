# ZY.md

This file provides guidance to ZY Code when working with code in this repository.

## 启动/构建命令

```bash
# 构建
bun run build           # Full build (CLI + SDK) → dist/
bun run build:cli       # Build CLI only
bun run build:sdk       # Build SDK only

# 启动
bun run start           # Run built CLI (dist/cli.js)
bun src/entrypoints/cli.tsx  # Run CLI directly without building (dev mode)

# 格式校验
bun tsc --noEmit
```

There is no test runner configured. Testing is done by running the CLI directly.

## 架构

This is a terminal UI application built with **TypeScript + React (Ink)**, bundled by **Bun**.
当前项目的代码，若含有注释内容，一律使用中文

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

- `api/` — API client, retries, usage tracking
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
- `process.env.USER_TYPE = "external"` gates internal code paths (tree-shaken at build time)
- External packages (not bundled): cloud SDKs (`bedrock`, `vertex`), native binaries, lazy-loaded packages (`sharp`, `yaml`, etc.)
- Custom plugins: resolves `react/compiler-runtime` and maps `color-diff-napi` to a local TypeScript fallback in `src/native-ts/`

### Monorepo packages (`packages/`)

- `packages/claude-for-chrome-mcp/` — MCP server for Chrome extension
- `packages/computer-use-mcp/` — MCP server for computer-use (screenshots, input simulation)
- `packages/computer-use-input/` — Input simulation

## 汉化规则（i18n）

本项目使用 `src/i18n/` 模块进行国际化。修改 UI 文本时**必须**遵循以下规则：

### 核心原则
- **禁止**在组件中直接硬编码中文字符串
- **必须**通过 `tSync()`（同步场景）或 `t()`（异步场景）读取翻译
- 翻译 key 需要同时写入 `src/i18n/locales/en.ts`（英文原文）和 `src/i18n/locales/zh-CN.ts`（中文译文）

### 使用方式
```tsx
import { tSync } from '../i18n/index.js'

// 组件中使用
<Text>{tSync('shellProgress.timeout')}</Text>
<Text>{tSync('shellProgress.lines', { count })}</Text>
```

### KeyboardShortcutHint 特殊处理
对于 `KeyboardShortcutHint` 组件中的 `action` 属性，需要在 `actionKeyMap` 中注册映射：
```tsx
// src/components/design-system/KeyboardShortcutHint.tsx
const actionKeyMap: Record<string, string> = {
  'expand': 'common.expand',
  'interrupt': 'shortcut.interrupt',
  'background': 'shortcut.background',
  // ...新增 action 在此添加
}
```

### 翻译 key 命名规范
- 按功能模块分组：`shellProgress.xxx`、`backgroundTasks.xxx`、`shortcut.xxx`
- 使用描述性名称，不要缩写
- 支持插值：`'key': '已使用 {count} 行'`
- 翻译后必须尝试构建，必须保证能够构建成功
