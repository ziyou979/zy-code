# ZY.md

本文件为 ZY Code 在本仓库中工作时提供指导与规范约束。

## 规范约束（Spec）

以下规则在修改代码时**必须**严格遵守，违反将视为错误：

### 1. 语言与注释
- 代码注释一律使用**中文**
- 以下内容**允许保持英文**：
  - TypeScript/编译器指令：`@ts-ignore`、`@ts-expect-error`、`@ts-nocheck` 等
  - 专有名词与技术术语：React、Ink、MCP、OAuth、GrowthBook、REPL 等
  - 代码示例中的标识符、API 名称、配置项
- 变量名、函数名、类名等标识符保持英文，不使用中文命名
- 日志输出（`console.log`/`console.error`）面向开发者，使用 i18n
- 用户可见的所有文本**禁止硬编码**，必须走 i18n（见下文）

### 2. 国际化（i18n）
- **禁止**在组件中直接硬编码中文字符串
- **必须**通过 `tSync()`（同步场景）或 `t()`（异步场景）读取翻译
- 翻译 key 需同时写入 `src/i18n/locales/en.ts`（英文原文）和 `src/i18n/locales/zh-CN.ts`（中文译文）
- 翻译 key 命名按功能模块分组：`shellProgress.xxx`、`backgroundTasks.xxx`、`shortcut.xxx`
- 使用描述性名称，禁止缩写
- 支持插值语法：`'key': '已使用 {count} 行'`
- `KeyboardShortcutHint` 的 `action` 属性必须在 `actionKeyMap` 中注册映射

### 3. 构建验证
- 更改代码后**必须**执行 `bun tsc --noEmit` 验证类型检查通过
- 添加翻译后**必须**尝试构建，保证构建成功
- 禁止提交无法通过 `bun tsc --noEmit` 的代码

### 4. 工具目录结构
- 每个工具目录**必须**遵循三文件模式：
  - `ToolName.ts` / `ToolName.tsx` — 实现与工具定义
  - `UI.tsx` — Ink React 终端渲染组件
  - `prompt.ts` — 描述工具的系统提示文本
- 新增工具必须按此结构组织，禁止随意放置文件

### 5. 状态管理
- 应用状态通过 `src/state/AppStateStore.ts` / `store.ts` 集中管理
- 禁止在组件中直接管理跨组件共享状态，应使用 store selectors

### 6. 导入规范
- 使用 `.js` 后缀进行相对路径导入（如 `import { foo } from './bar.js'`）
- 禁止使用无后缀的相对路径导入

### 7. LLM 标准类型（`src/types/llm.ts`）
业务代码一律使用驼峰、平铺，禁止 snake_case 与嵌套。

- 字段名：`inputTokens` / `outputTokens` / `stopReason` / `inputSchema`，**禁止**下划线写法
- `ImageBlock`：`{ type:'image', mimeType, data }`，**禁止** `source` 嵌套
- `TokenUsage`：`{ inputTokens, outputTokens, extras? }`，cache/web 等 provider 特定计量放 `extras`
- `StopReason`：`'end_turn' | 'max_tokens' | 'tool_use' | 'content_filter' | 'refusal' | null`
- `CreateParams`：通用字段直接放，provider 专属走 `providerExtras.{anthropic|openai}`
- 消息 4 角色分离，工具结果优先用 `ToolMessage`
- 错误抛/接 `LLMError` 系列，判断用 `isAPIError` / `isAbortError` / `isConnectionError`
- 类型必须从 `src/types/llm.ts` 导入，**禁止**从 `@anthropic-ai/sdk` / `openai` 直接导入
- snake_case 双取写法只允许出现在适配层入口（`src/services/api/conversions/*`、`src/bridge/inboundMessages.ts`），业务层禁止

### 8. 测试规范
- 用 `bun test`（`bun:test`），测试放 `tests/`，路径镜像 `src/`，公共辅助放 `tests/_helpers/`
- 优先测纯函数 / 转换层 / 归一化函数 / 错误工具；UI 不强制
- 流式断言用 `tests/_helpers/streamAccumulator.ts` 累积后整体校验；大块 fixture 放 `tests/_helpers/*Fixtures.ts`
- `describe` 写模块/函数名，`test` 用中文描述行为
- 改 llm 类型或适配器后必须：`bun test` 全绿 + `read_lints` 无新错

### 9. 禁止事项
- 禁止引入未经评估的新外部依赖
- 禁止在构建路径 `dist/` 中手动放置文件
- 禁止修改 `build.ts` 中的 `define` 宏值（`MACRO.*`）

## 启动/构建命令

```bash
# 构建
bun run build           # 完整构建（CLI + SDK） → dist/
bun run build:cli       # 仅构建 CLI
bun run build:sdk       # 仅构建 SDK

# 启动
bun run start           # 运行已构建的 CLI（dist/cli.js）
bun src/entrypoints/cli.tsx  # 直接运行 CLI，无需构建（开发模式）

# 类型校验（更改代码后必须执行）
bun tsc --noEmit
```

本项目未配置测试运行器，测试通过直接运行 CLI 进行。

## 架构

本项目是一个基于 **TypeScript + React (Ink)** 的终端 UI 应用，由 **Bun** 打包。

### 入口（Entrypoints）

- `src/entrypoints/cli.tsx` — CLI 启动入口：设置环境后委托给 `src/main.tsx`
- `src/entrypoints/mcp.ts` — MCP 服务入口
- `src/entrypoints/sdk/` — SDK 类型定义，供外部编程使用

### 核心（Core）

- `src/main.tsx` — 主启动流程：初始化功能开关（GrowthBook）、OAuth、MCP、MDM 配置、密钥预取，然后启动 REPL。在顶部并行触发异步预取后再执行重型导入
- `src/QueryEngine.ts` — 主对话/查询引擎；处理消息流、工具调用、上下文管理
- `src/tools.ts` — 工具注册表；聚合所有可用工具
- `src/commands.ts` — 斜杠命令注册表
- `src/types/llm.ts` — **标准 LLM 类型体系 v2**，独立于任何 SDK，定义项目内部使用的统一类型：
  - 流式事件：`StreamEvent`（`response_start`、`chunk_start`、`chunk_delta`、`chunk_stop`、`response_delta`、`response_stop`）
  - 内容块按角色分离：`UserContentBlock`（text/image）、`AssistantContentBlock`（text/tool_call/thinking 等）
  - 消息模型：4 角色分离的 `Message`（system/user/assistant/tool），替代旧版 `LLMMessage`/`LLMMessageParam`
  - 请求参数：`CreateParams`（驼峰字段，通过 `providerExtras` 传递 provider 专属扩展）
  - Token 计量：`TokenUsage`、`DeltaUsage`（驼峰命名：`inputTokens`/`outputTokens`，通过 `extras` 扩展 provider 特定指标）
  - 响应：`Response`（替代旧版 `LLMMessage`）
  - 错误体系：`LLMError`（基类）、`LLMConnectionError`、`LLMAbortError`、`LLMAuthenticationError`、`LLMNotFoundError`
  - 鸭子类型错误判断：`isAPIError()`、`isAbortError()`、`isConnectionError()`、`isConnectionTimeoutError()` 等工具函数
  - 适配器接口：`LLMAdapter`、`StreamResult`
  - v1 兼容导出：`LLMStreamEvent`、`ContentBlock`、`ContentBlockParam`、`LLMMessage`、`LLMCreateParams`、`LLMRequestAdapter` 等均标记为 `@deprecated`，保留为渐进迁移
- `src/utils/envUtils.ts` — 环境判断工具函数，包括 `isInternalBuild()`、`getUserType()` 等构建时门控

### 工具（Tools，`src/tools/`）

每个工具遵循统一的三文件模式（见规范约束第 4 条）。

### UI 层（`src/components/`、`src/screens/`、`src/hooks/`）

终端 UI 全部由 React 组件通过 **Ink** 渲染。顶层页面在 `src/screens/`（如 `REPL.tsx`、`Doctor.tsx`）。React hooks 在 `src/hooks/` 中管理状态、快捷键、权限、剪贴板和历史。

### LLM 适配器层（`src/services/api/streamAdapter.ts`）

统一的 LLM 请求适配层，使 Anthropic 和 OpenAI 两种 Provider 完全平等：

- **核心设计**：业务层通过 `src/types/llm.ts` 中的标准类型（`CreateParams`、`StreamEvent` 等）与 LLM 交互，不依赖任何特定 SDK 类型
- **适配器模式**：`AnthropicRequestAdapter` 和 `OpenAIRequestAdapter` 各自实现 `LLMAdapter` 接口，将 SDK 特有的请求/响应格式转换为标准类型
- **流式处理**：适配器将 SDK 流转换为 `AsyncIterable<StreamEvent>`，业务层通过 `for await` 统一消费
  - Anthropic 流：`message_start`/`content_block_start`/`content_block_delta`/`message_stop` → 标准事件
  - OpenAI 流：`ChatCompletionChunk` delta → 标准事件（含百炼 `reasoning_content` → `thinking` block 映射）
- **Provider 专属字段**：v2 通过 `CreateParams.providerExtras` namespace 传递（如 `providerExtras.anthropic.thinking`、`providerExtras.openai.response_format`），各适配器自行解析，互不干扰
- **消息格式**：统一为 4 角色分离模型（system/user/assistant/tool），适配器负责转换为各自 SDK 格式
  - OpenAI 适配器将 v1 `tool_result` 块拆分为独立的 `role:'tool'` 消息
  - 工具调用统一为标准 `ToolDefinition` + `ToolCall` 结构
- **Provider 选择**：运行时通过 `getRequestAdapter()` 根据当前 provider 的 `supportedFormats` 返回对应适配器
- **类型导入规范**：业务代码中的 `Message`、`TokenUsage`、`CreateParams` 等类型**必须**从 `src/types/llm.ts` 导入，**禁止**从 `@anthropic-ai/sdk` 或 `openai` 直接导入（避免 SDK 类型与标准类型不兼容导致编译错误）

### 服务层（Services，`src/services/`）

- `api/` — API 客户端、重试、用量追踪（含 `streamAdapter.ts` 适配层）
- `mcp/` — MCP 服务连接管理器与 OAuth
- `lsp/` — LSP 客户端，提供 IDE 级诊断
- `analytics/` — GrowthBook 功能开关
- `oauth/` — 认证流程

### 状态（State，`src/state/`）

通过 `AppStateStore.ts` / `store.ts` 集中管理应用状态，使用 selectors 读取。

### 构建系统（`build.ts`）

使用 `Bun.build()`，配置如下：
- 入口：`src/entrypoints/cli.tsx` → `dist/`
- 编译时 `define` 宏：`MACRO.VERSION`、`MACRO.BUILD_TIME`、`MACRO.PACKAGE_URL`、`MACRO.FEEDBACK_CHANNEL`
- `process.env.USER_TYPE = "external"` 控制内部代码路径（构建时 tree-shake）
- 外部包（不打包）：云 SDK（`bedrock`、`vertex`）、原生二进制、懒加载包（`sharp`、`yaml` 等）
- 自定义插件：解析 `react/compiler-runtime`，将 `color-diff-napi` 映射到 `src/native-ts/` 的本地 TypeScript 回退实现

### Monorepo 子包（`packages/`）

- `packages/claude-for-chrome-mcp/` — Chrome 扩展的 MCP 服务
- `packages/computer-use-mcp/` — 计算机使用 MCP 服务（截图、输入模拟）
- `packages/computer-use-input/` — 输入模拟