# 进程内子代理内存与生命周期治理方案

> 状态：提案  
> 优先级：P0  
> 适用范围：in-process subagent、persistent teammate、后台 task  
> 分析基线：Claude Code CLI 二进制（2026-07-11，249,485,472 bytes）与当前 zy-code 源码

## 1. 背景

当前项目在启动多个进程内子代理并连续创建多个 task 后，RSS 曾增长至 13.7 GB。
源码审计表明，主要问题不是传统意义上的定时器或事件监听器泄漏，而是生命周期和
内存所有权不匹配：一次性子代理完成工作后仍以 persistent teammate 的形式保持存活，
长期强引用完整消息历史、原始工具结果、运行上下文和缓存。

项目内已有注释记录过同类现象：单个并发 agent 的驻留成本约 125 MB，短时间创建
292 个 agent 时 RSS 曾达到 36.8 GB。13.7 GB 与约百个未 shutdown 的 resident agent
数量级一致。

本方案的目标不是简单裁剪 UI 消息，而是建立明确的生命周期边界、容量背压、历史
分层存储和可观测性，使内存消耗由“agent 数量 × 无界上下文”变为可配置、可预测的上限。

## 2. 分析边界与证据等级

### 2.1 Claude Code 二进制信息

本次检查的二进制为：

```text
D:\nvm\nvm4w\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe
size: 249,485,472 bytes
modified: 2026-07-11
```

该版本是 native executable/snapshot。稳定字符串仍可按字节偏移检索，但函数体附近包含
native section、压缩/快照数据和非连续文本，无法像旧版纯 esbuild JavaScript bundle 一样
可靠恢复完整变量名和源代码。

因此本文使用以下证据等级：

- **A：直接证据**：二进制内存在明确 ASCII 锚点及可复现字节偏移。
- **B：结构证据**：同一功能存在多个 start/stop、task、compact 等相关锚点，可确认机制存在。
- **C：机制推断**：根据锚点组合与 zy-code 对应实现推导，不声称是 CC 原始源码。
- **D：zy-code 源码证据**：可定位到当前仓库的具体实现。

### 2.2 禁止误读

本文中的“CC 等价伪代码”用于描述从二进制锚点推导出的机制，不是 Anthropic 源码逐字还原。
任何无法从 native snapshot 可靠恢复的 minified 名称、条件常量和对象字段均不会伪造成原始代码。

## 3. Claude Code 二进制提取结果

### 3.1 生命周期锚点

| 锚点 | 部分字节偏移 | 证据等级 | 含义 |
|---|---:|---|---|
| `SubagentStart` | `90265407`, `107473080`, `119379112`, `126773656` | A | 子代理有独立启动生命周期 |
| `SubagentStop` | `94026600`, `107473112`, `117862384`, `118706632` | A | 子代理有独立终止生命周期 |
| `task_notification` | `103328368`, `117234176`, `122696248`, `145367416` | A | task 完成与通知是独立机制 |
| `shutdown_request` | `112546488`, `121052248`, `200543400`, `213039176` | A | persistent agent/team 有显式 shutdown 协议 |
| `running agents` | `208720992`, `234410275`, `241880572` | A | 存在运行 agent 的集合或 UI/诊断逻辑 |
| `active agents` | `135770904`, `238273200` | A | 存在 active agent 概念 |
| `agent limit` | `145143337`, `239829945` | A | 存在 agent 容量限制相关逻辑/文案 |

这些锚点共同说明 CC 至少区分：

1. subagent 的 start/stop 生命周期；
2. task notification；
3. persistent agent 的 shutdown request；
4. running/active agent 集合及容量限制。

这不证明 CC 内部具体使用何种 class 或状态枚举，但可以确认“task 完成”和“agent 永久 idle”
不是唯一生命周期模型。

### 3.2 消息压缩锚点

| 锚点 | 部分字节偏移 | 证据等级 | 含义 |
|---|---:|---|---|
| `messagesToKeep` | `110369056`, `222016648`, `222016882`, `232380342` | A | 压缩流程显式选择保留消息 |
| `compactionControl` | `161851848`, `224818465`, `224819003` | A | 存在压缩控制对象或配置 |
| `Context too long` 相关片段 | `224818xxx` 附近 | B | 上下文过长会进入受控压缩/恢复流程 |

在 `compactionControl` 附近可恢复的可读字符串包括以下阶段性语义：

```text-extracted
1. ... TODO ...
2. Current State ...
3. Important Details ...
4. Next Steps ...
5. Context ...
```

同一区域能观察到 message、content、token、context、summary 等压缩相关字符串。由于函数体
处于 native snapshot 中，本文不把不可读的单字母符号强行解释为稳定 API。

### 3.3 从二进制结构得到的等价模型

以下代码是机制伪代码，不是 CC 原始源码：

```ts
type AgentKind = 'subagent' | 'persistent-agent'

async function executeAgent(agent: AgentRuntime): Promise<void> {
  emitHook('SubagentStart', agent.metadata)

  try {
    await runAssignedWork(agent)

    if (agent.kind === 'subagent') {
      await finalizeAgent(agent, 'completed')
      return
    }

    await waitForMessageOrShutdown(agent)
  } finally {
    emitHook('SubagentStop', agent.metadata)
  }
}
```

结合 `messagesToKeep` 和 `compactionControl`，消息治理的等价模型为：

```ts
function compactHistory(history: Message[], control: CompactionControl): Message[] {
  const messagesToKeep = selectRecentAndStructurallyRequiredMessages(history, control)
  const olderMessages = history.slice(0, history.length - messagesToKeep.length)
  const summary = summarize(olderMessages)
  return [summary, ...messagesToKeep]
}
```

对 zy-code 最有价值的不是复制未知的内部函数，而是对齐这些可验证的设计边界：subagent
有 stop；persistent agent 有 shutdown；压缩显式选择 messagesToKeep；agent 集合存在容量治理。

## 4. zy-code 当前泄漏链路

### 4.1 一次性任务被当作永久 teammate

`src/services/swarm/inProcessRunner.ts` 的主循环只在 lifecycle abort 或模型批准 shutdown 后退出。
一轮工作结束时，task 被设置为 `isIdle: true`，但 status 仍为 `running`，随后进入
`waitForNextPromptOrShutdown()`。

当前状态机实际为：

```text
spawn
  -> running
  -> 一轮 task 完成
  -> running + isIdle
  -> 每 500 ms 检查 mailbox/task list
  -> 下一轮 running
  -> ...
```

`evictTerminalTask()` 仅驱逐 `completed`、`failed`、`killed`，所以 idle teammate 不具备被 GC 的
条件。

### 4.2 `allMessages` 与 runner 同寿命

runner 内部创建：

```ts
const allMessages: Message[] = []
```

用户消息和流式返回不断加入该数组。自动 compact 只在下一轮开始、且 token 数超过模型阈值时
执行。agent 进入 idle 后，runner Promise、AsyncLocalStorage 和局部闭包仍然存在，`allMessages`
不会释放。

### 4.3 UI cap 不能约束 runner history

`TEAMMATE_MESSAGES_UI_CAP = 50` 只约束 AppState 中用于对话框展示的 `task.messages`。
它不能约束：

- runner 的 `allMessages`；
- 原始工具结果；
- content replacement state；
- ToolUseContext 和 options；
- MCP client、工具定义和缓存闭包。

因此 UI 看起来只保留 50 条消息时，内存中仍可能保存完整历史。

### 4.4 原始工具结果放大单 agent 成本

in-process runner 调用 `runAgent()` 时设置 `preserveToolUseResults: true`。FileRead、Bash、MCP、
搜索和图片结果可能远大于普通文本消息。当前检查 compact 的时机无法阻止单轮大结果瞬间占用
数百 MB，也无法在 agent idle 后主动卸载。

### 4.5 当前清理路径并非完全失效

显式 kill、正常 shutdown 和异常退出会清理 controller、callback、cleanup registry、task output
和 tracing，并将 task 标记为终态。主要问题是普通 task 完成不会进入这些路径。

所以准确描述应是：**缺少终止条件导致的预期外强引用保留**，而不是 cleanup 函数本身普遍失效。

## 5. 目标架构

### 5.1 生命周期模式

新增明确模式：

```ts
export type AgentLifecycleMode = 'ephemeral' | 'persistent'
```

#### Ephemeral subagent

- 用于 AgentTool、Explore、Plan、Verification 和一次性并行 task。
- 完成当前 assignment 后必须进入终态。
- 不进入永久 mailbox polling。
- 终态时发出 stop hook 和 task terminated。
- 完整 transcript 可以保留在磁盘，运行上下文必须释放。

#### Persistent teammate

- 仅用于显式 team 成员或调用方明确要求持续通信的 agent。
- 一轮结束后允许 idle。
- 必须受 idle 分层、TTL、驻留容量和内存预算约束。
- 可以从 hibernated 状态恢复，而不是永远保持热 runner。

### 5.2 新状态机

```text
                         +--------------------+
                         | persistent only    |
                         v                    |
pending -> running -> idle-hot -> idle-compact
             |           |            |
             |           | TTL/pressure|
             |           v            v
             +------> completed    hibernated
             |           ^            |
             v           |            | resume
          failed/killed --+------------+
```

建议状态语义：

- `idle-hot`：短时间保留最近上下文，支持低延迟继续。
- `idle-compact`：只保留 summary、最近关键消息和恢复元数据。
- `hibernated`：runner 已退出，runtime 引用全部释放；收到新消息时重新创建 runner。
- `completed`：ephemeral agent 的正常终态。

可以先不扩展公共 `TaskStatus`，用 teammate 子状态表示 idle/hibernate，避免影响所有 task 类型；
但 hibernated task 必须不再被 `getRunningTasks()` 计为运行。

## 6. 详细改造方案

### 6.1 P0：调用方显式指定 lifecycle mode

修改 `InProcessSpawnConfig`：

```ts
export type InProcessSpawnConfig = {
  name: string
  teamName: string
  prompt: string
  color?: string
  planModeRequired: boolean
  model?: string
  lifecycleMode: AgentLifecycleMode
}
```

禁止根据 agent 名称、teamContext 是否存在或 tool 名称隐式推断。建议调用规则：

| 调用来源 | 默认模式 |
|---|---|
| 普通 AgentTool | `ephemeral` |
| Explore/Plan/Verification | `ephemeral` |
| 多 task 并行执行器 | `ephemeral` |
| 显式 TeamCreate/SpawnTeammate | `persistent` |
| 用户明确要求长期协作成员 | `persistent` |

兼容期可在 spawn API 缺少字段时根据入口设置默认值，但内部 config 必须始终是完整字段。

### 6.2 P0：ephemeral 完成首轮后终止

在一轮执行完成、发送必要结果后增加明确分支：

```ts
if (lifecycleMode === 'ephemeral') {
  shouldExit = true
  continue
}

await enterPersistentIdle(...)
```

退出必须统一进入 finalize，而不是在循环中直接删除 task，以保证：

- transcript 完整落盘；
- tool result 配对完成；
- task notification 只发送一次；
- stop hook 只发送一次；
- controller 和 callback 全部解除引用。

### 6.3 P0：统一幂等 finalize

建议在 `src/services/swarm/` 下新增终结模块，不放入 `src/utils/`：

```ts
type FinalizeAgentInput = {
  taskId: string
  status: 'completed' | 'failed' | 'killed'
  reason?: string
  setAppState: SetAppStateFn
}

export async function finalizeInProcessAgent(input: FinalizeAgentInput): Promise<void>
```

职责：

1. 以 task 状态做幂等门控；
2. abort 当前 work controller；
3. abort lifecycle controller；
4. resolve 并清空 idle callbacks；
5. 注销 permission callback 和 UI queue 项；
6. 调用并注销 cleanup registry handler；
7. 清除 messages 之外的 runtime 字段；
8. 从 teamContext 移除终止成员；
9. 注销 Perfetto/tracing；
10. 关闭 task_started 对应的 terminated 事件；
11. 将 transcript/output 落盘或驱逐；
12. 安排 AppState 终态驱逐。

该函数必须允许 kill、runner finally、graceful shutdown 并发调用而不产生重复事件。

### 6.4 P0：runner history 三重预算

不能只按消息数或 token 数限制，应同时限制：

```ts
const AGENT_HISTORY_MAX_MESSAGES = 120
const AGENT_HISTORY_MAX_BYTES = 24 * 1024 * 1024
const AGENT_IDLE_HISTORY_MAX_BYTES = 4 * 1024 * 1024
```

token 上限建议使用当前模型自动 compact threshold 的 50%–70%，给单轮返回和系统 prompt 留出空间。

新增领域服务：

```ts
type AgentHistoryBudget = {
  maxMessages: number
  maxTokens: number
  maxBytes: number
}

type AgentHistoryState = {
  recentMessages: Message[]
  compactedMessages: Message[]
  estimatedTokens: number
  estimatedBytes: number
  rawToolResultBytes: number
}
```

检查时机：

- 每个完整 assistant/user message 加入后；
- 大型 tool result 加入前后；
- 一轮结束进入 idle 前；
- spawn 新 agent 前的全局内存压力检查。

不得只在下一轮 prompt 开始时检查。

### 6.5 P0：工具结果外置

大型工具结果写入 task transcript/output 文件，内存只保留小型预览和定位信息：

```ts
type StoredToolResultReference = {
  type: 'stored_tool_result'
  toolCallId: string
  path: string
  byteLength: number
  preview: string
  digest?: string
}
```

优先外置：

- FileRead 大文件；
- Bash stdout/stderr；
- MCP JSON；
- 搜索结果；
- 图片、音频和 base64；
- 超过单条 byte 阈值的任意 tool result。

对模型的下一轮上下文提供摘要和引用；只有工具语义确实要求原文时才按需读取。tool_use/tool_result
配对 ID 必须保留，避免破坏 API 消息结构。

### 6.6 P1：persistent idle 分层与 TTL

建议默认值：

```ts
const IDLE_HOT_MS = 60_000
const IDLE_TTL_MS = 10 * 60_000
```

进入 idle 时：

1. 立即清除 progress tracker、iteration buffer 和当前 work controller；
2. 计算 history byte/token；
3. 超过 idle budget 时立即 compact；
4. 清除 content replacement state；
5. `IDLE_HOT_MS` 后进入 idle-compact；
6. `IDLE_TTL_MS` 后 hibernate 或 shutdown。

以下状态暂停 TTL：

- 等待用户权限；
- 有未读 mailbox 消息；
- 已领取但未完成 task；
- 用户正在 teammate transcript 中交互。

仅打开只读 UI 不应无限续期，可采用有上限的 lease。

### 6.7 P1：hibernate/resume

hibernate 记录：

```ts
type HibernatedAgentSnapshot = {
  identity: TeammateIdentity
  model?: string
  permissionMode: PermissionMode
  summary: Message[]
  transcriptPath: string
  lastActiveAt: number
}
```

hibernate 后 runner Promise 必须结束，不能只把 task 标记为休眠。收到新消息时：

1. 读取 snapshot；
2. 创建新的 controller 和最小 ToolUseContext；
3. 用 summary + 最近消息恢复；
4. 重新进入 running；
5. 不恢复旧 closure、replacement state 或完整工具结果。

### 6.8 P1：最小化长期 ToolUseContext

不要让 persistent runner 永久持有 spawn 时整份 ToolUseContext。改为长期保存最小句柄：

```ts
type PersistentAgentRuntimeHandle = {
  getAppState: () => AppState
  setAppState: SetAppStateFn
  getRuntimeOptions: () => MinimalAgentRuntimeOptions
}
```

每轮开始时再解析 tools、MCP clients、model capability 和 file state。这样 `/clear`、配置切换和
compact 后，旧上下文不会继续被历史 runner 固定。

### 6.9 P1：全局容量背压

建议初始默认值：

```ts
maxConcurrentInProcessAgents = 8
maxPersistentTeammates = 16
maxResidentAgents = 24
maxEstimatedResidentBytes = 512 * 1024 * 1024
```

定义：

- concurrent：当前正在请求模型或执行工具；
- resident：runner Promise 仍然存活；
- idle：resident 但当前没有工作；
- pending：等待并发槽位，不应持有完整 runtime context。

spawn 决策顺序：

1. 计算 concurrent、resident 和 estimated bytes；
2. 超限时 compact/hibernate 最老 idle persistent agent；
3. ephemeral agent 进入轻量 pending 队列；
4. 无法释放时返回结构化容量错误；
5. 不允许无限 fire-and-forget 创建 runner。

## 7. 可观测性

### 7.1 每 agent 指标

```ts
type AgentMemoryMetrics = {
  taskId: string
  lifecycleMode: AgentLifecycleMode
  runtimeState: 'pending' | 'running' | 'idle-hot' | 'idle-compact' | 'hibernated'
  residentMs: number
  messageCount: number
  estimatedTokens: number
  estimatedBytes: number
  rawToolResultBytes: number
  pendingCallbackCount: number
  lastActiveAt: number
}
```

### 7.2 进程指标

必须同时记录：

```ts
process.memoryUsage()
// rss, heapTotal, heapUsed, external, arrayBuffers
```

判读方式：

- `heapUsed` 随 resident agents 增长：重点检查 messages、context、Map/Set 和 callback。
- `external/arrayBuffers` 增长：重点检查 Buffer、图片、流式响应和二进制工具结果。
- task 已终止但 resident 计数不降：runner Promise 或 AsyncLocalStorage 仍被引用。
- heapUsed 降而 RSS 不降：可能是分配器保留，不应直接判定为 JS 泄漏。

### 7.3 调试输出示例

```text
agents resident=18 concurrent=6 idleHot=4 idleCompact=8 pending=3
history=284MB rawToolResults=196MB external=72MB
largestAgent=researcher-7 task=t123 history=31MB idleFor=94s
rss=812MB heapUsed=436MB heapTotal=501MB
```

用户可见文本必须通过 i18n；内部 debug log 可以使用结构化字段，避免高频拼接大型对象。

## 8. 实施阶段

### Phase 0：基线与保护栏

- 增加 resident/concurrent/idle 统计。
- 增加 history byte/token 估算。
- 增加全局 hard limit，先阻止再次达到 13.7 GB。
- 不改变现有 persistent 行为。

验收：100 个 spawn 请求不会产生 100 个同时 resident runner。

### Phase 1：生命周期拆分

- 引入 `AgentLifecycleMode`。
- AgentTool 和一次性 task 使用 ephemeral。
- ephemeral 完成首轮即 finalize。
- 统一 stop/terminated 事件。

验收：连续运行 100 个一次性 agent 后，resident agent 数回落到基线。

### Phase 2：历史预算和工具结果外置

- 引入 AgentHistoryState。
- message/token/byte 三重预算。
- 大型 tool result 落盘。
- idle 前强制执行 budget check。

验收：单 agent 产生 500 MB shell 输出时，heap 不保留完整 500 MB 内容。

### Phase 3：persistent hibernation

- idle-hot/idle-compact。
- idle TTL。
- snapshot/resume。
- 最小化 ToolUseContext 强引用。

验收：persistent teammate 空闲超过 TTL 后 runner 数下降，重新发送消息可恢复。

## 9. 测试计划

测试放在 `tests/` 并镜像源码路径，`describe` 使用模块名，`test` 使用中文描述。

### 9.1 生命周期测试

- ephemeral agent 一轮成功后进入 completed。
- ephemeral agent 失败后只 finalize 一次。
- kill 与 runner finally 竞争时只发一个 stop 事件。
- persistent agent 一轮结束后进入 idle-hot。
- idle TTL 到期后 runner 真正结束。
- hibernated agent 收到消息后可恢复。

### 9.2 引用释放测试

使用 WeakRef/FinalizationRegistry 只能作为辅助，不能依赖 GC 精确时机。主要断言：

- AppState 不再包含 controller、callback 和完整 messages。
- cleanup registry 不再包含终止 agent handler。
- permission callback registry 无对应项。
- tracing registry 无对应 agent。
- resident registry 数量回落。

### 9.3 压力测试

场景 A：100 个短生命周期 agent，每个 5 个小消息。

- concurrent 不超过配置值；
- 完成后 resident 回落；
- heapUsed 在强制 GC 的诊断构建中回落到稳定区间。

场景 B：8 个 agent 各产生 50 MB 工具输出。

- 输出落盘；
- 内存中只保留预览和引用；
- `rawToolResultBytes` 指标准确。

场景 C：16 个 persistent teammate 空闲。

- 先进入 idle-compact；
- TTL 后 hibernate；
- 重新唤醒时不会加载全部历史。

### 9.4 必要验证

每阶段修改后执行：

```bash
bun tsc --noEmit
bun test
bun run format
```

若修改 LLM 消息类型或适配器，还必须确认测试全绿并无新增 lint 错误。

## 10. 风险与取舍

### 10.1 直接 `slice(-50)` 不可接受

它可能删除 tool_use 对应的 tool_result、系统边界或必要上下文，造成 API 校验错误或模型行为退化。
历史裁剪必须理解消息结构并保留配对关系。

### 10.2 只有 idle TTL 不足

大量 agent 可以在 TTL 到期前把内存推到十几 GB。必须同时具备 spawn 背压和每 agent byte budget。

### 10.3 只有并发限制也不足

8 个 active agent 加 100 个 idle resident agent 仍会保留大量闭包。并发和驻留必须分别限制。

### 10.4 RSS 不会立即下降

JS 对象释放后，Bun/JSC 或系统分配器可能保留已申请页。验收应同时观察 heapUsed、external、
resident registry 和多轮稳定性，不能只用瞬时 RSS 判断。

### 10.5 hibernate 恢复存在语义损失

summary 无法百分百保留原始历史。应保留完整磁盘 transcript，并为关键身份、task、权限模式和
未完成工作使用结构化 snapshot，而不是完全依赖自然语言摘要。

## 11. 建议的最终默认策略

```text
普通 subagent：
  ephemeral，一轮结束立即退出

显式 teammate：
  persistent
  60 秒后 idle-compact
  10 分钟后 hibernate

全局：
  最多 8 个 concurrent in-process agents
  最多 16 个 persistent teammates
  最多 24 个 resident agents
  估算 resident history 默认不超过 512 MB

单 agent：
  最近消息最多 120 条
  history 默认不超过 24 MB
  idle history 默认不超过 4 MB
  token 超过模型 compact threshold 的 50%–70% 时压缩
```

这些默认值应进入配置 schema，并允许企业策略覆盖，但必须保留安全 hard ceiling，防止模型或
错误工作流绕过限制。

## 12. 结论

本问题的根因不是单个遗漏的 `removeEventListener()`，而是把一次性 subagent 和 persistent
teammate 合并为同一种永久 runner：

```text
多 task 创建更多 agent
  -> task 完成但 runner 只进入 idle
  -> allMessages、工具结果、ToolUseContext 和缓存继续被闭包强引用
  -> resident agent 数持续增加
  -> 内存按 agent 数和历史体积线性膨胀
```

对齐 CC 二进制中可验证的生命周期边界后，优先级最高的组合修复是：

1. ephemeral/persistent 生命周期拆分；
2. resident/concurrent 容量背压；
3. message/token/byte 三重历史预算；
4. 原始工具结果外置；
5. persistent idle compact、TTL 和 hibernation；
6. 统一幂等 finalize 与内存可观测性。

只实施其中一项无法彻底解决 13.7 GB 级别的膨胀；上述机制需要作为同一套资源治理系统落地。

## 13. 补充问题：工作已完成但 task 仍显示未完成

### 13.1 现象

实际使用中存在以下状态不一致：agent 已完成实现、验证并输出最终结论，但 task 列表仍显示
一个 `in_progress` 项。例如 9 个 task 中 8 个为 done，“制定修复方案”仍显示进行中。

这不是单纯的 TUI 图标刷新问题。`TaskListV2` 的计数直接来自 task 文件读取结果：

```ts
const completedCount = count(tasks, (task) => task.status === 'completed')
const pendingCount = count(tasks, (task) => task.status === 'pending')
const inProgressCount = tasks.length - completedCount - pendingCount
```

只要磁盘 task 仍是 `in_progress`，UI 就会稳定显示未完成。

### 13.2 CC 二进制对照

CC 二进制中存在以下直接锚点：

| 锚点 | 部分字节偏移 | 结论 |
|---|---:|---|
| `TaskUpdate` | `86060424`, `86172464`, `122059098`, `212300432` | task 状态通过显式工具更新 |
| `TaskList` | `86169528`, `86378753`, `122059192`, `212321023` | agent 通过工具重新读取任务列表 |
| `in_progress` | `86377377`, `113704100`, `114954952` | task 有独立进行中状态 |
| `Task completed. Call TaskList` | `212321002`, `235890549` | 完成后提示 agent 再调用 TaskList |

在 `122059098` 附近可以恢复出 TaskUpdate 工具说明的部分语义：

```text-extracted
... TaskUpdate ...
... status ... in_progress ... completed ...
... When you have completed a task ...
... TaskList ...
```

在 `235890549` 附近可以恢复出完成后返回文本：

```text-extracted
Task completed. Call TaskList now to find your next available task ...
```

该字符串与 zy-code 当前 `TaskUpdateTool` 返回提示高度一致。可确认 CC 也使用“模型显式调用
TaskUpdate，再调用 TaskList”的协议。当前 native snapshot 中没有找到足够证据证明 CC 已实现
“agent stop 时自动把所领取 task 收敛为 completed”。因此不能声称 CC 已修复该问题；它至少
仍保留与 zy-code 相同的显式工具协议。

### 13.3 根因一：工作完成与 task 状态提交不是同一个事务

当前系统存在两个彼此独立的事实：

```text
事实 A：agent 的模型循环完成，已经没有更多工作
事实 B：task 文件的 status 被写为 completed
```

事实 A 不会自动导致事实 B。agent 必须主动生成一次 `TaskUpdate({ status: 'completed' })` 工具
调用。如果模型认为最终回复已经足够、上下文被中断、达到 token 限制或工具调用失败，就会出现：

```text
实际工作完成
  -> 未调用 TaskUpdate(completed)
  -> runner 将 agent 设为 idle
  -> task 文件仍为 in_progress
  -> UI 永久显示 1 in progress
```

截图中的现象与该路径高度一致。

### 13.4 根因二：runner 没有记录当前领取的 task

`tryClaimNextTask()` 会：

1. `claimTask(taskListId, task.id, agentName)`；
2. 再调用 `updateTask(..., { status: 'in_progress' })`；
3. 只返回格式化后的 prompt。

它没有把 `taskId` 作为结构化 assignment 保存到 runner state。后续一轮完成时，runner 不知道：

- 当前 prompt 是否来自 task list；
- 当前具体 task ID；
- task 是否已经由模型标记 completed；
- 是否需要在 idle 前进行 reconciliation。

虽然 `sendIdleNotification()` 的 options 定义了 `completedTaskId` 和 `completedStatus`，正常完成路径
没有填充这些字段。这表明 task 完成信息在设计上预留过，但目前没有接入正常收敛流程。

### 13.5 根因三：claim 与 in_progress 是两次独立写入

当前领取过程先 `claimTask()` 写 owner，再调用一次 `updateTask()` 写 status。两次写入之间可能发生：

- 进程 abort；
- 文件锁失败；
- 第二次更新返回 null；
- task 被删除/reset；
- 其他 agent 读取到 owner 已设置但 status 仍 pending 的中间状态。

而 `tryClaimNextTask()` 忽略了第二次 `updateTask()` 的返回值，即使状态未成功改为 `in_progress`，
仍会向 agent 返回 task prompt。

领取必须改为单次锁内 compare-and-set：

```ts
claimTask(taskListId, taskId, agentName)
// 在同一个临界区内验证 pending + unowned + blockers resolved，
// 并同时写入 owner、status: in_progress、claim metadata。
```

### 13.6 根因四：TaskUpdate 忽略持久化结果

`TaskUpdateTool` 当前执行：

```ts
await updateTask(taskListId, taskId, updates)
```

但没有检查返回值。`updateTask()` 在 task 不存在、schema 读取失败等情况下返回 null。这样工具仍可能
继续构造成功结果，让模型认为 task 已完成，而磁盘状态没有改变。

应改为：

```ts
const persistedTask = await updateTask(taskListId, taskId, updates)
if (!persistedTask) {
  return createTaskUpdateFailure(...)
}

if (updates.status && persistedTask.status !== updates.status) {
  return createTaskUpdateConflict(...)
}
```

### 13.7 根因五：完成 hook 在状态提交之前执行

当目标状态为 completed 时，`TaskUpdateTool` 先完整执行 `TaskCompleted` hooks，全部通过后才写入
`updates.status`。因此以下情况会让实际工作完成但 task 保持 in_progress：

- hook 阻止完成；
- hook 卡住或异常；
- agent/controller 在 hook 期间 abort；
- hook 完成后、文件写入前进程退出。

阻止完成本身可能是预期行为，但 UI 目前没有区分“工作仍在进行”和“完成验证被阻止”。至少应将
blocking reason 写入结构化 metadata，并显示为 blocked/verification-failed，而不是普通 in progress。

### 13.8 根因六：文件更新不是原子替换

task 更新使用 `writeFile(path, json)` 直接覆盖原文件。文件监听器或其他 agent 可能在文件被截断、
尚未写完时读取，导致 JSON 解析/schema validation 暂时失败并返回 null。

多数情况下后续 fs event 会再次刷新，但不同平台和 Bun watcher 的事件合并行为可能造成 UI 暂时或
持续保留旧快照。建议改为同目录临时文件 + rename 的原子替换：

```ts
await writeFile(tempPath, serialized)
await rename(tempPath, taskPath)
```

Windows 下需要处理目标文件已存在的替换语义，并保持锁覆盖整个过程。

## 14. task 状态收敛设计

### 14.1 结构化 assignment

runner 不应只接收字符串 prompt，应保留 assignment：

```ts
type ClaimedTaskAssignment = {
  taskListId: string
  taskId: string
  owner: string
  claimToken: string
  claimedAt: number
  version: number
}
```

`tryClaimNextTask()` 返回：

```ts
type ClaimNextTaskResult = {
  assignment: ClaimedTaskAssignment
  prompt: string
}
```

并将其保存到 `InProcessTeammateTaskState.currentAssignment`。这样 runner 在模型轮次结束、abort、
idle 和 finalize 时都能核对 task 状态。

### 14.2 task revision 与 compare-and-set

task schema 增加：

```ts
type Task = {
  // existing fields
  revision: number
  claimToken?: string
  updatedAt: string
}
```

状态更新使用期望 revision/claim token：

```ts
updateTaskStatus({
  taskListId,
  taskId,
  expectedRevision,
  expectedClaimToken,
  from: 'in_progress',
  to: 'completed',
})
```

这样可以防止旧 agent 在 task 已被重新分配后提交迟到的 completed，把其他 agent 的新工作覆盖。

### 14.3 idle 前 reconciliation

每轮 agent 返回 idle 前执行：

```ts
async function reconcileCurrentAssignment(runtime: AgentRuntime): Promise<ReconcileResult> {
  const assignment = runtime.currentAssignment
  if (!assignment) {
    return { type: 'none' }
  }

  const task = await getTask(assignment.taskListId, assignment.taskId)
  if (!task) {
    return { type: 'removed' }
  }
  if (task.status === 'completed') {
    runtime.currentAssignment = undefined
    return { type: 'completed' }
  }

  return { type: 'unresolved', task }
}
```

对 unresolved 不能无条件自动完成，因为“模型本轮自然结束”可能意味着提问、阻塞、权限等待或失败。
应根据结构化 turn outcome 决策。

### 14.4 引入结构化 turn outcome

runner 需要区分：

```ts
type AgentTurnOutcome =
  | { type: 'completed'; summary?: string }
  | { type: 'blocked'; reason: string }
  | { type: 'awaiting_input'; question?: string }
  | { type: 'interrupted' }
  | { type: 'failed'; error: string }
```

推荐规则：

| turn outcome | 当前 task 状态 | 收敛动作 |
|---|---|---|
| completed | completed | 清除 assignment |
| completed | in_progress | 自动 CAS 为 completed，记录 `completionSource: runner` |
| blocked | in_progress | 保持未完成，写入 blocked metadata |
| awaiting_input | in_progress | 保持未完成，显示 awaiting input |
| interrupted | in_progress | 保持或释放 owner，按策略处理 |
| failed | in_progress | 写入失败 metadata，并允许重新分配 |

`completed` 必须来源于结构化运行结果或明确工具事件，不应通过匹配最终文本中的“完成了”判断。

### 14.5 保留显式 TaskUpdate，但增加 runner 安全网

最佳策略不是删除 TaskUpdate：

- 正常路径：agent 主动 TaskUpdate completed；
- 安全网：runner 检测结构化 completed outcome，但 task 仍 in_progress 时补写；
- 冲突路径：revision/claim token 不匹配时不覆盖，记录 reconciliation conflict；
- 终结路径：agent stop/finalize 前再次核对 current assignment。

这比完全依赖模型工具调用可靠，也比“agent 停止就自动完成 task”安全。

### 14.6 orphan task 回收

定期检查：

```text
status=in_progress
AND owner 不在 active/resident agent registry
AND updatedAt 超过宽限期
```

满足条件的 task 标记为 orphaned，而不是直接 completed：

```ts
metadata: {
  orphanedAt,
  previousOwner,
  reason: 'owner_not_active',
}
owner: undefined
status: 'pending'
```

这样 agent 崩溃、被 kill 或 session 恢复失败时，task 不会永久卡在 in progress。

### 14.7 UI 展示改进

UI 不应把所有非 pending/completed 状态通过减法归为 in progress。建议显式计数：

```ts
const inProgressCount = count(tasks, (task) => task.status === 'in_progress')
```

并支持子状态：

- in progress；
- awaiting input；
- blocked by completion hook；
- orphaned/requeued；
- owner inactive。

如果 task 为 in_progress 但 owner 不活跃，应显示警告图标和“owner inactive”，而不是普通蓝色方块。

## 15. task 一致性测试计划

### 15.1 必测用例

- agent 显式 TaskUpdate completed 后 UI 显示全部完成。
- agent 结构化 outcome 为 completed 但遗漏 TaskUpdate 时，runner reconciliation 补写 completed。
- outcome 为 awaiting_input 时不得自动完成。
- completion hook 阻止时显示 blocked reason。
- `updateTask()` 返回 null 时 TaskUpdateTool 必须返回失败。
- claim 操作同时写 owner 和 in_progress，不暴露中间状态。
- 旧 claim token 不能覆盖重新分配后的 task。
- agent kill 后 orphan task 在宽限期后重新进入 pending。
- task 临时文件写入完成前，reader 只能看到旧版本或新版本，不能看到半个 JSON。
- watcher 丢失 fs event 时，周期性 reconciliation 最终刷新 UI。

### 15.2 压力竞态

启动多个 agent 并发执行：

1. 同时 claim 同一个 task；
2. 一个 agent completed、另一个提交迟到更新；
3. hook 执行期间 abort；
4. task reset 与 update 并发；
5. Windows rename/lock contention；
6. watcher debounce 期间连续 pending -> in_progress -> completed。

最终必须满足不变量：

```text
同一 task 同一 revision 最多一个有效 owner；
completed 不会被旧写入回退为 in_progress；
不存在 owner 已消失且永久 in_progress 的 task；
工具返回 success 时，重新读取必须观察到目标状态。
```

## 16. 与内存治理方案的联动

task 幽灵未完成与内存膨胀实际上共享同一个生命周期缺陷：

```text
task 没有收敛为 completed
  -> agent 保持 idle/running
  -> runner 和历史上下文不能释放
  -> task UI 显示未完成，同时内存持续驻留
```

因此实施顺序应调整为：

1. 建立结构化 current assignment；
2. claim 原子化并检查持久化结果；
3. 增加 turn outcome 和 idle/finalize reconciliation；
4. 再启用 ephemeral agent 自动退出；
5. 最后加入 idle TTL、hibernate 和 orphan recovery。

如果先让 ephemeral agent 自动退出，却没有 task reconciliation，会增加“agent 已退出但 task 仍
in_progress”的频率。生命周期终止与 task 状态收敛必须在同一个阶段交付。

## 17. 补充问题：展开 task 列表挤压输入框高度

### 17.1 现象与直接原因

当展开 task 列表且任务较多时，输入编辑区会缩到接近 0 行，只剩上下分隔线和 footer。截图中
9 个 task 全部展开，task 标题和内容约占 11–12 行，而输入正文区域已经不可见。

`FullscreenLayout` 对整个 bottom slot 设置：

```tsx
<Box flexDirection="column" flexShrink={0} width="100%" maxHeight="50%">
  {bottom}
</Box>
```

bottom slot 内按顺序包含 permission footer、立即命令、TaskListV2、dialog、通知、PromptInput 和
PromptInputFooter。`TaskListV2` 却独立使用全终端高度计算可见项：

```ts
const maxDisplay = rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14))
```

这个公式不知道 bottom slot 只有 `rows * 50%`，也没有扣除 prompt border、输入最小行、footer、
permission、stash、notification 等兄弟节点。任务列表先占满 bottom 高度后，PromptInput 中包裹
TextInput 的容器设置了 `flexShrink={1}`，因此成为 Yoga 优先压缩对象：

```tsx
<Box flexGrow={1} flexShrink={1}>
  {textInputElement}
</Box>
```

边框和 footer 仍占固定行，最终呈现为“输入框存在，但正文高度为 0”。

### 17.2 为什么 task 状态问题会放大该故障

展开列表优先展示 recent completed、in-progress 和 pending。幽灵 `in_progress` task 不会进入完成
后的清理/折叠路径，使 TaskListV2 持续挂在 bottom slot 中。因此两个问题形成反馈：

```text
task 遗漏 completed
  -> expanded task list 持续存在
  -> bottom slot 长期超出高度预算
  -> 输入正文被压缩到 0 行
```

### 17.3 P0 修复：输入区拥有不可侵占的最小高度

布局必须保证输入交互优先于辅助面板。建议定义统一预算：

```ts
const MIN_PROMPT_BODY_LINES = 1
const PROMPT_BORDER_LINES = 2
const PROMPT_FOOTER_MIN_LINES = 1
const TASK_LIST_HEADER_LINES = 2
```

PromptInput 外层或 TextInput 容器设置明确 `minHeight`，并禁止 task list 把它压到 0：

```tsx
<Box flexDirection="column" minHeight={MIN_PROMPT_TOTAL_LINES} flexShrink={0}>
  <PromptInput />
</Box>
```

task list 应是可压缩对象：

```tsx
<Box flexDirection="column" flexShrink={1} overflow="hidden">
  <TaskListV2 ... />
</Box>
```

不能只给内部 TextInput 设置 `minHeight`，因为 PromptInput 的 border/footer 也参与 bottom slot 布局。

### 17.4 P0 修复：由父布局传递可用行数

`TaskListV2` 不应再次读取全局 terminal rows 并自行猜测。父级应计算 bottom slot 的动态预算：

```ts
type BottomLayoutBudget = {
  totalRows: number
  reservedPromptRows: number
  reservedOverlayRows: number
  availableTaskRows: number
}
```

然后传给 task list：

```tsx
<TaskListV2 tasks={tasksV2} maxDisplayRows={availableTaskRows} isStandalone />
```

建议计算原则：

```ts
const bottomRows = Math.floor(rows / 2)
const reservedPromptRows = promptBorderRows + minInputRows + footerRows
const availableTaskRows = Math.max(0, bottomRows - reservedPromptRows - dynamicFooterRows)
```

TaskListV2 的实际可见 task 数还要扣除标题、margin 和 hidden summary：

```ts
const maxTaskItems = Math.max(0, availableTaskRows - TASK_LIST_HEADER_LINES)
```

### 17.5 P1 修复：窄高终端自动降级为摘要

当 `availableTaskRows` 不足时：

- 0 行：不渲染展开列表，只在 footer/pill 显示计数；
- 1–2 行：只显示 `9 tasks (8 done, 1 in progress)`；
- 3 行以上：标题 + 优先 task + hidden summary；
- 用户需要完整内容时打开 task dialog/overlay。

优先级应为：

1. in-progress；
2. 未阻塞 pending；
3. 最近完成；
4. 其他完成。

当前实现把 recent completed 放在 in-progress 之前，在高度紧张时可能挤掉真正需要关注的未完成
任务，建议同时调整。

### 17.6 P1 修复：完整列表使用 overlay，而不是常驻 bottom

展开模式适合少量 task；完整 task 管理更适合 `BackgroundTasksDialog` 类 overlay。建议：

- bottom slot 只保留高度受控的 task 摘要；
- “展开”打开可滚动 overlay；
- overlay 使用全屏可用高度，不参与 PromptInput flex 布局；
- 关闭 overlay 后焦点可靠返回输入框。

这也能避免 20、50、100 个 task 时依赖固定 `maxDisplay=10` 的脆弱布局。

### 17.7 测试矩阵

必须覆盖不同终端高度、动态 footer 和任务数量：

| rows | task 数 | permission/footer | 期望 |
|---:|---:|---|---|
| 10 | 9 | 无 | 输入至少 1 行，task 仅摘要 |
| 16 | 9 | 无 | 输入至少 1 行，task 自动截断 |
| 24 | 9 | 有 | permission 与输入可见，task 截断 |
| 30 | 20 | 无 | 输入正常，显示优先 task 和 hidden summary |
| 60 | 20 | 无 | task 可展示更多，但不超过预算 |

还应测试：

- 空输入和多行输入；
- suggestion、notification、stash notice 同时出现；
- permission sticky footer 出现/消失；
- task 在 pending -> in_progress -> completed 之间快速切换；
- resize 后可见 task 数即时重算；
- 输入区永远不低于最小正文高度；
- footer selection 不影响输入区高度。

布局核心不变量为：

```text
prompt body height >= 1
task list height <= parent-provided availableTaskRows
bottom children total height <= bottom slot budget
```

该修复应与 task reconciliation 一并交付：前者保证状态最终正确，后者保证即使状态暂时异常，
辅助 task UI 也不能破坏主要输入交互。

## 18. 补充问题：无子代理的长主会话也可达到 1.6 GB

### 18.1 结论

子代理不是唯一根因，只是把主会话已有的“完整历史长期驻留”按 agent 数放大。即使没有子代理，
主会话多轮执行大量 Read、Bash、Search、MCP 和长 thinking 后，也会同时保留：

1. ReplStore 中用于 UI/transcript 的原始 `messages`；
2. 每轮构造的 API `messagesForQuery` 数组和替换后消息；
3. 流式阶段的 assistant/tool buffers；
4. 虚拟列表的索引、高度和搜索文本缓存；
5. content replacement state；
6. 文件读取状态缓存；
7. transcript 异步写入闭包短期捕获的消息数组。

当上下文达到约 500K tokens 时，纯文本本体、JS 字符串/对象开销和派生搜索字符串相加，RSS 达到
1.6 GB 是可解释的，但不应被视为理想行为。

### 18.2 原始 UI 消息没有固定 byte 上限

主会话消息保存在：

```ts
type ReplState = {
  messages: Message[]
}
```

`setMessages()` 只替换/追加数组，没有 message、token 或 byte 上限。自动 compact 主要约束下一次
发送给模型的上下文，不等价于立即卸载 UI transcript 中的所有原始内容。

尤其是 tool-result budget 在 `preprocessMessages()` 构造的 `messagesForQuery` 上应用。它可以让发送
给 API 的副本使用持久化预览，但 ReplStore 原始消息仍可能保留完整工具结果，直到显式 compact、
clear 或其他路径真正替换 state。

### 18.3 虚拟化只降低渲染成本，不降低历史存储

`VirtualMessageList` 使用 `messages.slice(start, end)` 只渲染可视窗口，但组件仍接收完整
`RenderableMessage[]`，并维护：

- message keys；
- height cache；
- offsets/index；
- sticky prompt state；
- 搜索索引；
- 对完整 messages 的 ref。

因此虚拟化可以降低 Ink/React 节点数量，却不会释放不可见消息及其中的工具结果。

### 18.4 搜索缓存可能复制大型文本

虚拟列表和 Messages 搜索路径为消息缓存 lowercase/search text：

```ts
const fallbackLowerCache = new WeakMap<RenderableMessage, string>()
const promptTextCache = new WeakMap<RenderableMessage, string | null>()
```

WeakMap 不会阻止 message 被 GC，但只要 ReplStore 永久持有 message，cache value 也同样存活。
如果 search text 包含大型工具输出，lowercase 结果会创建另一份大字符串。Messages.tsx 还有自己的
lower cache，因此同一消息可能存在多份派生文本。

搜索缓存必须按规范化小型文本建立，禁止索引完整大型 tool result、base64、图片描述和附件原文。

### 18.5 transcript 异步写入的瞬时峰值

`useLogMessages()` 已优化为通常只写新增 tail，但在首屏、compact、rewind 或数组 head 改变时，会把
完整消息数组交给 `recordTranscript()`。fire-and-forget Promise 完成前，其闭包可短期持有完整 slice
和完整 messages context。

如果消息继续快速更新，可能同时存在多个尚未完成的 transcript 写入任务。`callSeqRef` 只防止旧
Promise 更新游标，不会取消底层写入或释放其参数。需要对 transcript writer 做串行队列和背压，
而不是每次 effect 独立启动完整异步工作。

### 18.6 file cache 不是主要 1.6 GB 来源

`FileStateCache` 已有 100 entries 和默认 25 MB size limit，因此单个主 cache 通常不是 GB 级主因。
但 compact、side query 或并行辅助操作可能 clone cache，造成短时多份 25 MB 副本。应记录 clone
数量和 calculatedSize，但优先级低于原始 messages/tool results。

### 18.7 主会话冷热历史分层

主会话也应采用与 agent history 相同的分层模型：

```ts
type MainConversationHistory = {
  hotMessages: Message[]
  compactSummary: Message[]
  coldTranscriptIndex: TranscriptIndex
  estimatedBytes: number
  estimatedTokens: number
}
```

- hot：最近若干轮，保留完整结构和必要工具结果；
- compact：模型需要的 summary 和结构化状态；
- cold：完整 transcript 落盘，只在滚动/搜索/复制时按窗口加载。

UI 不应要求完整 transcript 常驻内存。VirtualMessageList 的输入应逐步改为可分页 data source，而不是
完整数组。

### 18.8 主会话预算建议

初始保护值可设为：

```ts
const MAIN_HOT_HISTORY_MAX_MESSAGES = 300
const MAIN_HOT_HISTORY_MAX_BYTES = 64 * 1024 * 1024
const MAIN_SEARCH_INDEX_MAX_CHARS_PER_MESSAGE = 16_384
const TRANSCRIPT_WRITE_MAX_PENDING_BYTES = 32 * 1024 * 1024
```

token 阈值继续用于模型上下文；byte 阈值用于进程内存。两者必须并存，因为大工具结果、对象包装、
重复字符串和附件不能由 token 数准确反映。

达到预算时：

1. 完成当前 tool_use/tool_result 配对；
2. 将旧工具结果外置；
3. 将冷消息写入 transcript；
4. 从 ReplStore 移除冷消息本体，只保留轻量索引；
5. 清除对应搜索/高度缓存；
6. 必要时触发 compact，但不能把 compact 当作唯一内存治理手段。

### 18.9 compact 后的清理不变量

每次完整 compact 完成后必须同步：

```text
ReplStore.messages 只引用 post-compact hot history
VirtualMessageList 不再引用旧 messages array
搜索缓存中的旧 key 可被 GC
content replacement state 只保留仍在 hot messages 中的 tool IDs
transcript writer 不持有无用的旧完整数组
read-file cache 按 compact 策略清理或保留受限大小
```

需要增加 compact 前后指标：

```text
messages bytes before/after
tool result bytes before/after
search cache chars before/after
pending transcript write bytes
heapUsed/rss/external before/after
```

### 18.10 诊断 1.6 GB 的验证步骤

在相同会话分别记录：

1. `process.memoryUsage()`；
2. ReplStore message 数、估算字符数和 tool-result bytes；
3. 搜索索引字符数；
4. content replacement maps 大小；
5. transcript pending jobs/bytes；
6. file cache calculatedSize；
7. 手动 compact 前后变化；
8. compact 后等待 GC/分配器稳定时的 heapUsed 与 RSS。

判断标准：

- heapUsed 与 message/tool bytes 同步增长：主历史强引用是主因；
- 搜索后出现明显台阶：lower/search cache 是重要副本；
- compact 后 heapUsed 降但 RSS 不降：主要是分配器高水位，不是旧对象仍全部存活；
- compact 后 heapUsed 也不降：继续检查 VirtualMessageList refs、transcript Promise 和旧 context。

### 18.11 测试场景

- 500 轮纯短文本对话，内存进入稳定增长区间；
- 100 轮含 Read/Search，每轮产生大工具结果；
- 首次全文搜索前后比较 heap；
- 连续 compact 三次，旧消息可释放且搜索/虚拟列表仍正确；
- transcript 慢盘模拟下 pending bytes 不无限增长；
- scroll 到冷历史时按窗口加载，离开窗口后可释放；
- `/clear` 后 messages、search cache、replacement state 和 pending writer 全部收敛。

主会话治理与子代理治理应共享 history byte estimator、工具结果外置格式和 transcript page store，
避免维护两套行为不同的内存策略。

## 19. Claude Code 对长会话内存已有的优化

### 19.1 二进制证据汇总

| 优化 | CC 二进制锚点 | 部分偏移 | 证据等级 |
|---|---|---:|---|
| compact boundary | `compact_boundary` | `92910641`, `111408000`, `119004376` | A |
| 保留最近消息 | `messagesToKeep` | `110369056`, `222016648`, `232380342` | A |
| compact 控制 | `compactionControl` | `161851848`, `224818465`, `224819003` | A |
| microcompact | `microcompact` | `113149145`, `119004424`, `232944024` | A |
| 虚拟化消息 UI | `virtualized` | `93731082`, `225755929` | A |
| 工具结果治理 | `tool result` / `tool_result` | `93720148`, `103179127`, `103191694` | A |
| 持久化结果 | `persisted` | `86132889`, `100589216`, `100593027` | B |
| 总 token 提醒 | `CLAUDE_CODE_TOTAL_TOKENS_REMINDER` | `93731xxx` 附近 | A |
| RSS/heap profiling | `RSS`, `heapUsed` | `224897222`, `227731294` | A |
| prune/truncate | `prune`, `pruning`, `truncate` | `90235560`, `232891667`, `59280797` | B |

### 19.2 分层 compact，而不是只做一次摘要

CC 同时存在 `compact_boundary`、`messagesToKeep`、`compactionControl` 和 `microcompact`，说明其
上下文治理至少包含两层：

1. microcompact：在达到完整 compact 前，对局部内容做轻量裁剪；
2. full compact：生成摘要并建立 compact boundary；
3. messagesToKeep：摘要后保留最近或结构上必须保留的消息。

在 `232944024` 附近可以直接恢复出：

```text-extracted
[KEEP RECENT ...]
Context ...
messagesToKeep ...
microcompact ...
```

同一区域出现可见常量 `20000`、`2000`、`300`。由于 native snapshot 无法可靠恢复变量边界，
不能断言它们分别对应字符、token 或消息条数；但可以确认实现包含 recent window 和上限计算，
并非把全部历史原样带入下一轮。

zy-code 已有对应的 auto compact、microcompact 和 `buildPostCompactMessages()`，因此这一层不是
完全缺失，而是需要验证 compact 后旧 UI/history 引用是否真正释放。

### 19.3 工具结果裁剪与持久化

CC 二进制同时存在 `tool_result`、`persisted`、truncate/prune 等锚点，表明大型工具内容不会仅靠
完整上下文 compact 治理。结合现有行为，可以合理确认其 API 上下文路径包含工具结果裁剪或
持久化引用机制。

zy-code 的 `toolResultStorage.ts` 已实现相近机制：

- 每消息工具结果预算；
- 选取大型 fresh result；
- 原文持久化到磁盘；
- API 消息替换为预览；
- replacement state 保证 prompt cache 稳定。

关键差异不在“有没有工具结果预算”，而在预算主要作用于 `messagesForQuery`。主 ReplStore 的
原始 UI messages 仍可能保存未替换的大结果。后续改造应把持久化结果引用同步回 UI history，
或者让 UI 从 transcript 按需读取原文。

### 19.4 虚拟化渲染

CC 二进制存在 `virtualized` 字符串及相邻的 terminal UI/message 逻辑，说明长 transcript 使用了
窗口化渲染，避免所有消息同时生成终端节点。

zy-code 已有 `VirtualMessageList`，并维护高度、offset、sticky prompt 和可视区 slice。这基本对齐
CC 的渲染方向，但两者都要区分：

```text
UI virtualization != data virtualization
```

窗口化 React/Ink 节点只能降低布局和渲染成本，不能自动释放完整 Message 对象。

### 19.5 总 token 提醒和长会话保护

在 `93731082` 附近可以恢复出：

```text-extracted
CLAUDE_CODE_TOTAL_TOKENS_REMINDER
CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET
CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN
5000000
15000000
```

这说明 CC 会跟踪累计 token，并在用户轮次附近注入提醒或预算控制。可见的 5,000,000 和
15,000,000 更可能是累计 token 级保护，而不是单次 context window；具体触发条件无法从 native
snapshot 可靠恢复。

这种机制主要防止极长 session 无限运行和成本失控，不直接等价于 heap byte limit。zy-code
需要保留 token 提醒，同时新增 message/tool-result byte 指标。

### 19.6 内存 profiling

在 `224897222` 附近可以恢复出 profiling 输出语义：

```text-extracted
RSS: ...
Heap: ...
Heap Used: ...
STARTUP PROFILING REPORT
CLAUDE_CODE_PROFILE_STARTUP
```

CC 至少在 profiling/debug 路径区分 RSS 和 heap 指标，并记录启动阶段的性能/内存事件。该证据
证明其具备诊断能力，但不能证明存在基于 RSS 的运行时自动淘汰策略。

zy-code 应扩展为 session runtime profiling，记录每轮、compact 前后和 agent spawn/finalize 的
内存变化，而不只关注启动阶段。

### 19.7 缓存和 pruning

二进制中存在大量 LRU、cache clear、prune、truncate 锚点，但它们分布在网络、解析器、日志、
MCP、UI 等多个模块，不能把所有命中都归因于 conversation memory。

可以可靠得出的结论仅是：CC 广泛使用有界缓存和显式 prune；无法仅凭这些字符串证明它对完整
conversation messages 使用了 LRU 淘汰。

### 19.8 未找到可靠证据的优化

当前二进制检查没有足够证据确认 CC 已实现：

- 完整 transcript 的磁盘分页数据源；
- 主 UI messages 的固定 byte 上限；
- 基于 RSS/heap pressure 自动卸载冷消息；
- 搜索索引按页卸载；
- transcript writer pending-byte 背压；
- 空闲主会话自动 hibernate。

没有证据不代表一定不存在，但在 native snapshot 无法恢复完整调用图的情况下，方案不能依赖这些
假设。尤其是 CC 存在虚拟化 UI，并不证明不可见 Message 数据已经从内存移除。

### 19.9 zy-code 与 CC 对齐状态

| CC 优化 | zy-code 状态 | 主要差距 |
|---|---|---|
| compact boundary | 已有 | 验证旧引用是否释放 |
| messagesToKeep | 已有相近实现 | 缺少统一 byte budget |
| microcompact | 已有 | 主要服务 API context |
| 工具结果持久化 | 已有 | 原始 UI messages 仍可能持有原文 |
| virtualized list | 已有 | 数据本体没有分页 |
| token reminder | 部分已有 token/cost 指标 | 缺少 session hard guard |
| RSS/heap profiling | footer 有 RSS，诊断不足 | 缺少分模块归因和 compact 前后对比 |
| prune/cache clear | 多模块已有 | conversation/search cache 缺少集中治理 |

### 19.10 建议吸收 CC 的部分

应继续保持并强化：

1. microcompact + full compact 分层；
2. messagesToKeep 保留最近结构化上下文；
3. 工具结果持久化和稳定 replacement；
4. transcript UI 虚拟化；
5. 总 token budget 和提醒；
6. RSS/heap profiling。

但解决当前 1.6 GB/13.7 GB 问题还必须补充 CC 二进制中未能确认的部分：

1. 主 UI history 冷热分层和分页；
2. 原始工具结果从 ReplStore 卸载；
3. message/tool-result byte hard limit；
4. transcript writer 背压；
5. 搜索派生字符串预算；
6. agent resident 生命周期和总驻留预算。

因此正确方向不是简单“照搬 CC”，而是保留已对齐的上下文优化，再补上进程内数据生命周期治理。

## 20. 深入二进制复核：CC 实测内存更低的关键差异

### 20.1 修正前述判断

进一步枚举 CC 二进制的环境变量和稳定日志后，可以确认 CC 不只有常规 compact。它存在多条专门
清理旧上下文和缓存的路径。zy-code 虽然保留了其中部分源码骨架，但若干关键路径被 internal build、
feature macro 或默认关闭的 GrowthBook 配置挡住，外部构建实际上不会执行。

这比“CC 可能也保留完整 UI history”更能解释实测差异。

### 20.2 CC 直接清除旧工具结果

CC 二进制直接包含：

```text-extracted
USE_API_CLEAR_TOOL_RESULTS
USE_API_CLEAR_TOOL_USES
USE_API_CONTEXT_MANAGEMENT
[Old tool result content cleared]
<persisted-output>
</persisted-output>
```

相关偏移：

| 锚点 | 偏移 |
|---|---:|
| `USE_API_CLEAR_TOOL_RESULTS` | `90136832`, `225411387` |
| `[Old tool result content cleared]` | `86132968`, `229680497`, `232944380`, `239334919` |
| `<persisted-output>` | `86132888`, `229680446`, `232944420` |
| `clearToolResults` | `222151057`, `243116748` |

这说明 CC 能把旧 tool result 替换成固定小字符串，而不是只在达到 full compact 后生成摘要。
`persisted-output` 保证原文仍可从磁盘定位。

### 20.3 zy-code 的 API 清除路径在外部构建被禁用

zy-code 的 `apiMicrocompact.ts` 已实现 Anthropic API context management：

```ts
type: 'clear_tool_uses_20250919'
trigger: { type: 'input_tokens', value: 180_000 }
clear_at_least: { type: 'input_tokens', value: 140_000 }
```

默认策略约等于：输入达到 180K tokens 时清理至少 140K，目标保留约 40K。但是代码先执行：

```ts
if (!isInternalBuild()) {
  return strategies.length > 0 ? { edits: strategies } : undefined
}
```

工具结果清除逻辑位于该 return 之后。因此外部构建即使设置 `USE_API_CLEAR_TOOL_RESULTS`，也不会
添加工具清除 strategy；最多只可能添加 thinking 清理。

这是 CC 与 zy-code 外部版本之间最明确的行为差异之一。

### 20.4 cached microcompact 在外部构建不可用

`microCompact.ts` 的主路径为：

```ts
if (feature('CACHED_MICROCOMPACT')) {
  // API cache_edits 路径
}

return { messages }
```

源码注释也明确说明：cached microcompact 对外部构建不可用时，不执行旧版微压缩，只交给 full
autocompact 处理。

其影响是：

```text
CC/internal:
  多轮过程中持续删除旧 tool results

zy-code external:
  旧 tool results 一直累积
  -> 接近 full compact 阈值后才整体摘要
```

500K/1M context model 会让 full compact 触发得非常晚，因此旧工具结果可在内存中积累到 GB 级。

### 20.5 time-based microcompact 默认关闭

zy-code 已有一条非常有效的路径：当距上次 assistant 消息超过服务端 prompt cache TTL 时，保留最近
5 个可压缩工具结果，把更旧结果替换为 `[Old tool result content cleared]`。

但默认配置为：

```ts
const TIME_BASED_MC_CONFIG_DEFAULTS = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}
```

是否启用依赖内部 GrowthBook `zy_slate_heron`。因此无内部实验配置的发行版不会运行。

CC 二进制中同一清除标记出现于多个独立代码区，结合实际较低内存，可以合理推断官方发行配置
至少对部分用户启用了这类驱逐策略。

### 20.6 cold compact

CC 二进制包含：

```text-extracted
CLAUDE_CODE_COLD_COMPACT
```

偏移：`90144096`, `225417156`, `236595315`。

zy-code 源码中没有 `COLD_COMPACT` 或 `coldCompact` 对应实现。结合名称、time-based microcompact 和
prompt cache TTL 逻辑，合理推断 cold compact 用于缓存已冷却、会话恢复或空闲后重写成本已经不可
避免的场景：此时可以更激进地压缩历史，而无需维护热 prompt cache 前缀。

具体阈值和完整函数体无法从 native snapshot 稳定恢复，因此这里标为结构推断，不宣称是原始实现。

### 20.7 subagent cache eviction

CC 二进制包含：

```text-extracted
CLAUDE_CODE_SUBAGENT_CACHE_EVICT
```

偏移：`90139728`, `225413650`, `236528777`。

zy-code 没有对应锚点。该机制至少说明 CC 对 subagent 使用独立缓存淘汰策略，而不是让每个已结束
subagent 的上下文继续保留。它与明确的 `SubagentStop` 生命周期共同构成子代理内存回收闭环。

### 20.8 自动 compact window 可独立收紧

CC 二进制包含大量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 引用：

```text
125837528, 129174054, 129179048, 129189125,
225431176, 236590981, 237084149, 237086517
```

这允许有效 compact window 小于模型真实 context window。对 1M context 模型尤其重要：如果完全按照
1M 上下文触发，进程可能在 compact 前已保存数百 MB 原始消息。

zy-code 有 `ZY_CODE_AUTO_COMPACT_WINDOW`，但如果没有默认收紧值，就仍使用完整模型窗口。建议为大
上下文模型设置内存友好的默认 effective window，而不是要求用户配置环境变量。

### 20.9 CC 的实际优化组合

综合二进制证据，CC 较低内存更可能来自以下组合，而非单一技巧：

```text
工具产生大输出
  -> 大输出持久化到磁盘
  -> API context management / cache edits 清除旧 tool results
  -> 热缓存期只保留必要前缀
  -> 缓存冷却后 time-based/cold compact 更激进清理
  -> auto compact window 可提前触发
  -> subagent stop 后驱逐其缓存
  -> UI 使用 virtual scroll
```

其中真正降低数据本体的机制是工具结果清除、cold compact 和 subagent eviction；virtual scroll 主要
降低渲染成本。

### 20.10 zy-code 当前实际执行路径

外部构建很可能是：

```text
API clear tool results: 被 isInternalBuild() 禁用
cached microcompact: 被 feature DCE 禁用
time-based microcompact: GrowthBook 默认 enabled=false
cold compact: 未实现
subagent cache eviction: 未实现
auto compact: 有，但可能按 1M 完整窗口很晚才触发
tool result per-message persistence: 有，但原始 UI messages 仍可能保留
```

所以“源码中看起来已经有 microcompact”不能代表发行版真的执行了它。

### 20.11 建议的 P0 对齐方案

第一步不必立即实现完整 transcript 分页，先恢复 CC 已验证有效的清理路径：

1. 将客户端 tool-result microcompact 作为外部构建正式功能，不依赖 internal GrowthBook。
2. 默认在主线程启用，保留最近 5–10 个可压缩 tool results。
3. 同步替换 ReplStore 中旧 tool result，而不是只修改 `messagesForQuery`。
4. 原文必须先持久化并留下 `<persisted-output>` 引用。
5. 为 1M context 模型设置较小默认 auto-compact window，例如 180K–250K，而非等到接近 1M。
6. agent finalize 时清除其 cached MC/replacement/search/runtime 状态。
7. 实现 cold compact：空闲超过 cache TTL 或 resume 后允许更激进压缩。

### 20.12 API 能力兼容

`clear_tool_uses_20250919` 属于供应商 API context management 能力，不应直接对所有 provider 开启。
建议两级实现：

```ts
if (providerSupportsContextManagement) {
  // 使用 API clear_tool_uses/cache_edits
} else {
  // 客户端复制消息结构，替换旧 tool_result content
}
```

客户端 fallback 才是解决本地内存问题的必要保障，因为即使服务端接受 context management，原始
ReplStore 消息仍需要在安全持久化后主动卸载。

### 20.13 验证实验

建议用同一脚本分别运行以下构建：

| 组 | 配置 |
|---|---|
| A | 当前外部默认配置 |
| B | 客户端 time-based MC 强制 enabled |
| C | 180K tool-result microcompact + 200K auto compact window |
| D | C + ReplStore 原文同步替换 |

每 10 轮记录 RSS、heapUsed、tool-result bytes 和 message bytes。预期：

- B 只在跨 60 分钟间隔后有明显下降；
- C 控制 API context，但 UI 原文仍可能使 heap 偏高；
- D 才会明显降低 heapUsed 和长期 RSS 高水位；
- 若 D 后 heapUsed 下降但 RSS 不降，则剩余主要是分配器保留。

## 21. 可直接落地的 CC 等价实现

> 版权与准确性说明：本节不逐字复制 Claude Code 专有二进制源码。当前 CC 是 native snapshot，
> 也无法可靠恢复完整原始函数体。以下实现依据 CC 二进制中的稳定锚点、zy-code 已移植代码和
> 可确认触发条件重建，目标是可以直接在本仓库实现，而不是伪装成 CC 原始源码。

### 21.1 功能开关与建议发布状态

| 能力 | CC 二进制证据 | zy-code 当前状态 | 建议 |
|---|---|---|---|
| API clear tool results | `USE_API_CLEAR_TOOL_RESULTS` | external 被 internal gate 禁用 | provider 支持时默认开启 |
| API clear tool uses | `USE_API_CLEAR_TOOL_USES` | external 被 internal gate 禁用 | 后续灰度 |
| cached microcompact | `cache_edits`/`CACHED_MICROCOMPACT` | internal feature | 保留供应商专用 |
| client microcompact | cleared marker | time-based 默认关闭 | 所有 provider 默认开启 |
| cold compact | `CLAUDE_CODE_COLD_COMPACT` | 缺失 | 默认开启 |
| subagent cache eviction | `CLAUDE_CODE_SUBAGENT_CACHE_EVICT` | 缺失 | 默认开启 |
| early compact window | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 仅 env override | 大上下文模型设默认值 |

建议配置模型：

```ts
export type ConversationMemoryPolicy = {
  clientToolResultEviction: {
    enabled: boolean
    triggerTokens: number
    targetTokens: number
    keepRecentToolResults: number
    minResultTokens: number
  }
  coldCompact: {
    enabled: boolean
    idleMinutes: number
    keepRecentTurns: number
    keepRecentToolResults: number
  }
  mainHistory: {
    maxHotBytes: number
    maxHotMessages: number
  }
  subagents: {
    evictOnStop: boolean
    idleTtlMs: number
  }
}
```

推荐首发值：

```ts
export const DEFAULT_CONVERSATION_MEMORY_POLICY: ConversationMemoryPolicy = {
  clientToolResultEviction: {
    enabled: true,
    triggerTokens: 180_000,
    targetTokens: 40_000,
    keepRecentToolResults: 8,
    minResultTokens: 1_000,
  },
  coldCompact: {
    enabled: true,
    idleMinutes: 60,
    keepRecentTurns: 4,
    keepRecentToolResults: 5,
  },
  mainHistory: {
    maxHotBytes: 64 * 1024 * 1024,
    maxHotMessages: 300,
  },
  subagents: {
    evictOnStop: true,
    idleTtlMs: 10 * 60_000,
  },
}
```

180K/40K 来自现有 `apiMicrocompact.ts` 的 CC 对齐值；60 分钟/保留 5 个来自现有
`timeBasedMCConfig.ts`。其他值是本方案的保守首发建议，需要压力测试校准。

### 21.2 统一工具结果驱逐器

新增 `src/services/compact/toolResultEviction.ts`：

```ts
import type { Message } from '../../types/message.js'

export const CLEARED_TOOL_RESULT = '[Old tool result content cleared]'

export type ToolResultEvictionOptions = {
  triggerTokens: number
  targetTokens: number
  keepRecent: number
  minResultTokens: number
  persistResult: (input: {
    toolCallId: string
    content: unknown
  }) => Promise<{ replacement: string } | null>
}

type Candidate = {
  messageIndex: number
  blockIndex: number
  toolCallId: string
  estimatedTokens: number
  content: unknown
}

export async function evictOldToolResults(
  messages: Message[],
  options: ToolResultEvictionOptions,
): Promise<{ messages: Message[]; tokensRemoved: number; clearedIds: string[] }> {
  const candidates = collectToolResultCandidates(messages, options.minResultTokens)
  const totalTokens = estimateMessageTokens(messages)
  if (totalTokens < options.triggerTokens || candidates.length <= options.keepRecent) {
    return { messages, tokensRemoved: 0, clearedIds: [] }
  }

  const protectedIds = new Set(
    candidates.slice(-Math.max(1, options.keepRecent)).map((candidate) => candidate.toolCallId),
  )
  const selected: Candidate[] = []
  let projectedTokens = totalTokens

  for (const candidate of candidates) {
    if (projectedTokens <= options.targetTokens) {
      break
    }
    if (protectedIds.has(candidate.toolCallId)) {
      continue
    }
    selected.push(candidate)
    projectedTokens -= candidate.estimatedTokens
  }

  const persisted = new Map<string, string>()
  for (const candidate of selected) {
    const result = await options.persistResult({
      toolCallId: candidate.toolCallId,
      content: candidate.content,
    })
    if (result) {
      persisted.set(candidate.toolCallId, result.replacement)
    }
  }

  if (persisted.size === 0) {
    return { messages, tokensRemoved: 0, clearedIds: [] }
  }

  let tokensRemoved = 0
  const next = replaceToolResults(messages, (block) => {
    const replacement = persisted.get(block.toolCallId)
    if (!replacement) {
      return block
    }
    tokensRemoved += estimateToolResultTokens(block)
    return { ...block, content: replacement || CLEARED_TOOL_RESULT }
  })

  return {
    messages: next,
    tokensRemoved,
    clearedIds: [...persisted.keys()],
  }
}
```

实现约束：

- 先持久化成功，再替换内存内容；
- 保留 toolCallId，不能破坏 tool_use/tool_result 配对；
- 图片、document、base64 优先驱逐；
- 不能清理当前进行中的 tool call；
- 同一个 toolCallId 重复执行必须幂等；
- replacement 必须包含可恢复路径和原始字节数。

### 21.3 持久化 replacement 格式

复用现有 `<persisted-output>` 语义：

```ts
export function buildPersistedToolResultReference(input: {
  path: string
  originalBytes: number
  preview?: string
}): string {
  const preview = input.preview?.trim()
  return [
    `<persisted-output path="${escapeXml(input.path)}" bytes="${input.originalBytes}">`,
    preview || CLEARED_TOOL_RESULT,
    '</persisted-output>',
  ].join('\n')
}
```

完整原文只存在于磁盘；ReplStore、API messages、搜索索引和子代理 history 都使用同一个 reference。
这避免同一结果存在“UI 原文 + API 预览 + agent 原文”三份表示。

### 21.4 主线程触发顺序

每次 API 请求前执行：

```ts
async function prepareMainThreadMessages(input: {
  messages: Message[]
  providerCapabilities: ProviderCapabilities
  policy: ConversationMemoryPolicy
  lastAssistantAt?: number
}): Promise<PreparedMessages> {
  let hotMessages = input.messages

  const isCold =
    input.lastAssistantAt !== undefined &&
    Date.now() - input.lastAssistantAt >= input.policy.coldCompact.idleMinutes * 60_000

  if (isCold && input.policy.coldCompact.enabled) {
    hotMessages = await coldCompactMessages(hotMessages, input.policy.coldCompact)
  }

  if (input.policy.clientToolResultEviction.enabled) {
    const evicted = await evictOldToolResults(hotMessages, {
      ...input.policy.clientToolResultEviction,
      persistResult: persistToolResult,
    })
    hotMessages = evicted.messages
  }

  // 关键：把缩减后的消息提交回 ReplStore，而不是只创建 API 副本。
  if (hotMessages !== input.messages) {
    replStore.setMessages(hotMessages)
  }

  const contextManagement = input.providerCapabilities.clearToolUses
    ? buildAPIContextManagement(input.policy.clientToolResultEviction)
    : undefined

  return { messages: hotMessages, contextManagement }
}
```

触发顺序不可颠倒：cold compact 先确定新的热历史边界；客户端 eviction 再保证本地内存收敛；API
context management 最后作为服务端附加优化。

### 21.5 API context management 去除 internal gate

当前 `apiMicrocompact.ts` 不应以 `isInternalBuild()` 判断能力，应按 provider capability 判断：

```ts
export function getAPIContextManagement(input: {
  providerCapabilities: ProviderCapabilities
  policy: ConversationMemoryPolicy
  hasThinking: boolean
  clearAllThinking: boolean
}): ContextManagementConfig | undefined {
  const edits: ContextEditStrategy[] = []

  if (input.hasThinking) {
    edits.push({
      type: 'clear_thinking_20251015',
      keep: input.clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }

  if (
    input.providerCapabilities.clearToolUses &&
    input.policy.clientToolResultEviction.enabled
  ) {
    const config = input.policy.clientToolResultEviction
    edits.push({
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: config.triggerTokens },
      clear_at_least: {
        type: 'input_tokens',
        value: config.triggerTokens - config.targetTokens,
      },
      clear_tool_inputs: CLEARABLE_TOOL_NAMES,
    })
  }

  return edits.length > 0 ? { edits } : undefined
}
```

provider 不支持时，客户端 eviction 仍必须运行；不能把本地内存治理依赖于 Anthropic 专用 API。

### 21.6 cold compact 等价实现

CC 二进制只能确认 `CLAUDE_CODE_COLD_COMPACT` 存在，无法可靠恢复完整函数。可落地实现如下：

```ts
export async function coldCompactMessages(
  messages: Message[],
  config: ConversationMemoryPolicy['coldCompact'],
): Promise<Message[]> {
  const turns = splitIntoConversationTurns(messages)
  if (turns.length <= config.keepRecentTurns) {
    return messages
  }

  const recentTurns = turns.slice(-config.keepRecentTurns)
  const coldTurns = turns.slice(0, -config.keepRecentTurns)
  const summary = await compactConversation(flattenTurns(coldTurns), {
    suppressFollowUpQuestions: true,
    isAutoCompact: true,
  })

  const recentMessages = flattenTurns(recentTurns)
  const evicted = await evictAllButRecentToolResults(
    recentMessages,
    config.keepRecentToolResults,
  )

  return [createCompactBoundaryMessage(), ...buildPostCompactMessages(summary), ...evicted]
}
```

触发条件：

- 主线程；
- 空闲时间大于等于 60 分钟；
- 当前没有流式请求、工具调用或权限对话框；
- transcript 已 flush；
- 至少存在 `keepRecentTurns + 1` 个完整轮次；
- 同一冷周期只执行一次，避免每次请求重复摘要。

resume 场景可视为 cold，但如果磁盘 snapshot 已是 compact 后格式，不应再次 compact。

### 21.7 大上下文模型提前 compact

不要默认使用 1M 完整窗口。建议：

```ts
export function getMemorySafeCompactWindow(modelWindow: number): number {
  if (modelWindow >= 1_000_000) {
    return 240_000
  }
  if (modelWindow >= 500_000) {
    return 200_000
  }
  if (modelWindow >= 200_000) {
    return 180_000
  }
  return modelWindow
}
```

最终阈值：

```ts
const effectiveWindow = Math.min(
  modelContextWindow,
  configuredAutoCompactWindow ?? getMemorySafeCompactWindow(modelContextWindow),
)
const threshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
```

这是内存保护默认值，不改变 provider 的真实能力；用户可显式提高，但 UI 应提示预计内存成本。

### 21.8 subagent stop cache eviction

新增幂等清理：

```ts
export function evictSubagentRuntime(agentId: string): void {
  agentHistoryRegistry.delete(agentId)
  contentReplacementRegistry.delete(agentId)
  searchIndexRegistry.delete(agentId)
  permissionCallbackRegistry.deleteByAgent(agentId)
  transcriptWriter.flushAgent(agentId)
  cachedMicrocompactRegistry.resetAgent(agentId)
  toolResultPreviewRegistry.deleteByAgent(agentId)
}
```

调用点：

- SubagentStop finally；
- task completed/failed/killed finalize；
- graceful shutdown；
- orphan runner watchdog；
- persistent teammate hibernate。

清理后 AppState 只允许保留 identity、summary、status 和 transcript path，不得保留 controller、完整
messages、ToolUseContext 或回调。

### 21.9 主 ReplStore 同步替换

目前 query preprocess 返回的 `messagesForQuery` 不足以降低 UI heap。新增 action：

```ts
type ApplyConversationCompactionInput = {
  expectedHeadUuid?: string
  messages: Message[]
  clearedToolIds: string[]
}

function applyConversationCompaction(input: ApplyConversationCompactionInput): boolean {
  const current = replStore.getState().messages
  if (input.expectedHeadUuid && current[0]?.uuid !== input.expectedHeadUuid) {
    return false
  }

  replStore.setMessages(input.messages)
  virtualMessageCache.invalidateRemovedMessages(current, input.messages)
  searchIndex.invalidateToolResults(input.clearedToolIds)
  pruneContentReplacementState(input.messages)
  return true
}
```

需要 compare-and-set，防止异步持久化期间新流式消息加入后被旧快照覆盖。

### 21.10 发布与灰度计划

阶段一：只记录不清理。

- 记录每轮可驱逐 tool results 数、tokens、bytes；
- 记录如果采用 180K/40K 策略预计节省多少；
- 不改变消息。

阶段二：客户端 eviction，10% 会话。

- 仅清理已成功持久化的 Read/Bash/Grep/Glob/WebFetch/WebSearch；
- 保留最近 8 个；
- 同步更新 ReplStore；
- 监控 resume、tool pairing 和 prompt cache 命中。

阶段三：大窗口 early compact。

- 1M 模型默认 240K；
- 支持配置覆盖；
- 对比 compact 次数、成本、RSS 和用户满意度。

阶段四：cold compact 和 subagent eviction。

- 先启用 subagent stop eviction；
- 再启用 60 分钟 cold compact；
- 最后实现 persistent teammate hibernate。

### 21.11 成功标准

同一 100 轮重工具测试：

```text
主线程 heapUsed p95 < 500 MB
主线程 RSS p95 < 900 MB
单 agent 完成后 retained history < 8 MB
无 subagent 时 RSS 不随轮次无限线性增长
compact/resume 后 tool pairing 错误为 0
持久化失败时绝不删除内存原文
```

13.7 GB swarm 测试：

```text
resident agent 数受硬上限约束
agent stop 后 heapUsed 可观察到回落
总 RSS 保持在配置预算内
无 completed task 残留 active runner
```
