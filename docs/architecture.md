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
- `src/bootstrap/state/` — 按领域拆分的运行时状态实现；服务与组件通过 `bootstrap/runtime/runtimeContext.ts` 的可注入接口访问，仅状态类型允许直接导入
- `src/state/` — `AppStateStore.ts` / `store.ts` 组合唯一 store；`slices/` 按 UI、权限、任务、插件、通知组织默认值、selector 和更新器

## 工具与命令

- `src/tools/` — Tool 定义；按 `interactive`、`headless`、`internal` 档案决定是否需要 `UI.tsx` 和 `prompt.ts`
- `src/commands/` — 每个斜杠命令一个子目录（`/compact`、`/goal`、`/plan`、`/review` 等 100+）
- `src/skills/` — 技能系统（`bundled/` 内置 + 插件技能）

## LLM 适配

`src/services/api/` — Anthropic / OpenAI 统一适配层：
- `llmOrchestrator.ts` — 稳定业务入口；内部由 `llm-orchestrator/` 中的非流式请求、流式准备、流式执行和空闲看门狗共同完成请求/重试/用量编排
- `AnthropicProviderAdapter.ts` / `OpenAIProviderAdapter.ts` — Provider 专属 SDK 适配（实现 `LLMAdapter`）
- `conversions/anthropic.ts` / `conversions/openai.ts` — SDK 流 → `AsyncIterable<StreamEvent>` 的标准化转换

P8 大文件治理后的主要内部边界：

- `components/PromptInput/`：状态、建议、提交、快捷键、视图模型与渲染分离，`PromptInput.tsx` 只按固定顺序组合各阶段
- `bridge/bridge-main/`：CLI 参数、headless 启动、轮询循环和生命周期辅助逻辑分离
- `services/plugins/plugin-loader/`、`services/plugins/marketplace-manager/`：缓存、来源安装、清单构建、市场加载与注册职责分离
- `services/attachments/attachment-pipeline/`：附件类型、收集、模式提醒、上下文增量、记忆、技能和任务提醒分离
- `commands/insights/`：远程采集、会话分析、聚合、洞察生成、报告渲染和导出分离
- `cli/commands/root.ts`：仅串联准备、运行时初始化、资源加载和会话构建四个阶段
- `services/mcp/auth/`、`services/mcp/client/`：OAuth、令牌、传输、连接、发现和重连职责分离
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
| `extract-memories/` | 自动记忆提取 |
| `skill-runtime/` | Skill 变更检测等运行时能力；定义与内置资源位于 `src/skills/` |
| `sandbox/` | 沙箱执行 |
| `github/` | GitHub 集成 |
| `swarm/` | 多 agent 蜂群 |
| `todo/` | TODO 管理 |
| `plugins/` | 插件系统 |
| `settings/` | 持久化设置、校验、变更检测与状态栏配置 |
| `session-state/` | bridge/headless 会话状态通知契约 |
| `session-storage/` | 会话元数据、日志与 transcript 持久化实现 |
| `file-search/` | glob 与文件搜索领域入口 |
| `markdown/` | markdown frontmatter 解析 |
| `tool-runtime/` | Tool 调度、流式执行和生命周期 |
| `task-runtime/` | Task 输出、持久化和运行时操作 |
| `computer-use/` | 计算机使用（截图/输入） |
| `background/` | 后台任务管理（从 `utils/` 迁移） |
| `jobs/` | 后台作业管理（从 `utils/` 迁移） |
| `dxt/` | DXT 扩展支持（从 `utils/` 迁移） |
| `claude-in-chrome/` | Chrome 扩展集成（从 `utils/` 迁移） |
| `teleport/` | Teleport 支持（从 `utils/` 迁移） |
| `deep-link/` | 深度链接处理（从 `utils/` 迁移） |
| `compact/context-collapse/` | 上下文折叠（智能裁剪对话历史） |
| `file-persistence/` | 文件持久化（会话/配置存储） |
| `policy-limits/` | 策略限制（用量/权限管控） |
| `process-user-input/` | 用户输入处理（命令解析/分发） |
| `remote-managed-settings/` | 远程托管设置 |
| `search/` | 搜索服务（代码/文件检索） |
| `secure-storage/` | 安全存储（keychain/密钥管理） |
| `session-transcript/` | 会话转录（导出/回放） |
| `settings-sync/` | 设置同步（跨设备/会话） |
| `skill-search/` | 技能搜索（语义/关键词匹配） |
| `suggestions/` | 建议系统（补全/推荐） |
| `team-memory-sync/` | 团队记忆同步 |
| `telemetry/` | 遥测数据收集 |
| `tips/` | 提示信息（使用技巧/引导） |
| `tokenizer/` | Token 计算（多模型适配） |
| `tool-use-summary/` | 工具使用摘要 |
| `ultraplan/` | 超级计划（复杂任务编排） |
| `agent-summary/` | Agent 摘要生成 |
| `magic-docs/` | 智能文档（自动补全/引用） |
| `prompt-suggestion/` | 提示词建议 |
| `session-memory/` | 会话记忆（短期上下文） |
| `auto-dream/` | 自动 Dream（后台任务触发） |
| `native-installer/` | 原生安装器（平台适配） |

## 工具函数模块化（`src/utils/`）

`src/utils/` 的目标边界是只允许无 IO、无状态、无业务语义的纯函数。架构检查对历史债务采用精确基线并禁止新增；新增实现不得仿照存量违规。

- **`messages/`**（10 模块）：`constants.ts`（常量/分类器）、`predicates.ts`（谓词/文本提取）、`constructors.ts`（消息构造器）、`lookups.ts`（查找表）、`prune.ts`（修剪/剥离）、`normalize.ts`（规范化/合并/过滤）、`api.ts`（API 后处理/plan 模板）、`streaming.ts`（流式处理）、`mappers.ts`（映射器）、`systemInit.ts`（系统初始化）
- hooks 业务执行正式位于 `services/hooks/`，React hooks 位于 `src/hooks/`；旧 `utils/hooks/` 已删除
- 权限正式位于 `services/permissions/`；旧 `utils/permissions/` 已删除
- 插件正式位于 `services/plugins/`；旧 `utils/plugins/` 已删除
- `utils/sessionStorage.ts` 仅为 API 兼容入口，正式实现位于 `services/session-storage/`

## 正式路径与兼容路径

- 生产代码应导入正式领域路径。
- 兼容入口只能进行无状态 re-export，不得包含缓存、IO 或业务分支。
- 同一领域的定义层与运行时层使用不同名称，例如 `tools/` 与 `services/tool-runtime/`、`tasks/` 与 `services/task-runtime/`。

## 命名

- 普通多词目录使用 `kebab-case`。
- React 组件目录和文件使用 `PascalCase`。
- Tool 目录使用 `PascalCaseTool`。
- 普通模块使用 `camelCase.ts`，Hook 使用 `useXxx.ts(x)`。

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
