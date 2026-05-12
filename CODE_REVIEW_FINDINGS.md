# 代码审查问题清单

> 生成时间：2026-05-12  
> 审查范围：`src/`、`packages/`、`scripts/`、`tests/`、根目录配置与文档。  
> 审查方式：只读审查，未修改业务代码；结合静态阅读、精确检索和只读验证命令结果整理。

## 总览

### 只读验证命令结果

- `bun tsc --noEmit`：通过，退出码 `0`。
- `bunx biome check .`：失败，退出码 `1`。
  - 主要问题包括格式化差异、`scripts/fix-tdz.ts` 中 `fs`/`path` 未使用 `node:` 协议等。
- `git status --short | cat`：审查前工作区已有未跟踪/异常状态。
  - 例如：`?? .aone_copilot/`、`?? .vscode/`、`?? articles/`、`?? docs/`、`?? scripts/`。
  - 例如：`AD src/commands/buddy/buddy.ts`、`AD tests/services/api/web_search_test.ts`。

### 优先级建议

- **P0/P1 优先处理**：构建命令与实现不一致、`.gitignore` 未覆盖本地敏感配置、LLM 标准类型 snake_case 泄露、业务层继续使用旧 usage 字段、i18n 英文 key 缺失与用户可见文本硬编码。
- **P2 持续治理**：`QueryEngine`/`query`/`BackgroundTasksDialog`/`REPL`/`services/api/zy.ts` 等大文件职责拆分，`as any` 和 `@ts-ignore` 收敛。
- **P3 规范化**：工具三文件模式豁免清单、脚本归档策略、文档同步、示例配置 schema 明确化。

## 1. 核心运行链路与 LLM 类型约定

### 1.1 标准 LLM 类型文件仍包含 snake_case 字段

- **严重程度**：高
- **文件路径**：`src/types/llm.ts`
- **证据**：
  - 文件头声明标准 LLM 类型独立于 SDK，字段命名统一驼峰。
  - `ConnectorTextDelta.connector_text`。
  - `ProviderExtras.anthropic.thinking.budget_tokens`。
  - `_extraToolSchemas`。
  - `DashScopeSearchInfo.search_results`。
- **影响**：
  - 标准类型层本应屏蔽 provider/native 协议细节，但这些字段把 snake_case 扩散到了业务层。
  - 违反项目规则：业务代码一律驼峰，snake_case 仅限适配层。
- **修复建议**：
  - 标准层改为 `connectorText`、`budgetTokens`、`extraToolSchemas`、`searchResults`。
  - 在 `src/services/api/conversions/openai.ts`、`src/services/api/conversions/anthropic.ts` 内完成 provider 字段映射。

### 1.2 Agent UI 业务代码直接读取 snake_case usage

- **严重程度**：高
- **文件路径**：`src/tools/AgentTool/UI.tsx`
- **证据**：
  - 约第 527-530 行、第 761-764 行读取：
    - `usage.cache_creation_input_tokens`
    - `usage.cache_read_input_tokens`
    - `usage.input_tokens`
    - `usage.output_tokens`
  - 同时通过 `(latestAssistant.data.message as any).message.usage` 绕过类型系统。
- **影响**：
  - UI 层不是适配层，不应依赖 provider 旧协议字段。
  - 造成 usage 在内部有驼峰与 snake_case 两套事实标准。
- **修复建议**：
  - 新增或复用 usage 归一化 helper。
  - UI 只读取 `inputTokens`、`outputTokens` 和 `extras.cacheCreationInputTokens`、`extras.cacheReadInputTokens` 等标准字段。
  - 旧格式兼容前移到消息归一化或 adapter。

### 1.3 Agent 工具结果 schema/返回值继续暴露 snake_case usage

- **严重程度**：高
- **文件路径**：`src/tools/AgentTool/agentToolUtils.ts`
- **证据**：
  - 约第 218-232 行 schema 定义 `input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`server_tool_use`。
  - 约第 331-332 行把 `inputTokens`/`outputTokens` 输出为 `input_tokens`/`output_tokens`。
- **影响**：
  - 业务工具层将标准 usage 再转回 snake_case，导致下游 UI 继续依赖旧协议。
- **修复建议**：
  - 内部统计和 UI 统一使用 `TokenUsage` 驼峰结构。
  - 如果外部协议必须兼容 snake_case，应定义明确 DTO 边界并放到外部输出转换层。

### 1.4 `query.ts` 已有事件类型却使用双重 `as any`

- **严重程度**：中
- **文件路径**：`src/query.ts`、`src/types/message.ts`
- **证据**：
  - `src/query.ts` 约第 316 行：`yield { type: 'stream_request_start' } as any as any`。
  - `src/types/message.ts` 约第 381 行已定义 `StreamRequestStartEvent`。
- **影响**：
  - 已存在明确类型却通过双重断言绕过，说明 generator union 类型不完整。
- **修复建议**：
  - 在 `query.ts` 的 `AsyncGenerator` union 中加入 `StreamRequestStartEvent`。
  - 从 `src/types/message.ts` 导入类型后删除双重断言。

### 1.5 `QueryEngine` 附件消息处理缺少鉴别联合类型

- **严重程度**：中
- **文件路径**：`src/QueryEngine.ts`
- **证据**：
  - 约第 788-829 行多次使用：
    - `(message as any).attachment.type`
    - `((message as any).attachment as any).turnCount`
    - `((message as any).attachment as any).maxTurns`
    - `((message as any).attachment as any).prompt`
- **影响**：
  - 核心输出逻辑依赖运行时字段猜测，类型系统无法保护附件结构变更。
- **修复建议**：
  - 定义 `StructuredOutputAttachment`、`MaxTurnsReachedAttachment`、`QueuedCommandAttachment` 等 discriminated union。
  - 或提供 `isAttachmentOfType()` 类型守卫。

### 1.6 API 层 SDK 类型边界仍有扩散

- **严重程度**：中
- **文件路径**：
  - `src/services/api/zy.ts`
  - `src/services/api/dumpPrompts.ts`
- **证据**：
  - `src/services/api/zy.ts` 约第 92 行导入 `ClientOptions` from `@anthropic-ai/sdk`。
  - `src/services/api/dumpPrompts.ts` 导入 `ClientOptions` from `@anthropic-ai/sdk`。
- **影响**：
  - 项目规则要求 SDK 包只允许在 `conversions/*`、`*ProviderAdapter.ts` 等适配层导入。
  - `zy.ts` 是 API 编排文件，直接依赖 SDK 类型会扩大 Anthropic 语义边界。
- **修复建议**：
  - 将 SDK 类型依赖下沉到 `client.ts` 或 `AnthropicProviderAdapter.ts`。
  - `zy.ts` 与 `dumpPrompts.ts` 改依赖内部抽象类型或 `src/types/llm.ts`。

### 1.7 转换层兼容入口过宽，弱化标准类型约束

- **严重程度**：中
- **文件路径**：
  - `src/services/api/conversions/openai.ts`
  - `src/services/api/conversions/anthropic.ts`
- **证据**：
  - `openai.ts` 定义 `type AnyMessage = LLMMessage | Record<string, unknown>`，并 `const msg = raw as any`。
  - `anthropic.ts` 同样定义 `AnyMessage` 并 `const msg = raw as any`。
- **影响**：
  - 转换函数接受任意 `Record`，会让“标准输入必须是 `LLMMessage[]`”的约束变弱。
  - 历史 v1 兼容逻辑长期留在核心转换函数中。
- **修复建议**：
  - 拆分 `normalizeLegacyMessageToLLMMessage()` 与严格转换函数。
  - `messagesToOpenAI()` / `messagesToAnthropic()` 只接受标准 `LLMMessage[]`。

### 1.8 大文件职责过重

- **严重程度**：中
- **文件路径**：
  - `src/query.ts`
  - `src/services/api/zy.ts`
- **证据**：
  - `src/query.ts` 约 1600+ 行，混合上下文预算、压缩、恢复、工具执行、API fallback、hook、feature gate 等逻辑。
  - `src/services/api/zy.ts` 约 3000+ 行，承担 API 编排且仍有 SDK 类型依赖。
- **影响**：
  - 修改局部能力时容易牵动核心流程。
  - 类型标准化、provider 拆分和测试覆盖难度较高。
- **修复建议**：
  - `query.ts` 拆分为流事件状态机、压缩/恢复策略、工具执行编排、API 调用调度。
  - `zy.ts` 拆分 client 配置、provider 调度、retry/usage、兼容处理等模块。

## 2. UI、状态管理与 i18n

### 2.1 `BackgroundTasksDialog` 翻译 key 疑似只写入中文

- **严重程度**：高
- **文件路径**：
  - `src/components/tasks/BackgroundTasksDialog.tsx`
  - `src/i18n/locales/zh-CN.ts`
  - `src/i18n/locales/en.ts`
- **证据**：
  - `BackgroundTasksDialog.tsx` 使用多个 `backgroundTasks.*` key：
    - `backgroundTasks.title`
    - `backgroundTasks.noTasks`
    - `backgroundTasks.action.select`
    - `backgroundTasks.action.view`
    - `backgroundTasks.action.stop`
  - `zh-CN.ts` 约第 532-549 行包含这些 key。
  - `en.ts` 精确检索 `backgroundTasks.title`、`backgroundTasks.dismissed`、`backgroundTasks.action.select` 未命中；只看到 `backgroundTasks.monitorDetails` 等详情页 key。
- **影响**：
  - 英文 locale 下可能显示 key、空值或 fallback。
  - 违反“翻译 key 同时写入 `en.ts` 和 `zh-CN.ts`”规范。
- **修复建议**：
  - 将列表页使用的所有 `backgroundTasks.*` key 补齐到 `en.ts`。
  - 增加 i18n key 集合差异校验脚本。

### 2.2 多处用户可见文本硬编码

- **严重程度**：高
- **文件路径与证据**：
  - `src/components/ThinkingToggle.tsx`
    - 约第 79 行：`Changing thinking mode mid-conversation will increase latency...`
    - 约第 101 行：`Press {exitState.keyName} again to exit`
    - 约第 109/119 行：`description="cancel"`、`description="exit"`
  - `src/hooks/notifs/usePluginAutoupdateNotification.tsx`
    - 约第 43-46 行：`Plugin(s) updated`、`Run /reload-plugins to apply`
  - `src/hooks/notifs/useMcpConnectivityStatus.tsx`
    - 约第 51-101 行：`server/servers failed`、`connector/connectors unavailable` 等。
  - `src/hooks/useChromeExtensionNotification.tsx`
    - 约第 31/41 行：Chrome extension 通知英文硬编码。
  - `src/hooks/notifs/useNpmDeprecationNotification.tsx`
    - 约第 5-6/21 行：npm deprecation 通知硬编码。
  - `src/hooks/useCanUseTool.tsx`
    - 约第 124 行：`denied by auto mode`。
  - `src/hooks/useReplBridge.tsx`
    - 约第 122 行：`Remote Control failed`。
- **影响**：
  - 终端 UI、通知、确认弹窗无法随语言切换。
  - 违反用户可见文本必须走 i18n 的项目规则。
- **修复建议**：
  - 为上述文案补充 `en.ts` 与 `zh-CN.ts` key。
  - 数量、插件名、快捷键、错误详情使用 `{count}`、`{name}`、`{shortcut}`、`{detail}` 插值。

### 2.3 `KeyboardShortcutHint.action` 被传入翻译结果，绕过 action 注册表

- **严重程度**：中高
- **文件路径**：
  - `src/components/design-system/KeyboardShortcutHint.tsx`
  - `src/components/tasks/BackgroundTasksDialog.tsx`
  - `src/components/LogSelector.tsx`
  - `src/components/MCPServerMultiselectDialog.tsx`
  - `src/components/RemoteEnvironmentDialog.tsx`
- **证据**：
  - `KeyboardShortcutHint.tsx` 约第 15-72 行定义 `actionKeyMap`。
  - 约第 87-89 行未命中注册表时回退 raw action。
  - `BackgroundTasksDialog.tsx` 约第 591-635 行：
    - `action={tSync('backgroundTasks.action.select')}`
    - `action={tSync('backgroundTasks.action.view')}`
    - `action={tSync('backgroundTasks.action.stop')}`
  - 类似模式见 `LogSelector.tsx`、`MCPServerMultiselectDialog.tsx`、`RemoteEnvironmentDialog.tsx`。
- **影响**：
  - `action` 语义应是 action id，但传入翻译文本后无法命中 `actionKeyMap`。
  - 后续若增加 action 校验、统计或快捷键统一管理，会出现不可控值。
- **修复建议**：
  - 为 background tasks 增加固定 action id 并注册到 `actionKeyMap`。
  - 或调整组件 API，区分 `actionKey` 与 `actionText`。

### 2.4 `BackgroundTasksDialog.tsx` 内存在硬编码 dismissal 文案

- **严重程度**：中
- **文件路径**：`src/components/tasks/BackgroundTasksDialog.tsx`
- **证据**：
  - 约第 392/536/638 行：`Background tasks dialog dismissed`。
  - 同文件其他位置已有 `tSync('backgroundTasks.dismissed')`。
- **影响**：
  - 同一文案同时有 i18n 与硬编码两套写法。
- **修复建议**：
  - 三处统一改为 `tSync('backgroundTasks.dismissed')`。
  - 同时补齐英文翻译 key。

### 2.5 `BackgroundTasksDialog.tsx` 组件过大且重复 UI 较多

- **严重程度**：中高
- **文件路径**：`src/components/tasks/BackgroundTasksDialog.tsx`
- **证据**：
  - 文件约 981 行。
  - 同时承担任务筛选/排序/分组、键盘处理、kill/foreground 动作、详情页路由、列表 UI 渲染、子组件定义。
  - 约第 668-812 行多个 section 重复 header、count、`items.map(<Item />)` 渲染模式。
- **影响**：
  - UI、状态选择、业务动作、详情路由耦合；新增任务类型需要修改多个区域。
- **修复建议**：
  - 抽 `useBackgroundTaskListItems()` 管理筛选、排序、分组。
  - 抽 `useBackgroundTaskActions()` 管理 kill/foreground/back/cancel。
  - 抽 `BackgroundTaskListSection` 复用列表渲染。
  - 抽 `BackgroundTaskDetailRouter` 管理详情组件选择。

### 2.6 `BackgroundTasksDialog.tsx` 存在未使用导入/变量与死代码迹象

- **严重程度**：中
- **文件路径**：`src/components/tasks/BackgroundTasksDialog.tsx`
- **证据**：
  - 第 1 行导入 `feature`，当前未发现使用。
  - 第 2 行导入 `ReactNode`，实际使用倾向为 `React.ReactNode`。
  - 约第 123-131 行多个 workflow/monitor 相关常量为 `null`：
    - `WorkflowDetailDialog`
    - `workflowTaskModule`
    - `killWorkflowTask`
    - `skipWorkflowAgent`
    - `retryWorkflowAgent`
    - `monitorMcpModule`
    - `killMonitorMcp`
    - `MonitorMcpDetailDialog`
- **影响**：
  - 可能是 feature-gated 代码剥离后的残留，增加理解成本。
- **修复建议**：
  - 确认 gated 分支生成逻辑后，删除未使用变量或恢复受 `feature()` 保护的动态导入。
  - 必须保留时封装为 adapter/factory，避免占位散落在 UI 文件顶部。

### 2.7 子组件 Props 未显式类型化

- **严重程度**：中
- **文件路径**：
  - `src/components/tasks/BackgroundTasksDialog.tsx`
  - `tsconfig.json`
- **证据**：
  - `BackgroundTasksDialog.tsx` 约第 916 行：`function Item({ item, isSelected }) { ... }`
  - 约第 939 行：`function TeammateTaskGroups({ teammateTasks, currentSelectionId }) { ... }`
  - 约第 942 行：`const teams = new Map()`。
  - `tsconfig.json` 中 `strict: false`。
- **影响**：
  - 隐式 `any` 和裸 `Map` 会削弱 `ListItem` 判别联合的类型保护。
  - 一旦开启更严格 TS 配置，这些位置容易暴露类型错误。
- **修复建议**：
  - 为 `Item`、`TeammateTaskGroups` 添加明确 Props 类型。
  - 将 `teams` 标注为 `Map<string, Extract<ListItem, { type: 'in_process_teammate' }>[]>` 或等价类型。

### 2.8 `REPL.tsx` 主屏幕文件职责过重

- **严重程度**：中
- **文件路径**：`src/screens/REPL.tsx`
- **证据**：
  - 文件约 6198 行，大小约 260 KB。
  - 文件开头聚合大量 UI、状态、hooks、服务、工具相关导入。
- **影响**：
  - 主屏幕组件容易成为状态和副作用聚合点。
  - UI 状态、通知、工具权限、消息渲染、输入控制互相影响，回归风险较高。
- **修复建议**：
  - 按功能域拆分 session lifecycle、notification orchestration、message viewport、footer/input orchestration 等 hooks 与子组件。
  - 对共享状态优先沉淀到 `AppStateStore` 或专用 store/hook。

## 3. 工具系统、服务层与模块边界

### 3.1 工具注册入口存在多套合并语义，容易误用

- **严重程度**：中高
- **文件路径**：`src/tools.ts`
- **证据**：
  - 约第 178 行定义 `getAllBaseTools()`。
  - 约第 252 行定义 `getTools(permissionContext)`。
  - 约第 316 行定义 `assembleToolPool(permissionContext, mcpTools)`，包含 deny rule 过滤、排序、去重。
  - 约第 347 行定义 `getMergedTools(permissionContext, mcpTools)`，直接 `return [...builtInTools, ...mcpTools]`，不去重，也不对 MCP 工具做 deny rule 过滤。
  - `ListMcpResourcesTool`、`ReadMcpResourceTool` 被加入 `getAllBaseTools()`，又在 `getTools()` 的 `specialTools` 中排除。
- **影响**：
  - 调用方如果误用 `getMergedTools()`，可能绕过 deny rule、产生重名工具、工具池排序与 prompt cache 策略不一致。
- **修复建议**：
  - 将 `assembleToolPool()` 作为唯一推荐工具池合并入口。
  - 将 `getMergedTools()` 重命名为 `getUnfilteredMergedTools()` 或标记为历史兼容 API。
  - 显式拆分 `getRegisteredBuiltInTools()`、`getSpecialBuiltInTools()`、`getModelVisibleBuiltInTools()`。

### 3.2 工具目录三文件模式执行不一致

- **严重程度**：中
- **文件路径**：`src/tools/`
- **证据**：
  - 基本符合三文件模式的代表：`BashTool`、`FileReadTool`、`FileEditTool`、`MCPTool`、`LSPTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool`。
  - 缺少 `UI.tsx` 的目录包括：`AskUserQuestionTool`、`SendUserFileTool`、`SleepTool`、`SnipTool`、`TaskCreateTool`、`TaskGetTool`、`TaskListTool`、`TaskUpdateTool`、`TodoWriteTool`、`ToolSearchTool`、`WorkflowTool`。
  - 缺少 `UI.tsx` 和 `prompt.ts` 的目录包括：`CtxInspectTool`、`MonitorTool`、`OverflowTestTool`、`PushNotificationTool`、`REPLTool`、`SubscribePRTool`、`SuggestBackgroundPRTool`、`SyntheticOutputTool`、`TungstenTool`、`VerifyPlanExecutionTool`。
  - 缺少与目录同名主文件的目录包括：`ExitPlanModeTool`、`ScheduleCronTool`、`TerminalCaptureTool`、`WebBrowserTool`。
- **影响**：
  - 真实 model-visible 工具、伪工具、feature flag 工具、辅助目录混杂，缺少显式豁免机制。
  - 后续自动治理或新人理解工具结构时容易误判。
- **修复建议**：
  - 建立 `tools/manifest` 或工具元数据，标注 `kind`、`modelVisible`、`requiresUI`、`requiresPrompt`、`registration`。
  - 对真实工具补齐三文件模式，对伪工具/辅助目录记录豁免理由。

### 3.3 `src/services/mcp` 与 UI/状态层耦合偏深

- **严重程度**：中高
- **文件路径**：
  - `src/services/mcp/useManageMCPConnections.ts`
  - `src/services/mcp/MCPConnectionManager.tsx`
  - `src/services/mcpServerApproval.tsx`
  - `src/services/mcp/utils.ts`
- **证据**：
  - `useManageMCPConnections.ts` 直接导入 React hooks、`useNotifications`、`useAppState`、`useAppStateStore`、`useSetAppState`，文件约 1024 行。
  - `MCPConnectionManager.tsx` 在 `services/mcp` 下定义 React Context 和 Provider。
  - `mcpServerApproval.tsx` 位于 `services` 层，但直接导入组件、`AppStateProvider`、`KeybindingSetup` 并执行 UI render。
  - `services/mcp/utils.ts` 依赖 `../../components/mcp/types.js`。
- **影响**：
  - 服务层不再是纯连接/协议层，难以脱离 React 测试或复用到 headless/SDK 场景。
- **修复建议**：
  - 拆分为 `services/mcp/core/*`、`hooks/mcp/useManageMCPConnections.ts`、`components/providers/MCPConnectionManager.tsx`。
  - 将共享类型移到 `src/types/mcp.ts` 或 `src/services/mcp/types.ts`。
  - 将 `mcpServerApproval.tsx` 迁移到 `dialogLaunchers`、`components/mcp` 或 `screens`。

### 3.4 MCP client 与具体工具实现耦合明显

- **严重程度**：中
- **文件路径**：`src/services/mcp/client.ts`
- **证据**：
  - 约第 45-48 行直接导入 `ListMcpResourcesTool`、`MCPTool`、`createMcpAuthTool`、`ReadMcpResourceTool`。
  - 约第 1628 行使用 `...MCPTool` 生成具体 MCP 工具。
  - 约第 1673 行硬编码 `message: 'MCPTool requires permission.'`。
  - 约第 2141/2152 行根据 auth 状态返回 `createMcpAuthTool(...)`。
- **影响**：
  - 协议 client 层知道工具 UI/prompt 实现细节，工具系统与 MCP 服务相互依赖。
- **修复建议**：
  - 引入 `McpToolFactory`：MCP client 只输出原始 capability/tool descriptor。
  - 在 `src/tools/MCPTool/factory.ts` 将 descriptor 转为 `Tool`。
  - `createMcpAuthTool` 生成逻辑也放到工具适配层。

### 3.5 `src/services/tools` 反向依赖大量具体工具

- **严重程度**：中
- **文件路径**：
  - `src/services/tools/toolExecution.ts`
  - `src/services/tools/StreamingToolExecutor.ts`
  - `src/services/tools/toolHooks.ts`
- **证据**：
  - `toolExecution.ts` 导入 `BashToolInput`、`BASH_TOOL_NAME`、`FILE_EDIT_TOOL_NAME`、`FILE_READ_TOOL_NAME`、`FILE_WRITE_TOOL_NAME`、`NOTEBOOK_EDIT_TOOL_NAME`、`POWERSHELL_TOOL_NAME`、`TOOL_SEARCH_TOOL_NAME`、`getAllBaseTools` 等具体工具信息。
  - `StreamingToolExecutor.ts` 直接依赖 `BASH_TOOL_NAME`。
  - `toolHooks.ts` 同时处理 hook、MCP tool output 更新、AppState、permission、hook result 等。
- **影响**：
  - 工具执行框架本应面向 `Tool` 抽象，但现在对具体工具名称和行为有大量分支认知。
  - 新增工具可能需要修改执行核心。
- **修复建议**：
  - 将具体工具特判收敛到工具元数据或策略接口，例如 `tool.telemetryClassifier`、`tool.onPreExecute`、`tool.onPostExecute`、`tool.getConcurrencyGroup`。
  - `toolExecution.ts` 保持对 `Tool` 抽象执行，不直接导入具体工具实现。

### 3.6 LSP 服务层类型安全风险较高

- **严重程度**：中高
- **文件路径**：
  - `src/services/lsp/LSPServerInstance.ts`
  - `src/services/lsp/LSPServerManager.ts`
- **证据**：
  - `LSPServerInstance.ts` 第 10 行存在 `// @ts-ignore`。
  - 多处通过 `(config as any)` 读取 `restartOnCrash`、`shutdownTimeout`、`maxRestarts`、`workspaceFolder`、`initializationOptions`、`startupTimeout`。
  - `LSPServerManager.ts` 多处通过 `(config as any).extensionToLanguage` 读取配置。
- **影响**：
  - `ScopedLspServerConfig` 与真实运行时 schema 不一致，配置错误可能被类型系统漏掉。
- **修复建议**：
  - 扩展 `src/services/lsp/types.ts`，纳入实际支持字段。
  - 用 schema 校验替代 `(config as any)`。
  - 移除 `// @ts-ignore`，改为显式类型导入或修正导出。

### 3.7 工具和服务中用户可见文案硬编码较多

- **严重程度**：中
- **文件路径与证据**：
  - `src/tools/MCPTool/MCPTool.ts`：`MCPTool requires permission.`
  - `src/services/mcp/client.ts`：`MCPTool requires permission.`
  - `src/tools/WebSearchTool/WebSearchTool.ts`：`WebSearchTool requires permission.`、`Error: Missing query`
  - `src/tools/TaskStopTool/TaskStopTool.ts`：`Missing required parameter: task_id`
  - `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`：`Exit plan mode?`
  - `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`：`Answer questions?`
  - `src/tools/MonitorTool/MonitorTool.ts`：`Monitor tool executed`
  - `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts`：`Artifact review completed`
- **影响**：
  - 部分 message 可能展示给用户，违反用户可见文本走 i18n 的要求。
- **修复建议**：
  - 对确认展示到 UI/CLI 的文本迁移到 `tSync()`/`t()`。
  - 对只给模型/日志/telemetry 的文本，使用 `modelMessage`、`telemetryReason` 等命名区分。

## 4. 脚本、测试、配置与仓库级冗余

### 4.1 `build:cli` / `build:sdk` 文档与实现不一致

- **严重程度**：高
- **文件路径**：
  - `package.json`
  - `build.ts`
  - `README.md`
  - `ZY.md`
- **证据**：
  - `package.json` 中：
    - `build`: `bun run build.ts`
    - `build:cli`: `bun run build.ts --target cli`
    - `build:sdk`: `bun run build.ts --target sdk`
  - `README.md` 与 `ZY.md` 声明 `build:cli` 仅构建 CLI、`build:sdk` 仅构建 SDK。
  - `build.ts` 只配置 `entrypoints: [join(srcDir, 'entrypoints/cli.tsx')]`。
  - 未发现 `process.argv` / `Bun.argv` / `--target` 解析逻辑。
- **影响**：
  - `build:sdk` 很可能不会真正构建 SDK，文档和命令误导开发者。
- **修复建议**：
  - 在 `build.ts` 显式解析 `--target cli|sdk|all`。
  - 或删除/更正 `build:cli`、`build:sdk` 命令与文档描述。

### 4.2 `.gitignore` 未覆盖本地敏感配置

- **严重程度**：高
- **文件路径**：`.gitignore`、`README.md`
- **证据**：
  - `.gitignore` 只有 `node_modules/`、`dist/`、`.DS_Store`。
  - 本地存在 `.claude/settings.local.json`、`.zy/settings.local.json`、`.vscode/settings.json`。
  - `README.md` 声明 `.zy/settings.local.json` 是本地配置并会自动加入 `.gitignore`，但当前未忽略。
- **影响**：
  - 本地配置、IDE 配置、Agent 配置目录存在误提交风险；`.zy/settings.local.json` 可能包含 API Key 或环境配置。
- **修复建议**：
  - 评估加入 `.zy/settings.local.json`、`.claude/settings.local.json`、`.aone_copilot/`、本地 IDE 配置忽略规则。
  - `.vscode/` 是否整体忽略需要按团队共享设置策略确认。

### 4.3 `tsconfig.json` 不覆盖 `tests/` 与 `scripts/`

- **严重程度**：高
- **文件路径**：`tsconfig.json`、`scripts/`、`tests/`
- **证据**：
  - `tsconfig.json` 中 `include` 为 `['src/**/*', 'build.ts']`。
  - `scripts/` 下存在多个 TypeScript 脚本。
  - `tests/` 下存在多个 `.test.ts` 文件。
  - `bun tsc --noEmit` 通过，但未覆盖 `tests/` 和大部分 `scripts/`。
- **影响**：
  - 当前类型检查通过不能证明测试与脚本类型正确。
- **修复建议**：
  - 新增 `tsconfig.test.json` / `tsconfig.scripts.json`。
  - 或将 `tests/**/*` 与需要长期维护的脚本纳入类型检查。

### 4.4 `scripts/` 中存在疑似一次性迁移脚本残留

- **严重程度**：高
- **文件路径**：`scripts/`
- **证据**：
  - `scripts/decompile-react.ts` 约 2286 行，用于反编译 React Compiler 输出。
  - `scripts/rename-temp-vars.ts` 约 913 行，用于重命名反编译临时变量。
  - `scripts/fix-tdz.ts` 约 350 行，用于修复反编译后的 TDZ 错误。
  - 这些脚本支持 `--dry-run`，但默认或部分模式会实际写文件。
  - `package.json` 未注册这些脚本。
- **影响**：
  - 专项迁移工具长期留在主脚本目录，维护成本高，且误执行可能改动大量文件。
- **修复建议**：
  - 明确分为长期维护工具和一次性迁移脚本。
  - 一次性脚本归档到 `scripts/archive/` 或确认后删除。
  - 保留脚本建议默认只读，必须显式 `--write` 才能修改文件。

### 4.5 脚本存在硬编码本机路径

- **严重程度**：高
- **文件路径**：
  - `scripts/scan-props-issues.ts`
  - `scripts/view-conversation.sh`
- **证据**：
  - `scripts/scan-props-issues.ts` 第 5 行：`const ROOT_DIR = '/Users/zy979/IdeaProjects/zy-code';`
  - `scripts/view-conversation.sh` 第 9 行：`PROJECT_DIR="$HOME/.zy/projects/-Users-zy979-IdeaProjects-zy-code"`
- **影响**：
  - 脚本绑定当前机器路径，在其他开发者、CI、不同 workspace 下不可复用。
- **修复建议**：
  - 改为基于 `process.cwd()`、`import.meta.dir`、参数传入或环境变量。
  - 若为个人临时调试脚本，应移动到不提交的本地目录或忽略规则范围内。

### 4.6 脚本依赖未在 `package.json` 显式声明

- **严重程度**：中高
- **文件路径**：
  - `scripts/decompile-react.ts`
  - `scripts/fix-tdz.ts`
  - `package.json`
- **证据**：
  - 脚本使用 `@babel/parser`、`@babel/traverse`、`@babel/generator`、`@babel/types`。
  - `package.json` 中未声明这些 `@babel/*` 依赖。
- **影响**：
  - 脚本可能依赖传递依赖或本地环境，换机器/CI 后失败。
- **修复建议**：
  - 如果脚本保留，将 `@babel/*` 加入 `devDependencies`。
  - 如果脚本为一次性残留，优先归档或删除，而不是扩大维护面。

### 4.7 `biome check` 当前失败，质量门禁不可用

- **严重程度**：中高
- **文件路径**：`package.json`、`biome.json`、多处源码与脚本
- **证据**：
  - `package.json` 中 `lint:biome` 为 `biome check .`。
  - `bunx biome check .` 返回码 `1`。
  - 输出包含格式化问题，以及 `scripts/fix-tdz.ts` 中 `fs`、`path` 应使用 `node:` 协议。
- **影响**：
  - lint 命令长期红灯时不能作为有效质量门禁。
- **修复建议**：
  - 若接受当前 Biome 规则，应分批修复格式和 `node:` 导入。
  - 若暂不接受，应调整 `biome.json` 范围或规则，并在文档说明。

### 4.8 `biome.json` 与 `tsconfig.json` 覆盖范围不一致

- **严重程度**：中
- **文件路径**：`biome.json`、`tsconfig.json`
- **证据**：
  - `biome.json` 覆盖 `src/**`、`scripts/**`、`tests/**`、`build.ts`。
  - `tsconfig.json` 只覆盖 `src/**/*`、`build.ts`。
- **影响**：
  - `scripts/`、`tests/` 被 Biome 检查但不被 TS 类型检查，质量信号割裂。
- **修复建议**：
  - 对 `scripts/`、`tests/` 建立独立 TS 检查脚本。
  - 或同步调整 Biome 与 TS 的覆盖策略并写入文档。

### 4.9 `build.ts` 宏值与功能开关集中硬编码

- **严重程度**：中
- **文件路径**：`build.ts`
- **证据**：
  - `build.ts` 中硬编码多个 features：`TRANSCRIPT_CLASSIFIER`、`FORK_SUBAGENT`、`REACTIVE_COMPACT`、`TOKEN_BUDGET`、`CONTEXT_COLLAPSE`、`HISTORY_SNIP`、`KAIROS`、`BUILTIN_EXPLORE_PLAN_AGENTS`。
  - 硬编码多个 `MACRO.*`：`MACRO.VERSION`、`MACRO.PACKAGE_URL`、`MACRO.NATIVE_PACKAGE_URL`、`MACRO.FEEDBACK_CHANNEL`、`MACRO.ISSUES_EXPLAINER`、`MACRO.VERSION_CHANGELOG`。
  - 项目规则明确禁止修改 `build.ts` 的 `define` 宏值。
- **影响**：
  - 关键发布信息集中在可随手编辑的位置，误改成本高。
- **修复建议**：
  - `MACRO.VERSION` 从 `package.json` 派生。
  - 宏配置抽为只读常量或配置生成流程。
  - 增加构建时校验，确保 `MACRO.VERSION` 与 `package.json.version` 一致。

### 4.10 根目录文档与当前实现不一致

- **严重程度**：中
- **文件路径**：`README.md`、`ZY.md`、`build.ts`
- **证据**：
  - README/ZY 声明完整构建包含 CLI + SDK，且支持 `build:sdk`。
  - `build.ts` 当前只配置 CLI entrypoint。
  - README 的 external 依赖说明与 `build.ts` external 列表不完全一致。
- **影响**：
  - 新开发者容易被过时说明误导。
- **修复建议**：
  - 优先修正 `build` / `build:cli` / `build:sdk` 描述。
  - external 列表改为“以 `build.ts` 为准”，或增加同步校验。

### 4.11 `FEATURE_FLAGS.md` 前缀约定与内容不完全一致

- **严重程度**：中
- **文件路径**：`FEATURE_FLAGS.md`
- **证据**：
  - 文档声明所有 flag 统一使用 `zy_` 前缀。
  - 文档中包含 `enhanced_telemetry_beta`。
- **影响**：
  - 读者无法判断这是历史遗留、外部兼容 flag，还是命名规范破坏。
- **修复建议**：
  - 如果是例外，增加“例外/外部兼容 flag”说明。
  - 如果不是例外，统一命名或修正文档约定。

### 4.12 测试命名/状态存在异常

- **严重程度**：中
- **文件路径**：`tests/`
- **证据**：
  - 现有测试主要使用 `.test.ts` 命名。
  - `git status --short` 显示 `AD tests/services/api/web_search_test.ts`，但该文件未出现在实际文件列表中。
- **影响**：
  - 工作区存在索引/工作树不一致状态，且 `web_search_test.ts` 不符合现有 `.test.ts` 风格。
- **修复建议**：
  - 确认是恢复、重命名为 `.test.ts`，还是从索引移除。
  - 统一测试命名为 `*.test.ts`。

### 4.13 `scripts/verify-snipCompact.ts` 未纳入标准测试

- **严重程度**：中
- **文件路径**：`scripts/verify-snipCompact.ts`、`package.json`
- **证据**：
  - 脚本注释为“P0 snipCompact 功能验证脚本”。
  - 内部使用自定义 `assert()`、`console.log()`，不是 `bun:test`。
  - `package.json` 的 `test` 仅为 `bun test`。
- **影响**：
  - P0 验证不会被标准测试命令覆盖，容易被遗忘。
- **修复建议**：
  - 若仍有价值，迁移到 `tests/services/compact/snipCompact.test.ts`。
  - 若只是历史验证脚本，归档或删除前确认。

### 4.14 示例配置字段类型不统一

- **严重程度**：中
- **文件路径**：`model-capabilities.example.json`
- **证据**：
  - `contextWindow`、`maxInputTokens`、`maxOutputTokens` 中同时出现 `"200k"`、`"64k"` 与 `64000`。
- **影响**：
  - 如果 schema 不支持 union，用户照抄后可能配置校验不一致。
- **修复建议**：
  - 明确 schema 是否支持 `number | string`。
  - 示例中统一风格，或增加说明两种写法均有效。

## 5. 建议治理路线

### 第一阶段：修复质量门禁与误导性配置

- 修正 `build:cli` / `build:sdk` 与 `build.ts` 的不一致。
- 补充 `.gitignore` 对本地敏感配置的保护。
- 明确 `tsconfig` 对 `tests/`、`scripts/` 的覆盖策略。
- 让 `bunx biome check .` 回到可用状态，或调整规则范围并文档化。

### 第二阶段：收敛 LLM 标准类型与业务层 snake_case

- 修复 `src/types/llm.ts`、`src/types/message.ts` 的 snake_case 残留。
- 修复 Agent usage 内部结构，避免 UI/业务层读取 `input_tokens` 等旧字段。
- 拆分 legacy message normalize 与严格 provider conversion。

### 第三阶段：治理 UI/i18n 与快捷键注册

- 补齐 `BackgroundTasksDialog` 英文翻译 key。
- 将 notification hooks、ThinkingToggle、工具权限提示等用户可见文案迁移到 i18n。
- 调整 `KeyboardShortcutHint` API 或 action 注册表，避免传入翻译结果。

### 第四阶段：模块边界与大文件拆分

- 拆分 `BackgroundTasksDialog.tsx`、`REPL.tsx`、`query.ts`、`services/api/zy.ts`。
- 将 MCP 服务拆为 core service、React hook、UI provider 三层。
- 将工具执行框架对具体工具的依赖转为工具元数据/策略接口。

### 第五阶段：脚本与文档清理

- 区分长期维护脚本与一次性迁移脚本。
- 移除或归档硬编码本机路径脚本。
- 补齐脚本依赖或删除无维护价值脚本。
- 同步 README、ZY、FEATURE_FLAGS 与实际实现。

## 6. 本次未做事项

- 未修改业务源码。
- 未修复任何 lint/type 问题。
- 未读取可能包含敏感信息的 `.zy/settings.local.json`、`.claude/settings.local.json`。
- 未对每个 `as any` 做全仓逐行审计，本文件优先记录证据明确、治理价值较高的问题。
