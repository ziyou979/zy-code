# ZY.md

本文件为 ZY Code 在本仓库中工作时提供指导与规范约束。

## 规范约束（Spec）

以下规则**必须**严格遵守：

### 1. 语言与注释
- 注释用**中文**，标识符用英文
- 编译器指令（`@ts-ignore` 等）、专有名词（React/Ink/MCP 等）允许英文
- 用户可见文本**禁止硬编码**，必须走 i18n

### 2. 国际化（i18n）
- 通过 `tSync()`/`t()` 读取翻译，翻译 key 同时写入 `en.ts` 和 `zh-CN.ts`
- key 按模块分组（`shellProgress.xxx`），使用描述性名称，支持 `{count}` 插值
- `KeyboardShortcutHint.action` 必须在 `actionKeyMap` 中注册

### 3. 代码格式化
- 使用 Biome 格式化代码（`bun run format`），配置见 `biome.json`
- 缩进 2 空格，行宽 100，单引号，`asNeeded` 分号，尾逗号

### 4. 构建验证
- 改代码后必须 `bun tsc --noEmit` 通过，禁止提交类型错误的代码

### 5. 工具目录结构
- 三文件模式：`ToolName.ts(x)` + `UI.tsx` + `prompt.ts`

### 6. 状态管理
- 通过 `src/state/AppStateStore.ts` 集中管理，禁止组件内管理共享状态

### 7. 导入规范
- 相对路径必须带 `.js` 后缀

### 8. LLM 标准类型（`src/types/llm.ts`）
- 业务代码一律驼峰平铺（`inputTokens`/`outputTokens`/`stopReason`），**禁止** snake_case
- 类型必须从 `src/types/llm.ts` 导入，**禁止**从 SDK 包直接导入
- snake_case 仅限适配层（`conversions/*`、`bridge/inboundMessages.ts`）
- 消息 4 角色分离，错误用 `LLMError` 系列 + `isAPIError`/`isAbortError` 判断

### 9. 类型安全
- **禁止滥用 `as any`**：优先运行时守卫窄化，必须断言时用具体类型；`as any` 仅限适配层处理 SDK 扩展字段、构造中间对象、第三方类型不完善
- 联合类型调数组方法前必须 `Array.isArray()` 守卫
- switch 需保留 `default` 时，提取鉴别字段为 `const x: string` 避免 unreachable
- `message.ts` 中 `AssistantMessage.message` 必须引用 `LLMAssistantMessage`，禁止用 `LLMMessage` 联合
- 旧格式断言为标准事件类型时，必须 `as unknown as TargetType` 双步断言

### 10. 测试规范
- `bun test`，测试放 `tests/`（路径镜像 `src/`），`describe` 写模块名，`test` 用中文描述
- 改 llm 类型/适配器后必须全绿 + `read_lints` 无新错

### 11. 禁止事项
- 禁止引入未评估的新外部依赖
- 禁止在 `dist/` 中手动放文件
- 禁止修改 `build.ts` 的 `define` 宏值

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
- `src/types/llm.ts` — **标准 LLM 类型体系**，独立于任何 SDK，定义项目内部使用的统一类型：
  - 流式事件：`StreamEvent`（`response_start`/`chunk_start`/`chunk_delta`/`chunk_stop`/`response_delta`/`response_stop`）
  - 内容块：`UserContentBlock`（text/image）、`AssistantContentBlock`（text/tool_call/thinking 等）
  - 消息：4 角色分离 `Message`（system/user/assistant/tool）
  - 请求：`CreateParams`（驼峰字段，provider 专属走 `providerExtras`）
  - 计量：`TokenUsage`/`DeltaUsage`（`inputTokens`/`outputTokens`，provider 扩展走 `extras`）
  - 响应：`LLMResponse`
  - 错误：`LLMError` 系列 + `isAPIError()`/`isAbortError()` 等判断函数
  - 适配器：`LLMAdapter`、`StreamResult`
  - **SDK 隔离**：`@anthropic-ai/sdk`、`openai` 等 SDK 包**只允许**在适配层（`src/services/api/conversions/*`、`src/services/api/*ProviderAdapter.ts`）中导入，业务代码**禁止**直接导入 SDK 类型
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