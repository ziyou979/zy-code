# 架构

**TypeScript + React (Ink)** 终端 UI 应用，**Bun** 打包。

## 入口

- `src/entrypoints/cli.tsx` → `src/main.tsx`（CLI 主入口）
- `src/entrypoints/mcp.ts`（MCP 服务）
- `src/entrypoints/sdk/`（SDK 类型）

## 核心

- `src/main.tsx` — 启动入口（346 行）：仅处理副作用预取（MDM、keychain、profile），委托给 `src/cli/bootstrap/entrypoint.ts`
- `src/cli/` — **CLI 框架**（从 main.tsx 拆分）：`bootstrap/`（迁移、设置、预取）、`commands/`（根命令、auth、mcp、plugins）、`handlers/`（agents、autoMode）、`options/`（模型、权限、会话等）、`transports/`（SSE/WebSocket/Hybrid）、`activate/`（主动激活）
- `src/QueryEngine.ts` — 对话引擎：消息流、工具调用、上下文管理
- `src/query/` — 查询配置、token 预算、停止钩子、状态转换
- `src/bootstrap/state.ts` — **全局单例状态**（会话 ID、成本、模型、遥测、cron 任务等），替代原 `src/state/` 的部分职责。导入 DAG 的叶子节点，禁止引入更多状态
- `src/state/` — `AppStateStore.ts` / `store.ts`，React 组件共享状态（selectors 读取）

## 工具与命令

- `src/tools/` — 三文件模式：`ToolName.ts(x)` + `UI.tsx` + `prompt.ts`
- `src/commands/` — 每个斜杠命令一个子目录（`/compact`、`/goal`、`/plan`、`/review` 等 100+）
- `src/skills/` — 技能系统（`bundled/` 内置 + 插件技能）

## LLM 适配

`src/services/api/` — Anthropic / OpenAI 统一适配层：
- `llmOrchestrator.ts` — 业务入口，编排请求/重试/用量；业务层只与它打交道
- `AnthropicProviderAdapter.ts` / `OpenAIProviderAdapter.ts` — Provider 专属 SDK 适配（实现 `LLMAdapter`）
- `conversions/anthropic.ts` / `conversions/openai.ts` — SDK 流 → `AsyncIterable<StreamEvent>` 的标准化转换
- 业务层通过 `src/types/llm.ts` 标准类型交互，**禁止**直接导入 SDK
- Provider 专属字段走 `CreateParams.providerExtras`

## 关键模块

| 目录 | 职责 |
|------|------|
| `src/shell-eval/` | **Shell 解析与执行**（从 `utils/` 提升）：`bash/`（parser、AST、命令注册）、`powershell/`（parser、危险 cmdlet）、`shared/`（provider、输出限制、只读校验） |
| `src/bridge/` | 远程会话桥接（REPL bridge、transport、JWT、webhook） |
| `src/coordinator/` | 协调器模式（多 worker 编排，`AgentTool` 调度） |
| `src/assistant/` | 助手会话发现与历史 |
| `src/goal/` | 目标驱动工作流 |
| `src/tasks/` | 任务类型（Dream、LocalAgent、LocalShell、Remote、Workflow 等） |
| `src/daemon/` | 后台守护进程 |
| `src/server/` | 内置服务器（含 `backends/`） |
| `src/remote/` | 远程连接 |
| `src/ssh/` | SSH 支持 |

## 服务层（`src/services/`）

| 服务 | 职责 |
|------|------|
| `api/` | API 客户端、重试、用量、流适配 |
| `mcp/` | MCP 连接管理与 OAuth |
| `lsp/` | LSP 客户端（IDE 诊断） |
| `analytics/` | GrowthBook 功能开关、遥测 |
| `oauth/` | 认证流程 |
| `model/` | 模型选择与字符串 |
| `compact/` | 上下文压缩 |
| `memory/` | 持久化记忆 |
| `extractMemories/` | 自动记忆提取 |
| `skills/` | 技能加载与搜索 |
| `sandbox/` | 沙箱执行 |
| `github/` | GitHub 集成 |
| `swarm/` | 多 agent 蜂群 |
| `todo/` | TODO 管理 |
| `plugins/` | 插件系统 |
| `computerUse/` | 计算机使用（截图/输入） |
| `background/` | 后台任务管理（从 `utils/` 迁移） |
| `jobs/` | 后台作业管理（从 `utils/` 迁移） |
| `dxt/` | DXT 扩展支持（从 `utils/` 迁移） |
| `claudeInChrome/` | Chrome 扩展集成（从 `utils/` 迁移） |
| `teleport/` | Teleport 支持（从 `utils/` 迁移） |
| `deepLink/` | 深度链接处理（从 `utils/` 迁移） |
| `contextCollapse/` | 上下文折叠（智能裁剪对话历史） |
| `filePersistence/` | 文件持久化（会话/配置存储） |
| `policyLimits/` | 策略限制（用量/权限管控） |
| `processUserInput/` | 用户输入处理（命令解析/分发） |
| `remoteManagedSettings/` | 远程托管设置 |
| `search/` | 搜索服务（代码/文件检索） |
| `secureStorage/` | 安全存储（keychain/密钥管理） |
| `sessionTranscript/` | 会话转录（导出/回放） |
| `settingsSync/` | 设置同步（跨设备/会话） |
| `skillSearch/` | 技能搜索（语义/关键词匹配） |
| `suggestions/` | 建议系统（补全/推荐） |
| `task/` | 任务管理（Dream/LocalAgent/Remote 等） |
| `teamMemorySync/` | 团队记忆同步 |
| `telemetry/` | 遥测数据收集 |
| `tips/` | 提示信息（使用技巧/引导） |
| `tokenizer/` | Token 计算（多模型适配） |
| `toolUseSummary/` | 工具使用摘要 |
| `ultraplan/` | 超级计划（复杂任务编排） |
| `AgentSummary/` | Agent 摘要生成 |
| `MagicDocs/` | 智能文档（自动补全/引用） |
| `PromptSuggestion/` | 提示词建议 |
| `SessionMemory/` | 会话记忆（短期上下文） |
| `autoDream/` | 自动 Dream（后台任务触发） |
| `nativeInstaller/` | 原生安装器（平台适配） |

## 工具函数模块化（`src/utils/`）

原巨型文件已按职责拆分为子模块：

- **`messages/`**（10 模块）：`constants.ts`（常量/分类器）、`predicates.ts`（谓词/文本提取）、`constructors.ts`（消息构造器）、`lookups.ts`（查找表）、`prune.ts`（修剪/剥离）、`normalize.ts`（规范化/合并/过滤）、`api.ts`（API 后处理/plan 模板）、`streaming.ts`（流式处理）、`mappers.ts`（映射器）、`systemInit.ts`（系统初始化）
- **`hooks/`**（35+ 模块）：核心引擎（`executeEngine.ts`）、匹配器（`matcher.ts`）、命令运行器（`commandRunner.ts`）、函数钩子（`functionHooks.ts`）、执行器子目录（`executors/` 含 compact/config/fileSuggestion/elicitation/notification/teammate/lifecycle/worktree/tool）

## UI 层

- `src/screens/` — 顶层页面（`REPL.tsx`、`Doctor.tsx`）
- `src/components/` — React 组件（Ink 渲染）
- `src/hooks/` — React hooks（状态、快捷键、权限、通知）
- `src/ink/` — Ink 底层（组件、事件、布局、termio）
- `src/context/` — React Context（modal、overlay、notifications、voice）

## 构建

`Bun.build()`：入口 `src/entrypoints/cli.tsx` → `dist/`，`define` 宏（VERSION/BUILD_TIME 等），`USER_TYPE` tree-shake，原生/云 SDK 外部化，`color-diff-napi` → `src/native-ts/` 回退。

## Monorepo（`packages/`）

- `claude-for-chrome-mcp/`、`computer-use-mcp/`、`computer-use-input/`
