# Ultracode 三方对比与集成可行性分析

> 基于 Claude Code CLI 二进制（v2.x mid-2026 build，205MB esbuild bundle）逆向、Oh My OpenCode v4.5.x 的 Ultrawork 设计文档、以及 zy-code 当前代码（fork 自 Claude Code）。
>
> 本文只做分析与可行性评估，不动代码。

---

## 0. 一句话结论

**Claude Code 的 `ultracode` 与 OmO 的 `ultrawork` 同名不同物**：
- `ultrawork` = 关键词触发 Hook + 200+ 行 Prompt 注入，让 LLM 在系统指令约束下自编排（"prompt 即编排器"）。
- `ultracode` = effort 档位（`xhigh + dynamic-workflow orchestration`），背后是一个**内置 JS DSL 工具 `Workflow`**，由 system-reminder 引导 LLM 默认调用它（"DSL 即编排器，prompt 是说明书"）。

zy-code 已 fork 了 `WorkflowTool` 的**空壳**（`src/tools/WorkflowTool/WorkflowTool.ts` 共 50 行，`call()` 返回 `{}`，prompt 仅 `"Workflow tool"`），effort 档位也**缺失** `xhigh`/`ultracode`。这意味着集成路径有现成接入点，但需要补齐运行时与 prompt 资产。

---

## 1. Ultracode 真相：从二进制逆向

### 1.1 effort 档位定义

`/effort` 命令的 usage 字面量（位于 claude.exe 偏移 116147681 附近）：

```
Usage: /effort [low|medium|high|xhigh|max|ultracode|auto]

Effort levels:
- low:    Quick, straightforward implementation
- medium: Balanced approach with standard testing
- high:   Comprehensive implementation with extensive testing
- xhigh:  Extended reasoning with thorough analysis
- max:    Maximum capability with deepest reasoning
- ultracode: xhigh + dynamic workflow orchestration (this session only)
- auto:   Use the default effort level for your model
```

设置项描述（偏移 80941291 附近）：

> **Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration.**
> Session-scoped — typically provided via `--settings` or the `apply_flag_settings` control request; interactive toggles never persist it. Requires workflows to be enabled and an xhigh-capable model.

错误提示（偏移 116159680）：

> **Ultracode needs dynamic workflows enabled (see /config) and an xhigh-capable model.**
> Valid options are: low, medium, high, xhigh, max, auto

### 1.2 启用条件（双门）

1. settings 里 `workflows: enabled`（这是个 boolean 配置，不开则连 Workflow 工具都注册不了）
2. 当前模型是 xhigh-capable（Opus 4.6 / 4.7 max 这类）
3. effort 设为 `ultracode`（仅当前会话；环境变量 `CLAUDE_CODE_EFFORT_LEVEL` 可覆盖）

可见 ultracode 是**配置层**的入口标志，不是关键词。

### 1.3 system-reminder 注入

逆向到三类 reminder（偏移 203718616 附近，命名规则 `<key>:()=>F3([L6({content:"...",isMeta:!0})])`）：

| key | reminderType | 文案（原文） |
|---|---|---|
| `ultra_effort_enter` | `full` | `Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.` |
| `ultra_effort_enter` | `light` | `Ultracode is still on — use the Workflow tool; see its Ultracode section.` |
| `ultra_effort_exit` | — | `Ultracode is off — the Workflow tool's standard opt-in rule applies again.` |
| `workflow_keyword_request` | — | `The user included the keyword "workflow" or "workflows", which means you should use the Workflow tool to fulfill their request.` |

注：是 `system-reminder`（`isMeta:!0`），**不是 prompt prepend**——通过会话标记由消息组装层注入，与用户输入分离。

### 1.4 Workflow 工具：真正的核心

ultracode 的实质是"会话级默认调用 Workflow 工具"。Workflow 是 Claude Code 内置的脚本式编排 DSL，逆向其完整 prompt（偏移 202105000 起，长度约 15KB）后核心要点如下。

---

## 2. Workflow 工具机制详解（来自二进制 prompt 原文）

### 2.1 输入与产物

| 字段 | 说明 |
|---|---|
| `script` | 内联 JS 字符串（推荐，自动持久化到 session 目录） |
| `scriptPath` | 已存在的脚本文件路径（迭代时使用） |
| `args` | 任意 JSON 值，作为脚本里 `args` 全局可访问；**禁止字符串化数组/对象** |

工具**异步立即返回 task ID**，完成后通过 `<task-notification>` 通知。`/workflows` 命令查看实时进度。

### 2.2 脚本 meta 头（强约束）

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',  // 权限对话框显示
  whenToUse: '...',                                    // 可选，列表显示
  phases: [                                            // 可选
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
```

**`meta` 必须是 PURE LITERAL**——不允许变量、函数调用、spread、模板插值。`phases[].title` 与 `phase()` 调用按字符串严格匹配。`phases[].model` 可指定该 phase 的模型 override。

### 2.3 脚本 body API

| API | 签名 | 语义 |
|---|---|---|
| `agent(prompt, opts?)` | `Promise<any>` | 派生子 agent。`opts.schema` (JSON Schema) 强制 StructuredOutput 工具调用并校验返回；`opts.model` override 模型；`opts.isolation: 'worktree'` 在独立 git worktree 跑（200-500ms 启动开销）；`opts.agentType` 复用 Agent tool 注册表（如 `'Explore'` / `'code-reviewer'`）；`opts.label`/`opts.phase` 控制进度显示。用户中途跳过返回 `null`。 |
| `pipeline(items, ...stages)` | `Promise<any[]>` | **NO barrier 多阶段**。每个 item 独立流过所有 stage，A 在 stage3 时 B 可能还在 stage1。Stage 抛错 → 该 item 变 `null`，跳过后续 stage。**默认推荐选这个**。 |
| `parallel(thunks)` | `Promise<any[]>` | **BARRIER 并发**。等所有完成；失败 thunk → `null`（call 自身不 reject）。仅在"必须拿到全部结果再下一步"时用。 |
| `phase(title)` | `void` | 开新 phase，后续 `agent()` 默认归入此 phase。 |
| `log(msg)` | `void` | 进度行（叙事）。 |
| `args` | `any` | 调用方传入，verbatim。 |
| `budget` | `{total, spent(), remaining()}` | 当前 turn token 硬预算（来自用户 `+500k` 风格指令）。`total` 为 null 表示未设；`remaining()` 跨主循环 + 所有 workflow 共享池。**HARD ceiling**：达到上限后再调 `agent()` 抛错。 |
| `workflow(name|{scriptPath}, args?)` | `Promise<any>` | 内联调用其他 workflow（仅一层嵌套，再嵌套抛错）。共享并发上限、agent 计数、abort signal、token budget。 |

### 2.4 沙箱限制

- **纯 JS**，不是 TS（类型注解、interface、泛型解析失败）。
- 异步上下文，可直接 `await`。
- 标准 JS built-ins 可用，**禁用** `Date.now()` / `Math.random()` / 无参 `new Date()`（破坏 resume 语义）。需要时间戳从 `args` 注入；需要随机性按 index 变化 prompt/label。
- **无文件系统、无 Node.js API**。
- 脚本字节数有上限（变量 `bC`，未具体提取数值，但加载时校验）。

### 2.5 并发与规模

- 单 workflow 并发上限：`min(16, cpu_cores - 2)`。
- 单 workflow 总 agent 数上限：`1000`（runaway 防爆）。
- 超出并发的调用排队，不阻塞调用方。

### 2.6 触发门控（重点）

工具 prompt 明确写：**ONLY call this tool when the user has explicitly opted into multi-agent orchestration.** 五种 opt-in 情况之一才允许：

1. 用户消息含 "workflow" / "workflows" 关键词（会有 system-reminder 确认）。
2. Ultracode 开启（system-reminder 确认）。
3. 用户原话明确要求多 agent 编排（"run a workflow" / "fan out agents" / "orchestrate this with subagents"）——必须是用户原话，**任务"看起来适合 workflow"不算**。
4. 用户调用的 skill / slash command 内部要求调用 Workflow。
5. 用户要求运行某个 named / saved workflow。

否则只能用 Agent tool 跑单个 subagent，或描述方案 + 询问用户。

**Ultracode 状态下规则反转**：opt-in 永久成立，每个 substantive task 默认作为 workflow 跑，"token cost is not a constraint"；只有"对话 / 平凡机械编辑"可 solo。

### 2.7 五种 Common patterns（prompt 内置）

| 模式 | 流程 |
|---|---|
| **Understand** | 并行 readers over relevant subsystems → structured map |
| **Design**     | judge panel of N independent approaches → scored synthesis |
| **Review**     | dimensions → find → adversarially verify |
| **Research**   | multi-modal sweep → deep-read → synthesize |
| **Migrate**    | discover sites → transform each (worktree isolation) → verify |

Prompt 给出"DEFAULT TO pipeline()"的明确指令，并列举不该用 barrier 的三种伪需求（仅为 flatten/map/filter、纯阶段美感、代码整洁度）。

### 2.8 加载与发现

- `/workflows`（`local-jsx`）：`Browse dynamic workflow history (running and completed)`。
- workflow 来源四档（resolveWorkflow / getAllWorkflows）：
  1. **Built-in**（`createWorkflow` 注册）
  2. **userSettings**：`<userConfigDir>/workflows/*.js`
  3. **projectSettings**：项目目录 `workflows/*.js`
  4. **Plugins**：`pluginManifest.workflowsPath` / `workflowsPaths`
- 文件级校验：`.js` only、字节数上限、`meta` 解析失败 skip。

### 2.9 后台 task 模型

逆向到的状态枚举：`running` / `done` / `failed` / `pending` / `needs_input`。Workflow 与以下背景任务并列于同一 BackgroundTasks 维度：

```
1 remote dynamic workflow / remote dynamic workflows
1 background dynamic workflow / background dynamic workflows
1 cloud session / cloud sessions
1 MCP task / MCP tasks
dreaming / background / task / tasks
```

Workflow 与 ultraplan / dream / MCP background 共享 task framework，UI pill / `/workflows` 列表共用渲染。

---

## 3. Ultracode vs Ultrawork 本质对比

| 维度 | OmO Ultrawork | Claude Code Ultracode |
|---|---|---|
| **形态** | 关键词 `ulw` / `ultrawork` 触发 Hook，prompt prepend 200+ 行 Manifesto | effort 档位 `ultracode` + system-reminder 引导默认调用内置 Workflow 工具 |
| **激活粒度** | 单条消息（一字激活） | 会话级（settings/control_request，不持久） |
| **编排引擎** | LLM 自身（prompt 强制） | LLM 写 JS 脚本，Workflow runtime 真正执行 |
| **Prompt 内容** | 角色 + 行为约束 + 零容忍条款 + Boulder 循环 | DSL 使用文档 + opt-in 门控 + Common patterns |
| **子 Agent 池** | 11 固定角色（Sisyphus/Hephaestus/Prometheus/Oracle/...） + Category 路由 | `agent()` 动态调用，opts 控制 model / schema / isolation / agentType（复用 Agent registry） |
| **阶段建模** | 隐式四段（探索→规划→执行→验证） | 显式 `phase(title)`，`pipeline()` / `parallel()` 控制流 |
| **结构化输出** | 无原生支持 | `schema: JSONSchema` 强制 StructuredOutput |
| **隔离** | tmux team mode（最多 8 成员） | git worktree（per-agent，自动清理） |
| **Hashline 编辑** | 有（哈希锚定行编辑） | 无（依赖 worktree 物理隔离） |
| **强制验证** | Hook + prompt 零容忍 + Boulder loop | "adversarially verify" 模式 + Review pattern + 并发批判 panel |
| **Token 控制** | 无显式预算 | `budget` 全局对象，硬 ceiling，跨 workflow 共享 |
| **持久化** | — | scriptPath 自动写 session 目录，可 Edit 后 `{scriptPath}` 重调 |
| **可发现性** | Skill 系统 | `/workflows` 列表，user/project/plugin 三档 workflow 目录 |
| **触发门槛** | `ulw` 一字激活（极低） | 五种 opt-in（极严，防 token 暴炸） |
| **并发上限** | 8 团队成员（Team Mode） | `min(16, cpu-2)` per workflow，1000 agent 总数 |
| **失败语义** | Boulder 循环强制继续 | thunk/agent 失败 → null（不传染），调用方 `.filter(Boolean)` |
| **嵌套** | 主 → 子 Agent → 子 Agent | 仅一层嵌套（防递归） |

### 三个最重要的差异

1. **prompt 角色不同**。Ultrawork 的 200 行是"行为律法"（不许 mock、不许 60% 完成就停、不许 AI 风格注释）。Ultracode 的 prompt 是"DSL 手册 + 触发门控"——它不框 LLM 的行为，它教 LLM 用工具。这是工程化与文学化的分野。

2. **结构化输出 + worktree 隔离是 OmO 没有的工程能力**。`schema` 让 review/judge/audit 任务真正可机器消费；worktree 让并行写文件不靠 hash 协议靠物理隔离。这两点是 Ultracode 的硬实力，Ultrawork 靠 prompt 是补不上的。

3. **触发哲学相反**。Ultrawork 一字激活、低阻力；Ultracode 严格 opt-in、防滥用。背后是对 token 成本的不同假设（OmO 假设用户已选好套餐；Anthropic 直面计费）。

---

## 4. zy-code 现状盘点

### 4.1 已有但是 stub

[`src/tools/WorkflowTool/WorkflowTool.ts`](file:///Users/zy979/IdeaProjects/zy-code/src/tools/WorkflowTool/WorkflowTool.ts)：

```ts
export const WorkflowTool: Tool = {
  name: 'workflow',
  inputSchema: z.object({}).passthrough(),  // 接受任意参数
  async call() { return { data: {} } },     // 不做任何事
  async description() { return 'Workflow tool' },
  // ...
  prompt() { return Promise.resolve('Workflow tool') },  // 占位
}
```

同目录还有空壳：`WorkflowPermissionRequest.ts`（3 行）、`createWorkflowCommand.ts`（3 行）、`constants.ts`（1 行）。

### 4.2 已有的关联资产

- [`src/services/ultraplan/keyword.ts`](file:///Users/zy979/IdeaProjects/zy-code/src/services/ultraplan/keyword.ts)：关键词检测器（含代码块/路径/单引号/`/` 命令过滤）已实现得很完整，可直接复用做 `workflow` / `workflows` 关键词检测。
- [`src/commands/ultraplan.tsx`](file:///Users/zy979/IdeaProjects/zy-code/src/commands/ultraplan.tsx)：远程 task + ExitPlanMode polling 框架完整。后台 task 状态机、UI pill、archive 等基础设施可复用。
- [`src/tools/AgentTool`](file:///Users/zy979/IdeaProjects/zy-code/src/tools/AgentTool)（推断存在）：AGENTS.md 提到 `coordinator/` 与 `AgentTool` 调度多 worker，可作为 `agent()` 的底层。
- `src/commands/effort/`：effort 命令完整，但档位**只有** `minimal/low/medium/high/max/auto`，**缺 `xhigh` 和 `ultracode`**。
- `src/tools/registry.ts`：工具注册中心。

### 4.3 缺失项（按集成必要性排序）

| 缺失项 | 用途 | 难度 |
|---|---|---|
| Workflow runtime（脚本沙箱 + agent/pipeline/parallel/phase/log） | 工具核心 | **高** |
| Workflow tool 完整 prompt（约 15KB DSL 手册） | LLM 知道怎么用 | 低（已逆向） |
| `xhigh` + `ultracode` effort 档位 | 入口配置 | 低 |
| system-reminder：ultra_effort_enter / exit / workflow_keyword_request | LLM 知道何时用 | 中（需接入消息组装层） |
| `workflow` / `workflows` 关键词检测 | 触发条件 1 | 低（仿照 ultraplan/keyword.ts） |
| `/workflows` slash 命令（list + detail） | 可发现性 | 中 |
| Workflow 加载器（user/project/plugin 三档 + meta 解析） | 持久化 workflow | 中 |
| StructuredOutput 工具 + JSONSchema 校验 | `agent({schema})` 结构化输出 | 中 |
| worktree isolation 接入（git worktree per-agent） | `isolation: 'worktree'` | 中 |
| budget 跨 turn token 跟踪 | `budget.spent()/remaining()` 硬 ceiling | 中 |
| BackgroundTasks UI 适配（dynamic-workflow pill / detail） | 用户可见 | 中（已有 ultraplan 模板） |

---

## 5. 集成可行性路线图（不实现，仅评估）

按"最小可见价值 → 完整对齐"顺序，分四阶段。每阶段独立可发布。

### 阶段 A：纯静态资产移植（约 1 人日）

> 目的：在不动 runtime 的前提下把 Claude Code 的"opt-in 礼仪"装进 zy-code，让现有占位 `WorkflowTool` 至少有正确的 prompt 与触发提示。LLM 调用它仍会失败（runtime 是 stub），但用户能看到正确的行为引导。

- 把第 2 节逆向出的 Workflow 完整 prompt 写入 `src/tools/WorkflowTool/prompt.ts`（拆掉占位字符串）。
- 新增 `src/services/ultracode/keyword.ts`，复用 `ultraplan/keyword.ts` 模式检测 `workflow`/`workflows`。
- 在消息组装层（`src/utils/messages/` 或 `src/messages/`）注入三类 system-reminder：`ultra_effort_enter` / `ultra_effort_exit` / `workflow_keyword_request`。
- effort 档位增加 `xhigh` 与 `ultracode`，`/effort` 命令更新 usage 文案。
- **风险**：Workflow runtime 没实现时 LLM 调用工具会得到空对象，需要在 stub `call()` 里返回明确错误（"Workflow runtime not yet enabled in zy-code"），避免 LLM 误以为成功。

**可见价值**：用户切换到 `ultracode` effort 时能看到完整 system-reminder 引导，了解 Workflow 工具的预期形态——为后续阶段铺垫认知。

### 阶段 B：本地 Workflow runtime MVP（约 5-7 人日）

> 目的：让 `WorkflowTool.call()` 真的能跑 JS 脚本并 fan-out。

- 脚本沙箱：用 `vm.Script`（Node 内置）+ 受限 globals（屏蔽 `Date.now`/`Math.random`/`new Date()`/`fs`）。
- `meta` 解析：用 `acorn` 或类似 AST 工具解析 `export const meta = {...}` literal，校验 PURE LITERAL 约束。
- `agent()` 实现：调用现有 AgentTool / `coordinator/`（zy-code 已有 `Task.ts` + `tasks/LocalAgent`），把 prompt + opts 转 LocalAgentTask。返回值由 LocalAgentTask 的最终 text 提供。
- `parallel()` / `pipeline()`：纯 Promise 编排，并发上限 `min(16, cpu-2)`。
- `phase()` / `log()`：进度事件流，复用 zy-code 的 BackgroundTasks 框架渲染。
- `budget`：接入现有 `cost-tracker.ts` / `costHook.ts`。
- 不实现：`schema` / `isolation: 'worktree'` / `workflow()` 嵌套（留给阶段 C/D）。
- 脚本持久化：写入 session 目录 `<sessionDir>/workflows/<name>-<ts>.js`。
- **风险**：
  - 沙箱逃逸（用户如果通过 plugin workflow 投递恶意脚本）。需要明确：built-in / projectSettings 视为可信，user/plugin 走权限对话框（仿照 ExitPlanMode）。
  - LocalAgentTask 的取消/中断语义需要打通到 `parallel`/`pipeline` 的 abort signal。

**可见价值**：用户可以手写 `workflow.js` 跑 review/research 等 Common patterns；ultracode effort 真正能用。

### 阶段 C：结构化输出 + worktree 隔离（约 3-5 人日）

> 目的：解锁 review/judge/audit 类高质量任务。

- `StructuredOutput` 工具：注册一个不做副作用的工具，输入即 schema 校验，校验失败让模型重试（zy-code 的 toolUseLoop 已有 retry 机制）。
- `agent({schema})`：把 schema 注入子 agent system prompt 末尾（仿 Claude prompt 里 "Do your work, then call StructuredOutput with your answer."），将子 agent 的 toolChoice 锁到该工具。
- `agent({isolation: 'worktree'})`：用 `git worktree add` 创建临时 worktree，子 agent cwd 指向它；agent 结束后若无修改则 `worktree remove`，否则保留供主 agent 合并。zy-code 已有 `worktrees/` 目录基础。
- `agent({agentType})`：复用 zy-code 的 agent registry（`src/cli/handlers/agents`）。

**可见价值**：可以跑 prompt 里的 Review pattern 范例（dimensions → find → adversarially verify with schema）。

### 阶段 D：可发现性 + 持久化 + 嵌套（约 3 人日）

- `/workflows` slash 命令：list + detail view，复用 ultraplan 的 RemoteSessionDetailDialog 模式。
- workflow 加载器：扫描 `~/.zy/workflows/*.js`、`<project>/workflows/*.js`、plugin manifest 的 `workflowsPath`。
- `args` 参数化：从工具 input 直接透传（zod 已用 `passthrough()`，OK）。
- `workflow(nameOrRef, args)`：单层嵌套（用计数器防递归）。
- BackgroundTasks 维度新增 `dynamic workflow`，区分 `running/done/failed/pending/needs_input`。

**可见价值**：复用 / 分享 workflow 脚本；用户可像 skill 一样收藏常用编排。

### 不建议做的（与 ultracode 设计哲学冲突）

- **OmO 风格的 `ulw` 一字激活**：与 Workflow 工具的"严格 opt-in"哲学正面冲突。如果想要"轻触发"，应单独做一个 `ultrawork` 关键词，prompt prepend 一份"Ultrawork Manifesto"——但**那是另一个特性**，不是 ultracode。建议两条路线分开。
- **Hashline 哈希锚定**：worktree 隔离已经覆盖并行写冲突场景，且 zy-code 现有 Edit/Read 工具未实现行级哈希锚定，引入会触及大量 tool 改造，ROI 低。

---

## 6. ROI 与优先级建议

| 项目 | 实现难度 | 用户可见价值 | ROI | 建议 |
|---|---|---|---|---|
| 阶段 A：prompt + reminder + effort 档位 | 低 | 中（认知铺垫） | 高 | **优先做**，1 人日内可发布 |
| 阶段 B：runtime MVP | 高 | 高（功能可用） | 中-高 | 在 A 之后做，需要专门排期 |
| 阶段 C：schema + worktree | 中 | 高（核心差异化能力） | 高 | 在 B 之后立即做，否则 B 的价值打折 |
| 阶段 D：/workflows + 加载器 | 中 | 中 | 中 | 看用户反馈再做 |
| OmO Boulder 循环 / 零容忍条款 | 中 | 低（ultracode 本身有 adversarial verify） | 低 | 不建议做 |
| OmO Hashline | 高 | 低（worktree 替代） | 极低 | 不建议做 |
| OmO Category 系统 | 中 | 低（zy-code 已有 model selector + agent registry） | 低 | 不建议做 |

---

## 7. 关键洞见

1. **Ultracode 是配置层 + DSL 工具**，不是 prompt 注入。把它当 prompt 抄过来是错的——核心资产是 Workflow runtime。
2. **Workflow 的 prompt 写得克制**——80% 是 DSL 手册和反例（不该用 barrier 的三种伪需求、不该调用 Workflow 的所有非 opt-in 场景），20% 是行为引导。这与 OmO 200 行行为律法的写法形成鲜明对比。zy-code 在做 prompt 设计时可参考这种"教工具用法 > 框行为"的方向。
3. **schema 强制结构化输出 + worktree 物理隔离** 是 ultracode 的两个工程硬实力，OmO 设计文档里完全没有等价物。这两点是集成的真正回报来源。
4. **触发门控比触发本身更重要**。Workflow 工具有 5 种 opt-in，每种都有 system-reminder 配套——这避免了 LLM 滥用 token。zy-code 集成时应原样保留这套门控，不要受 OmO 一字激活影响。
5. **zy-code 已 fork 了 stub，路径短**。不需要新建模块，只需要把 `WorkflowTool.ts` 从 50 行 stub 长成完整 runtime，外加 4 个配套组件（keyword、reminder、effort 档、loader）。

---

## 8. 参考来源

- Claude Code CLI binary：`/Users/zy979/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`（205MB，esbuild bundle，mid-2026 build）
- 关键 byte offsets：
  - `116147681`：`/effort` usage 含 `ultracode` 档位
  - `116159680`：`Ultracode needs dynamic workflows enabled` 错误提示
  - `80941291`：effort 档位描述
  - `203718616`：`ultra_effort_enter` / `ultra_effort_exit` / `workflow_keyword_request` system-reminder 文案
  - `202105000-202125000`：Workflow 工具完整 prompt（含 DSL API 文档、Common patterns、触发门控、并发约束、barrier 反例）
  - `205896139`：`/workflows` slash 命令注册（`local-jsx`，`Browse dynamic workflow history`）
  - `98941322`：BackgroundTasks 维度文案（`remote/background dynamic workflow(s)`）
- Oh My OpenCode v4.5.x Ultrawork 设计文档：`/Users/zy979/Desktop/future_plan/Oh-My-OpenCode-Ultrawork-设计分析.md`
- zy-code 现状：[`src/tools/WorkflowTool/`](file:///Users/zy979/IdeaProjects/zy-code/src/tools/WorkflowTool)、[`src/services/ultraplan/`](file:///Users/zy979/IdeaProjects/zy-code/src/services/ultraplan)、[`src/commands/effort/`](file:///Users/zy979/IdeaProjects/zy-code/src/commands/effort)
- 提取技能：`extract-claude-internal`（位于 `~/.qoder/skills/extract-claude-internal/`）
