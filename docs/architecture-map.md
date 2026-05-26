# ZY Code 架构导航图

面向维护者的速查地图。覆盖启动链路、查询链路、工具执行链路、状态边界、扩展点选择规则。
所有路径以 `src/` 为根，`L<n>` 表示文件首要符号所在行号（截至 2026-05）。

---

## 1. 启动链路（cold start → REPL）

```
entrypoints/cli.tsx
  ↓ 动态 import（按 USER_TYPE / 命令分支）
main.tsx                       L80  main()
  ↓ rewriteArgv → mdm/keychain/profile 预取
  ↓ run()                      L193
cli/bootstrap/entrypoint.ts    L7   initializeEntrypoint()
  ↓ Commander 装配（subcommands: ant/auth/mcp/plugin/automation/...）
cli/commands/root.ts           L355 rootAction()           ← 3600 行总装
  ├─ 参数解析 + feature() 门控（KAIROS / COORDINATOR / BRIDGE / LODESTONE ...）
  ├─ setup() / showSetupScreens() / 信任门
  ├─ MCP/插件/技能/agent 装载
  ├─ hooks 启动（SessionStart）
  └─ 7 个 launchRepl 出口（按模式分派）
       │
       ├─ L2799  resume 流程
       ├─ L2853  directConnect（远程 server）
       ├─ L2938  SSH session
       ├─ L3065  coordinatorRemote / assistant
       ├─ L3248  bridge 远程
       ├─ L3533  resume chooser 后
       └─ L3622  默认 interactive

replLauncher.tsx               L13  launchRepl()
  ↓ Ink render
screens/REPL.tsx               L552 REPL()                 ← 6200 行 UI 容器
```

**经验法则**：新增一个"启动模式"先想清楚要在 `rootAction` 内分支，还是抽到 assembly 模块（见 Phase 1 重构）。

---

## 2. 查询链路（用户消息 → 模型流 → 工具）

```
REPL.tsx                       触发 query（onSubmit / 续轮）
  ↓ 通过 QueryEngine.ask() 启动一次会话
QueryEngine.ts                 L158 class QueryEngine
  ↓ 维持会话级状态（消息列表、tool context、cost、budget）
  ↓ for-await 调用 query()
query.ts                       L214 query() → L232 queryLoop()
  ↓ 单轮职责（仍在中心化，待 Phase 4 阶段化）：
  ├─ prompt assembly（system / user / system context）
  ├─ buildQueryConfig()        query/config.ts
  ├─ 模型请求
  ├─ stream 处理（compact / contextCollapse / 流式事件）
  ├─ 工具调度（toolUseContext）
  ├─ recovery（maxOutputTokensRecovery）
  └─ 继续/终止判定（query/transitions.ts）
       ↓
services/api/llmOrchestrator.ts   ← LLM 业务入口
  ├─ AnthropicProviderAdapter.ts
  ├─ OpenAIProviderAdapter.ts
  └─ conversions/{anthropic,openai}.ts  ← SDK 流 → StreamEvent
```

**禁止**：业务代码直接 `import` Anthropic/OpenAI SDK；类型必须从 `src/types/llm.ts` 导入。
**约定**：Provider 专属字段走 `CreateParams.providerExtras`。

---

## 3. 工具执行链路

```
query.ts (toolUseContext)
  ↓ 模型 streamEvent: tool_use
tools/<ToolName>.ts            三文件模式: ToolName.ts(x) + UI.tsx + prompt.ts
  ├─ 权限校验（services/policyLimits/）
  ├─ 执行（可能调用 services/sandbox/、shell-eval/、bridge/）
  └─ 返回 tool_result → 进入下一轮 queryLoop
```

**扩展点选择规则**（亦见 §5）：
- 需要模型主动调用 → **tool**
- 用户在 REPL 输入 `/xxx` → **command**
- 文档/可学习能力 → **skill**（`src/skills/bundled/`）
- 跨工具/会话的能力增强 → **plugin**
- 外部 stdio/SSE 工具协议 → **MCP server**

---

## 4. 状态边界

| 层 | 模块 | 适合放什么 | 不要放什么 |
|---|---|---|---|
| **运行时单例** | `src/bootstrap/state.ts` | 跨 React 生命周期的会话/成本/用量/cron/scroll 等 | UI 视觉状态、组件局部状态 |
| **React/Ink 共享** | `src/state/AppStateStore.ts` | mcp/plugins/agentDefinitions/notifications/elicitation 等 UI 依赖 | 进程级单例、跨进程数据 |
| **组件局部** | `useState` 内部 | 仅当前组件用到的瞬态 | 任何被多个组件读取的状态 |
| **会话持久化** | `services/sessionTranscript/`、`services/filePersistence/` | 落盘的会话/历史/配置 | 进程内瞬态 |

**红线**：`bootstrap/state.ts` 是导入 DAG 叶子，不允许再依赖 `services/` / `state/`；反向依赖由调用方决定。

---

## 5. 扩展点选择速查

| 场景 | 选 | 注意 |
|---|---|---|
| LLM 主动调用某能力 | `src/tools/<X>.ts(x)` | 三文件模式：`.ts(x)` + `UI.tsx` + `prompt.ts` |
| 用户在 REPL 输入 `/xxx` | `src/commands/<x>/` | 一目录一命令，可复用 services |
| 静态指导/上下文知识 | `src/skills/bundled/<x>.ts` | 通过 `services/skillSearch/` 召回 |
| 进程级能力增强 | `services/plugins/` | 在 root.ts 装配阶段载入 |
| 外部 stdio/SSE 服务 | 配 `mcpConfig` + `services/mcp/` | 不入仓库代码 |
| 后台异步任务 | `services/background/` 或 `services/jobs/` | 与 `daemon/` 区分（后者是常驻进程） |
| 多 worker 编排 | `coordinator/` + `AgentTool` | 仅 COORDINATOR_MODE flag 下生效 |
| 远程会话 | `bridge/` | 通过 BRIDGE_MODE flag 走 launchRepl 远程分支 |

---

## 6. 关键大文件治理（截至 2026-05）

| 文件 | 行数 | 状态 | 计划 |
|---|---|---|---|
| `screens/REPL.tsx` | 6194 | 待拆 | Phase 3：抽 IDE / MCP / Remote / Transcript / Voice / Notifications container |
| `cli/commands/root.ts` | 3637 | 进行中 | Phase 1：按 7 个 launchRepl 出口拆 `cli/assembly/{interactive,resume,directConnect,ssh,coordinatorRemote,bridge,...}.ts` |
| `bootstrap/state.ts` | 1674 | 待拆 | Phase 2：按域拆 `bootstrap/state/{session,cost,duration,tokens,scroll,model,apiTracking}.ts`，原文件作为 barrel |
| `query.ts` | 1655 | 待拆 | Phase 4：按 stage 拆 `query/stages/{promptAssembly,modelRequest,streamHandling,toolExecution,recovery,continuation}.ts` |
| `QueryEngine.ts` | 1273 | 暂稳 | 等 query.ts 拆分后回头评估 |

---

## 7. 不该再触碰的"历史地雷"

- `utils/sessionStorage.ts`（5000 行）— 历史包袱，新代码不要往里塞
- `src/` 根目录的 `Tool.ts` / `Task.ts` / `tools.ts` / `query.ts` — 历史结构，**禁止新增**根级 `.ts`/`.tsx`
- `utils/` 任何新业务代码 — 移到 `services/<domain>/` 或 `src/<domain>/`

详见 AGENTS.md 第 12 条。
