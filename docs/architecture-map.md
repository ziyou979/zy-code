# ZY Code 架构导航图

面向维护者的速查地图——帮你在改代码前快速定位"我该看哪里"。

> 所有路径以 `src/` 为根。行号为近似参考（截至 2026-06），可能随重构漂移。

---

## 概览

ZY Code 是一个 **TypeScript + React (Ink)** 终端 AI 助手，用 **Bun** 构建打包。核心数据流：

```
用户输入 → CLI 启动 → REPL 循环 → QueryEngine → LLM 调用 → 工具执行 → Ink 渲染
```

---

## 1. 启动链路

从 `bun src/entrypoints/cli.tsx` 到看见提示符：

```
entrypoints/cli.tsx
  │
  ▼
main.tsx (345 行)               预取（MDM / keychain / profile）+ Commander 装配
  │
  ▼
cli/bootstrap/entrypoint.ts     迁移、设置初始化
  │
  ▼
cli/commands/root.ts (~3400 行) 参数解析 + feature() 门控 + 模式分派
  │
  ▼  按模式调用 cli/assembly/ 中的分派函数
cli/assembly/
  ├─ interactiveMode.ts         默认交互式
  ├─ resumedSession.ts          恢复历史会话
  ├─ directConnectMode.ts       远程 server 直连
  ├─ sshMode.ts                 SSH 隧道会话
  └─ remoteSession.ts           远程/桥接会话
      │
      ▼
replLauncher.tsx → screens/REPL.tsx (1338 行)
```

**当前 feature() 门控**（root.ts 中活跃的）：

| Flag | 控制什么 |
|------|----------|
| `KAIROS` / `KAIROS_BRIEF` / `KAIROS_CHANNELS` | Kairos 功能族 |
| `COORDINATOR_MODE` | 多 worker 编排 |
| `BRIDGE_MODE` | 远程桥接会话 |
| `DIRECT_CONNECT` | 远程 server 直连 |
| `SSH_REMOTE` | SSH 远程 |
| `BG_SESSIONS` | 后台会话 |
| `PROACTIVE` | 主动触发 |
| `CCR_MIRROR` | CCR 镜像 |
| `WEB_BROWSER_TOOL` | 浏览器工具 |
| `CHICAGO_MCP` / `UDS_INBOX` | MCP 相关 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照 |

---

## 2. 查询链路

用户发消息后的完整路径：

```
REPL.tsx（用户提交 / 续轮）
  │
  ▼
QueryEngine.ts (1215 行)        会话级状态：消息列表、cost、budget、tool context
  │  .ask()
  ▼
query.ts (1711 行) → queryLoop()
  │
  ├─ 1. Prompt 组装        ← query/config.ts
  ├─ 2. Token 预算        ← query/tokenBudget.ts
  ├─ 3. 模型请求           ← services/api/llmOrchestrator.ts
  ├─ 4. Stream 处理        ← compact / contextCollapse / 流式事件
  ├─ 5. 工具调度           ← toolUseContext
  ├─ 6. Recovery           ← maxOutputTokensRecovery
  └─ 7. 继续/终止判定      ← query/transitions.ts + query/stopHooks.ts
         │
         ▼
services/api/llmOrchestrator.ts     LLM 业务入口
  ├─ AnthropicProviderAdapter.ts    Anthropic SDK 适配
  ├─ OpenAIProviderAdapter.ts       OpenAI 兼容适配
  └─ conversions/*.ts               SDK 流 → 统一 StreamEvent
```

**核心约束**：
- 业务代码**禁止**直接 import SDK，类型从 `src/types/llm.ts` 导入
- Provider 专属字段走 `CreateParams.providerExtras`

---

## 3. 工具执行链路

```
query.ts（收到 tool_use 事件）
  │
  ▼
tools/<ToolName>/               三文件模式
  ├─ ToolName.ts(x)             逻辑主体
  ├─ UI.tsx                     Ink 渲染
  └─ prompt.ts                  LLM 提示词
      │
      ├─ 权限校验   ← services/policyLimits/
      ├─ 执行       ← services/sandbox/ | shell-eval/ | bridge/
      │
      ▼
  tool_result → 进入下一轮 queryLoop
```

当前内置工具（40+）：Agent、Bash、FileRead/Edit/Write、Glob、Grep、Monitor、MCP、Notebook、PowerShell、LSP、Worktree、PushNotification 等。

---

## 4. 状态管理

| 层 | 模块 | 放什么 | 不放什么 |
|---|---|---|---|
| 进程单例 | `bootstrap/state/` | 会话 ID、成本、用量、model、scroll、cron | UI 状态 |
| React 共享 | `state/AppStateStore.ts` | MCP/插件/通知/elicitation | 进程级数据 |
| 组件局部 | `useState` | 仅当前组件的瞬态 | 多组件共享 |
| 持久化 | `services/filePersistence/` | 落盘的会话/配置 | 进程内瞬态 |

`bootstrap/state/` 已按域拆分为独立模块：

```
bootstrap/state/
  ├─ _core.ts          核心状态定义 (472 行)
  ├─ session.ts        会话 ID / 状态
  ├─ cost.ts           费用追踪
  ├─ duration.ts       时长统计
  ├─ model.ts          当前模型
  ├─ scroll.ts         滚动位置
  ├─ tokens.ts         Token 计数
  └─ apiTracking.ts    API 请求追踪
```

**红线**：`bootstrap/state/` 是导入 DAG 的叶子节点——不允许反向依赖 `services/` 或 `state/`。

---

## 5. 扩展点速查

"我想加个新功能，代码该放哪？"

| 你想做什么 | 选什么 | 放在哪 |
|---|---|---|
| 让 LLM 主动调用某能力 | Tool | `tools/<X>/`（三文件模式） |
| 用户输入 `/xxx` 触发 | Command | `commands/<x>/` |
| 可学习/可召回的知识能力 | Skill | `skills/bundled/<x>.ts` |
| 进程级能力增强 | Plugin | `plugins/bundled/` |
| 外部工具协议接入 | MCP Server | 配 `mcpConfig` + `services/mcp/` |
| 后台异步任务 | Background Job | `services/background/` 或 `services/jobs/` |
| 多 worker 编排 | Coordinator | `coordinator/` (COORDINATOR_MODE) |
| 远程会话 | Bridge | `bridge/` (BRIDGE_MODE) |
| 快捷键/按键行为 | Keybinding | `keybindings/` |
| 主动触发行为 | Proactive | `proactive/` (PROACTIVE flag) |

---

## 6. 顶层目录速查

```
src/
├─ cli/                   CLI 框架：bootstrap / commands / handlers / options / transports / assembly
├─ screens/               顶层页面（REPL.tsx、Doctor.tsx）
├─ components/            React (Ink) 组件
├─ hooks/                 React hooks
├─ ink/                   Ink 底层（组件、事件、布局、termio）
├─ context/               React Context（modal、overlay、notifications、voice）
├─ keybindings/           快捷键系统（解析、匹配、冲突检测）
├─ vim/                   Vim 模式（motions、operators、text objects）
├─ voice/                 语音输入
│
├─ tools/                 内置工具（三文件模式，40+）
├─ commands/              斜杠命令（100+）
├─ skills/                技能系统（bundled/ 内置技能）
├─ plugins/               插件系统
│
├─ services/              业务服务层（见下表）
├─ query/                 查询配置（config / tokenBudget / transitions / stopHooks）
├─ query.ts               查询主循环
├─ QueryEngine.ts         对话引擎
│
├─ bootstrap/state/       全局单例状态（按域拆分）
├─ state/                 React 共享状态 (AppStateStore)
│
├─ shell-eval/            Shell 解析与执行（bash / powershell / shared）
├─ bridge/                远程桥接（transport、JWT、webhook）
├─ coordinator/           多 worker 编排
├─ proactive/             主动触发
├─ memdir/                记忆目录（查找/扫描/团队记忆）
│
├─ tasks/                 后台任务类型
│   ├─ DreamTask/
│   ├─ LocalAgentTask/
│   ├─ LocalShellTask/
│   ├─ LocalWorkflowTask/
│   ├─ RemoteAgentTask/
│   ├─ InProcessTeammateTask/
│   ├─ LocalMainSessionTask.ts
│   └─ MonitorMcpTask/
│
├─ daemon/                后台守护进程
├─ server/                内置服务器
├─ remote/                远程连接
├─ ssh/                   SSH 支持
├─ assistant/             助手会话历史
├─ goal/                  目标驱动工作流
├─ jobs/                  作业分类器
│
├─ i18n/                  国际化（en / zh-CN）
├─ types/                 公共类型（llm.ts 等）
├─ utils/                 工具函数（messages/ + hooks/ 子模块化）
├─ migrations/            数据迁移脚本
├─ schemas/               JSON Schema
├─ constants/             全局常量
├─ outputStyles/          输出样式
│
├─ environment-runner/    环境运行器
├─ self-hosted-runner/    自托管运行器
├─ upstreamproxy/         上游代理
└─ wizard/                向导流程
```

---

## 7. 服务层（`src/services/`）

按职责分域，业务代码的主要依赖目标：

| 域 | 服务 | 一句话 |
|---|---|---|
| **LLM** | `api/` | Orchestrator + Provider 适配 + 流转换 |
| **MCP** | `mcp/` | 连接管理、OAuth、SDK MCP |
| **分析** | `analytics/` | GrowthBook 功能开关 + 遥测 |
| | `telemetry/` | 遥测数据收集 |
| **存储** | `filePersistence/` | 会话/配置落盘 |
| | `secureStorage/` | Keychain / 密钥 |
| | `sessionTranscript/` | 会话转录导出 |
| **记忆** | `memory/` | 持久化记忆 |
| | `extractMemories/` | 自动记忆提取 |
| | `SessionMemory/` | 会话短期记忆 |
| | `teamMemorySync/` | 团队记忆同步 |
| **模型** | `model/` | 模型选择与字符串 |
| | `compact/` | 上下文压缩 |
| | `contextCollapse/` | 智能裁剪对话历史 |
| | `tokenizer/` | Token 计算 |
| **工具** | `sandbox/` | 沙箱执行 |
| | `search/` | 代码/文件检索 |
| | `lsp/` | LSP 客户端 |
| | `computerUse/` | 截图/输入 |
| **任务** | `task/` | 任务管理 |
| | `background/` | 后台任务 |
| | `jobs/` | 作业管理 |
| | `workflow/` | 工作流（reminder/keyword） |
| | `ultraplan/` | 复杂任务编排 |
| | `autoDream/` | 自动 Dream 触发 |
| **UI** | `suggestions/` | 补全/推荐 |
| | `tips/` | 使用技巧 |
| | `PromptSuggestion/` | 提示词建议 |
| | `toolUseSummary/` | 工具使用摘要 |
| | `AgentSummary/` | Agent 摘要 |
| **集成** | `github/` | GitHub |
| | `claudeInChrome/` | Chrome 扩展 |
| | `deepLink/` | 深度链接 |
| | `teleport/` | Teleport |
| | `dxt/` | DXT 扩展 |
| **其他** | `oauth/` | 认证流程 |
| | `plugins/` | 插件系统 |
| | `skills/` / `skillSearch/` | 技能加载与搜索 |
| | `swarm/` | 多 agent 蜂群 |
| | `policyLimits/` | 用量/权限管控 |
| | `remoteManagedSettings/` | 远程设置 |
| | `settingsSync/` | 设置同步 |
| | `nativeInstaller/` | 原生安装器 |
| | `MagicDocs/` | 智能文档 |
| | `voice*.ts` | 语音（STT / keyterms） |
| | `todo/` | TODO 管理 |

---

## 8. 工具函数子模块（`src/utils/`）

原巨型文件已拆为独立子模块：

**`utils/messages/`**（~5900 行，10 模块）：

| 模块 | 职责 |
|------|------|
| `api.ts` (2715 行) | API 后处理 / plan 模板 |
| `normalize.ts` | 规范化 / 合并 / 过滤 |
| `constructors.ts` | 消息构造器 |
| `lookups.ts` | 查找表 |
| `predicates.ts` | 谓词 / 文本提取 |
| `prune.ts` | 修剪 / 剥离 |
| `streaming.ts` | 流式处理 |
| `mappers.ts` | 映射器 |
| `constants.ts` | 常量 / 分类器 |
| `systemInit.ts` | 系统初始化 |

**`utils/hooks/`**（35+ 模块）：

- 核心：`executeEngine.ts` / `matcher.ts` / `commandRunner.ts` / `functionHooks.ts`
- 执行器（`executors/`）：compact / config / elicitation / fileSuggestion / lifecycle / messageDisplay / notification / teammate / tool / worktree

---

## 9. Monorepo（`packages/`）

| 包 | 用途 |
|---|---|
| `claude-for-chrome-mcp/` | Chrome 扩展 MCP 服务 |
| `computer-use-mcp/` | 计算机使用 MCP |
| `computer-use-input/` | 计算机使用输入层 |
| `computer-use-swift/` | macOS 原生计算机使用 |

---

## 10. 已完成的重构（里程碑）

这些曾经是"大泥球"，现在已经治理完成：

| 原状态 | 现状态 | 做了什么 |
|---|---|---|
| `screens/REPL.tsx` 6200 行 | **1338 行** | 子容器抽离完成 |
| 运行时状态 | **按领域拆分为独立模块** | `bootstrap/state/` + 可注入 `runtimeContext` |
| `utils/session-storage.ts` 5000 行 | **139 行** | 业务逻辑迁出 |
| `cli/commands/root.ts` 无模块化 | **assembly/ 已抽出 5 个模式** | 但 root.ts 仍 3400 行，继续中 |

---

## 11. 待治理的大文件

| 文件 | 行数 | 拆分思路 |
|---|---|---|
| `cli/commands/root.ts` | ~3400 | 继续按 feature 门控拆分更多 assembly 模块 |
| `utils/messages/api.ts` | ~2700 | 按功能域再拆（plan 模板 / API 后处理 / 格式化） |
| `query.ts` | ~1700 | 按 stage 拆为 `query/stages/*.ts` |
| `QueryEngine.ts` | ~1200 | 等 query.ts 拆完后评估 |

---

## 12. 历史地雷（别踩）

- **`src/` 根目录的 `.ts` 文件**（`Tool.ts` / `Task.ts` / `tools.ts` / `query.ts` 等）— 历史结构，**禁止新增**根级文件
- **`utils/` 的业务代码** — 新代码一律放 `services/<domain>/` 或 `src/<domain>/`

详见 [AGENTS.md](../AGENTS.md) 第 12 条"目录边界"。
