# 项目架构待改进点

> 最后更新：2026-06-04
> 基于当前仓库代码结构（`query.ts` 1745 行、`root.ts` 3409 行）实测分析。

## 已完成的改进（归档记录）

以下改进项已在 2026-05 ~ 06 完成：

- ~~顶层启动 root.ts 拆分~~ → `cli/assembly/` 已抽出 6 个模式模块（directConnect/interactive/remote/resumed/ssh + types）
- ~~REPL.tsx 过重~~ → 6200 行已拆到 1338 行 + `screens/repl/` 26 个子模块
- ~~全局状态 state.ts 单体~~ → 已按域拆为 `bootstrap/state/{_core,session,cost,duration,model,scroll,tokens,apiTracking}.ts`
- ~~缺少架构导航图~~ → `docs/architecture-map.md` 已建立
- ~~文档与代码漂移~~ → AGENTS.md / architecture.md 已同步更新
- ~~query.ts 部分拆分~~ → 已抽出 `query/{config,deps,stopHooks,tokenBudget,transitions}.ts`（共 673 行）
- ~~query.ts 继续拆分~~ → 2026-06 新增 `query/{preprocess,compaction,toolExecution,attachments,recovery}.ts`，query.ts 从 1745→1332 行（-24%），常开 feature flag 门控已清理
- ~~utils/messages/api.ts 拆分~~ → 2026-06 拆为 `apiNormalize.ts`(981) + `attachmentApi.ts`(1556) + `systemReminder.ts`(29) + `api.ts`(20 行 barrel reexport)

---

## 1. query.ts 继续拆分为 stages

### 现状（1745 行，已拆出 673 行到子模块）

`query.ts` 目前只导出 2 个函数（`query` + `queryLoop`），`queryLoop` 是一个 1500 行的 `while(true)` 生成器函数。已拆出的子模块覆盖了辅助性职责：

| 已拆出模块 | 行数 | 职责 |
|---|---|---|
| `stopHooks.ts` | 465 | stop hook 执行与熔断 |
| `tokenBudget.ts` | 93 | +500k 预算续接 |
| `deps.ts` | 54 | 可注入依赖（测试用） |
| `config.ts` | 39 | 一次性 env/statsig 快照 |
| `transitions.ts` | 22 | 类型定义 |

**但主循环体仍然是单一函数**，内部逻辑按阶段可以识别出以下阶段：

```
queryLoop 内部阶段分析（按代码行号）：

295-329   [阶段 1] 初始化：解构 state、skillPrefetch 启动
330-398   [阶段 2] 消息预处理：toolResultBudget → microcompact → contextCollapse
400-512   [阶段 3] Autocompact 执行与结果处理
514-601   [阶段 4] 阻塞检查与准备
603-893   [阶段 5] 模型调用（streaming loop）+ fallback 重试
894-938   [阶段 6] 错误处理
940-996   [阶段 7] PostSampling hooks + abort 处理 + tool summary 消费
998-1308  [阶段 8] 无 tool_use 时的恢复与终结（PTL/MOT/stop hooks/budget）
1310-1470 [阶段 9] 工具执行 + PostToolBatch + tool summary 生成
1472-1536 [阶段 10] 工具中 abort 处理
1538-1745 [阶段 11] 附件注入 + 队列消费 + turnCount 递增 + 继续
```

### 问题

1. **认知负荷**：开发者修改任何一个阶段都要扫描 1500 行找到正确位置
2. **测试困难**：只能端到端测试整个循环，无法单独测试某个阶段
3. **Feature flag 散落**：18 处 `feature()` 调用分散在循环各处，理解哪些代码在哪个构建变体下执行需要全文对照

### 方案：按阶段抽取为独立函数（不改变控制流）

**关键决策**：不把 while 循环拆成 pipeline/middleware 模式（那样改动太大且会增加理解成本）。只做"函数提取"——把循环体内的连续代码段提取为命名函数，保持生成器的控制流不变。

```
src/query/
├── config.ts             (39)  — 已有
├── deps.ts               (54)  — 已有
├── stopHooks.ts          (465) — 已有
├── tokenBudget.ts        (93)  — 已有
├── transitions.ts        (22)  — 已有
├── preprocess.ts         (新)  — 阶段 2: toolResultBudget + microcompact + collapse
├── compaction.ts         (新)  — 阶段 3: autocompact 执行 + 结果处理 + taskBudget 携带
├── modelCall.ts          (新)  — 阶段 5: streaming loop + fallback + withheld 处理
├── recovery.ts           (新)  — 阶段 8: PTL/MOT 恢复逻辑（collapse drain + reactive compact + escalate）
├── toolExecution.ts      (新)  — 阶段 9-10: tool 执行 + PostToolBatch + abort
└── attachments.ts        (新)  — 阶段 11: 附件注入 + queue 消费 + memory/skill prefetch 消费
```

已提取的模块及签名参见 `src/query/{preprocess,compaction,toolExecution,attachments,recovery}.ts`。

queryLoop 现在按"预处理 → 压缩 → 阻塞检查 → 模型调用 → 恢复 → 工具执行 → 附件"的阶段调用各子模块，主体约 1332 行。

### 实施步骤（建议分 3 个 PR）

| PR | 内容 | 风险 |
|---|---|---|
| PR-1 | 提取 `preprocess.ts` + `compaction.ts` | 低（纯提取，无逻辑变更） |
| PR-2 | 提取 `modelCall.ts` + `recovery.ts` | 中（生成器嵌套需要正确传递 yield） |
| PR-3 | 提取 `toolExecution.ts` + `attachments.ts` | 低（尾部代码，依赖少） |

### 优先级

**高** — 这是日常开发中接触最频繁的文件，每次改 compact/recovery/tool 逻辑都要在 1500 行中定位。

---

## 2. root.ts 继续瘦身

### 现状（3409 行，27 处 feature() 调用）

`root.ts` 是整个应用的顶层装配文件。`cli/assembly/` 已抽出 6 个模式模块，但 root.ts 内部仍然集中了：

1. **工具注册与装载**（~200 行）：`getTools()` 调用 + 条件性工具追加（WebBrowser/ComputerUse/Voice 等）
2. **MCP/插件/技能初始化**（~150 行）：`initBuiltinPlugins` + `loadExternalTools` + `initBundledSkills` + MCP 服务器启动
3. **Kairos/Swarm 团队能力装载**（~250 行）：大量 `feature('KAIROS')` 门控的 assistant/proactive/brief 模块加载
4. **会话恢复与状态初始化**（~300 行）：`loadConversationForResume` + 诊断 + quota 检查
5. **REPL 渲染参数构建**（~400 行）：组装传给 `<REPL>` 的 props

### 方案：按职责继续抽取 assembly 模块

```
src/cli/assembly/
├── index.ts              — 已有（入口调度）
├── directConnectMode.ts  — 已有
├── interactiveMode.ts    — 已有
├── remoteSession.ts      — 已有
├── resumedSession.ts     — 已有
├── sshMode.ts            — 已有
├── types.ts              — 已有
├── toolRegistry.ts       (新) — 工具注册 + 条件追加逻辑
├── pluginSetup.ts        (新) — MCP/插件/技能初始化
├── teamCapabilities.ts   (新) — Kairos/Swarm/Brief/Proactive 模块加载
└── sessionBootstrap.ts   (新) — 会话恢复 + 诊断 + quota
```

**目标**：root.ts 从 3409 行降到 ~2000 行，职责收缩为"读参数 → 调用各 assembly → 组装 REPL props → 渲染"。

### 实施步骤

| PR | 模块 | 预计抽出行数 |
|---|---|---|
| PR-1 | `toolRegistry.ts` | ~200 行 |
| PR-2 | `pluginSetup.ts` | ~150 行 |
| PR-3 | `teamCapabilities.ts` | ~250 行 |
| PR-4 | `sessionBootstrap.ts` | ~300 行 |

### 优先级

**中** — 不如 query.ts 频繁触碰，但新增 feature flag 时必然要碰这个文件。

---

## 3. Feature flag 治理

### 现状

- `query.ts`：18 处 `feature()` 调用（REACTIVE_COMPACT / CONTEXT_COLLAPSE / EXPERIMENTAL_SKILL_SEARCH / TEMPLATES / BG_SESSIONS / TOKEN_BUDGET / CACHED_MICROCOMPACT / CHICAGO_MCP）
- `root.ts`：27 处 `feature()` 调用（KAIROS / KAIROS_BRIEF / KAIROS_CHANNELS / CHICAGO_MCP / BG_SESSIONS / COORDINATOR_MODE / UDS_INBOX / BRIDGE_MODE / AGENT_MEMORY_SNAPSHOT / CCR_MIRROR / DIRECT_CONNECT / SSH_REMOTE / PROACTIVE / WEB_BROWSER_TOOL）
- 总共约 **14 个独立 feature flag** 影响这两个核心文件

### 方案

不做"收敛到统一注册表"这种大改造（因为 `feature()` 是 `bun:bundle` 编译时消除，收到运行时注册表会破坏 tree-shaking）。**改为文档化 + 矩阵测试**：

1. **建立 Feature Flag 矩阵文档**：`docs/feature-flag-matrix.md`
   - 每个 flag 列出：影响的文件、启用条件、功能描述、是否有对应测试
   - 标注哪些 flag 已经是"常开"状态（可以考虑移除门控）

2. **识别并清理已稳定的 flag**：
   - 如果某个 flag 在所有构建变体中都是开启的（生产 + 开源），其 `feature()` 门控可以直接移除
   - 预估：`REACTIVE_COMPACT`、`CONTEXT_COLLAPSE` 可能已经是常开状态

3. **为高频 flag 组合建立 smoke test**：
   - 至少覆盖：全开、全关、只开 compact 相关、只开 kairos 相关

### 优先级

**中偏低** — 当前 flag 数量虽多但还没到失控程度；清理常开 flag 的 ROI 最高。

---

## 4. 扩展点统一治理

### 现状

同时存在 5 套扩展机制：

| 扩展面 | 注册方式 | 运行时交互 | 文件位置 |
|---|---|---|---|
| Commands | `Command` 类型 + 动态 `import()` | slash 命令路由 | `src/commands/` |
| Tools | `Tool` 类型 + `getTools()` 注册 | 模型 tool_use | `src/tools/` |
| Plugins | marketplace + `pluginLoader` | 工具/技能/hook 注入 | `src/utils/plugins/` |
| Skills | frontmatter + `initBundledSkills` | `/skill` 触发 | `src/skills/` |
| MCP | `services/mcp/` client 管理 | 远程工具/资源 | `src/services/mcp/` |

### 问题分析

横切关注点（权限、日志、错误处理、超时）在各扩展面的实现方式：

| 关注点 | Commands | Tools | Plugins | Skills | MCP |
|---|---|---|---|---|---|
| 权限 | 无（用户主动触发） | `canUseTool` + PreToolUse hook | `permissions.deny` | 无 | `mcpServerApproval` |
| 日志/遥测 | 手动 logEvent | `toolHooks.ts` 自动 | plugin 诊断 | 手动 | MCP protocol |
| 超时 | 无 | `toolTimeout` 配置 | 无 | 无 | MCP timeout |
| 错误处理 | try/catch 各自 | `toolExecution.ts` | `pluginLoader` 异常隔离 | try/catch | MCP error protocol |

### 方案

**不做统一 registry**（各扩展面的生命周期差异太大，强统一反而增加复杂度）。改为：

1. **统一诊断视图**（低成本高收益）：
   - 新建 `src/services/diagnostics/extensionInventory.ts`
   - 导出 `getExtensionInventory(): ExtensionInventory` — 收集所有激活的 commands/tools/plugins/skills/mcp 的名称、来源、状态
   - 给 `/status` 命令的 Status tab 用，让用户能看到"当前加载了哪些扩展"

2. **统一错误边界模式**（中等成本）：
   - 提取 `src/utils/extensionBoundary.ts`，导出 `withExtensionBoundary<T>(name, fn): Promise<T | ExtensionError>`
   - 各扩展面的执行入口统一用这个包装，确保一致的错误格式和遥测

### 优先级

**低** — 当前各扩展面独立运作良好，用户没有强需求。诊断视图可以作为一个小 PR 单独做。

---

## 5. 服务层目录体量

### 现状

`src/services/` 有 **64 个子目录/文件**。按行数排序的 top 10：

```
compact/            ~4000 行（8 文件 + v2 子目录）
mcp/                ~3500 行（预估）
api/                ~3000 行（预估）
SessionMemory/      ~970 行
contextCollapse/    ~595 行
workflow/           大量文件
plugins/            大量文件
tools/              ~500 行
swarm/              ~400 行
model/              ~300 行
```

### 方案

**不做大规模 domain packing**（现有目录结构已经按领域分好了）。仅做：

1. **为 compact/ 建立内部 README**：compact 目录已经很大（autoCompact + reactiveCompact + microcompact + snip + collapse 联动 + v2），新开发者需要一个 5 行的内部导航
2. **考虑将 `services/contextCollapse/` 合并到 `services/compact/` 下**：这两个在 query.ts 中总是联动出现，逻辑上 collapse 是 compact 的一个零 LLM 层级

### 优先级

**低** — 目录结构本身不影响开发效率。

---

## 6. utils/messages/api.ts 拆分

### 现状（2718 行）

函数按职责可分为 4 组：

| 组 | 行范围 | 函数数 | 职责 |
|---|---|---|---|
| 消息规范化 | 172-1093 | ~8 | `reorderMessagesInUI` / `normalizeMessagesForAPI` / `filterUnresolvedToolUses` 等 |
| System reminder 工具 | 1094-1175 | 3 | `wrapInSystemReminder` 系列 |
| Plan/Auto mode 指令 | 1175-1485 | ~10 | `getPlanModeInstructions` / `getAutoModeInstructions` 系列 |
| Attachment → API 转换 | 1486-2718 | ~6 | `normalizeAttachmentForAPI`（1200+ 行的 switch 语句）+ `ensureToolResultPairing` |

### 方案

拆为 4 个文件：

```
src/utils/messages/
├── api.ts              → 缩小为仅导出 reexport（兼容旧 import 路径）
├── normalize.ts        (新) — 消息规范化（reorder/normalize/filter）
├── systemReminder.ts   (新) — system reminder 包装
├── modeInstructions.ts (新) — plan/auto mode 指令生成
└── attachmentApi.ts    (新) — attachment 到 API 消息转换
```

### 实施注意

- `api.ts` 保留为 barrel reexport，避免破坏项目中 200+ 处 import
- 每个新文件可以独立一个 PR

### 优先级

**低** — 该文件虽大但函数边界清晰，不常需要同时修改多组。

---

## 建议落地顺序

```
优先级排序（结合日常开发 pain point）：

1. [完成] query.ts 拆分 — preprocess+compaction+toolExecution+attachments+recovery（1745→1332 行）
2. [完成] Feature flag 清理 — 移除 REACTIVE_COMPACT/TOKEN_BUDGET/CONTEXT_COLLAPSE 常开门控
3. [完成] utils/messages/api.ts 拆分 — apiNormalize+attachmentApi+systemReminder（2718→20 行 barrel）
4. [中]  root.ts 瘦身 — 耦合度高（options:any 贯穿全文），需要先类型化 options 再拆分
5. [低]  扩展点诊断视图
6. [低]  服务层 compact/collapse 合并
```
