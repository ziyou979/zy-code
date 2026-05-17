# Claude Code 源码泄漏拆解：从启动到多 Agent 扩展层

> **作者：** 陈以强(无岳) | **ATH 事业群-悟空事业部**
> **发布时间：** 2026年3月31日 | **更新：** 2026年3月31日
> **浏览：** 8.0k | **点赞：** 302

---

> 这篇文章只做一件事：把 Claude Code 拆成几个真正决定系统质量的核心模块，然后把几个最关键的问题讲透。
>
> - 它到底怎么设计？
> - 为什么要这样设计？
> - 这样设计的价值是什么？
> - 我们做自己的 Agent 时，哪些最值得吸收？

这两年大家都在写 Agent，但其实所有人都知道一个尴尬事实：Demo 阶段看起来势如破竹，一旦加到三五个工具、几种运行模式、几类权限规则之后，系统就开始肉眼可见地变形。主循环越来越脏，工具一多就互相污染，后台任务和前台会话互相打架，扩展一接进来就满地特判。

**模型能力当然重要，但真正决定一个 Agent 能不能长期活下去的，往往不是模型，而是围着模型搭起来的运行时。**

## 1. 入口与启动链路：别急着拉起全世界

### 核心矛盾

一个成熟 Agent 往往同时要支持本地交互、headless、SDK、remote、后台 session、会话恢复。如果启动层不先把模式、边界、权限和上下文装配清楚，后面每个宿主都会偷偷长出自己的运行语义，最终系统会裂成几套。

### 从源码看，启动大致分三段

```
入口分流          主装配层          进程级初始化
参数分流/fast path → 模式判断/会话装配 → 会话级准备
                                     交互式宿主或无界面引擎
```

1. **第一段是入口分流。** 系统不急着把整个运行时拉起来，而是先判断这次到底是什么启动：本地交互、无界面运行、远程接入、后台会话管理，还是一些极简 fast path。
2. **第二段是进程级初始化。** 这一层处理的是运行环境：配置、telemetry、远程设置、清理回调、一些全局设施。它回答的是"进程能不能跑"，不是"这一轮 Agent 该怎么跑"。
3. **第三段才是会话级准备。** 这里开始确定当前工作目录、会话身份、工具面、权限模式、扩展能力、系统约束、恢复方式等信息。

### Claude Code 的解法

Claude Code 把"进程状态"和"交互状态"分开了：

- 像 cwd、projectRoot、sessionId、telemetry、token/cost 计数这类更接近基础设施的东西，会沉在 bootstrap/state 一类全局状态里
- 而 tasks、MCP clients、plugin 状态、permission context、界面选择状态这类更接近控制面的东西，才进入 AppState

**最值得注意的是两个判断：**
1. 先装配共享 session/runtime 语义，再选择交互式或 headless 这种宿主
2. 先区分进程状态和交互状态，再决定哪些进 AppState，哪些留在更底层状态里

### 我们怎么学

最值得吸收的不是"复杂入口"，而是**次序感**。凡是会影响执行边界的东西，尽量都在第一轮请求前定型。

> 启动层做得好不好，平时不显山不露水；但系统一旦开始长模式、长宿主、长入口，它往往就是最先决定架构寿命的那一层。

## 2. REPL / UI Orchestration：UI 不是传话筒

### 核心矛盾

一旦 Agent 不只是聊天，而开始执行工具、弹权限、跑后台任务、动态接入扩展，UI 面对的就不再是"如何显示回复"，而是"如何把一个复杂 runtime 变成用户可操作、可理解、可干预的系统"。

### Claude Code 的解法

Claude Code 没有把 REPL 做成薄薄的输入框加消息列表，而是让它负责两件大事：

1. **汇总当前能力面：** 本地工具、外部工具、插件能力、任务状态、权限确认队列、远程会话信息
2. **归并当前事件流：** 助手消息、工具进度、待确认权限、任务通知、接口错误

所以 REPL 在 Claude Code 里既不是纯 view，也不是纯 controller，它更像 **runtime 的操作台**。

### 为什么这样好

这样设计的最大好处是"可控"。用户不是只看到一句模型回复，而是能看到系统正在执行什么、为什么停下来、当前有哪些能力、后台有哪些任务。

> 对复杂 Agent 来说，UI 做得好，用户看到的是系统在协作；UI 做得不好，用户看到的就只是一团偶尔会成功的黑箱。

## 3. Query Loop / QueryEngine：把单轮对话升级成状态机

### 核心矛盾

只要 Agent 开始连续运行，系统就会立刻碰到几个硬问题：长上下文会劣化，工具调用会打断推理，模型输出会截断，失败后要不要恢复，工具结果怎样回灌下一轮。

### Claude Code 的解法

它把 query 拆成两层：
- **会话外壳**负责会话记录、输入处理、能力面暴露
- **真正的 Query Loop** 负责运行状态机，维护跨迭代状态

```typescript
state = {
  messages,
  toolUseContext,
  maxOutputTokensOverride,
  autoCompactTracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  turnCount,
  pendingToolUseSummary,
  transition,
}
```

这段骨架非常关键。一个普通 orchestrator 不会长期维护 autoCompactTracking、maxOutputTokensRecoveryCount 这类对象；一旦这些状态都进入主循环，说明系统已经承认一件事：**一次 agent turn 会被压缩、恢复、工具回灌、预算和中断反复改写。**

最小化主循环骨架：

```typescript
while (true) {
  prefetchMemoryAndSkills()
  messagesForQuery = applyBudget(messages)
  messagesForQuery = snipAndCompact(messagesForQuery)

  assistant = streamModel(messagesForQuery)
  if (!assistant.hasToolUse) return finishTurn(assistant)

  toolResult = runToolUse(assistant.toolUse, toolUseContext)
  state.messages = writeBack(messages, assistant, toolResult)
}
```

Claude Code 真正高明的点，不是 while loop 本身，而是它把 prefetch、budget、compact、tool result write-back 这些原来容易散落在边边角角的逻辑，**全部拉回了主循环正中央**。

### 我们怎么学

最值得学的不是每一个 compact/recovery 细节，而是**判断升级**：当系统开始"连续运行"时，query loop 就不该只是模型调用封装，而应该被单独当成一层系统设计。

> Query Loop 这一层真正值钱的，不是它写得有多复杂，而是它承认了一件很现实的事：连续运行从来不是一次模型调用能解决的问题。

## 4. Tool Runtime：把野生工具变成系统调用

### 核心矛盾

工具一旦开始碰文件、命令、网络和副作用，问题就不再是"模型会不会调用函数"，而是"这次行动是否合法、能否并发、如何上报进度、失败怎样表达、结果怎样重新喂给模型"。

### Claude Code 的解法

Claude Code 对工具层的理解很成熟：**工具不是模型的外挂函数，而是 runtime 的受治理执行单元。**

统一执行链负责解析、校验、授权、执行、归一化：

```typescript
async function* runToolUse(toolUse, assistantMessage, canUseTool, ctx) {
  const tool = findToolByName(ctx.options.tools, toolUse.name) ?? findAlias(toolUse.name)
  if (!tool) return toolResultError(toolUse.id, 'No such tool available')

  yield* streamedCheckPermissionsAndCallTool(
    tool, toolUse.id, toolUse.input, ctx, canUseTool,
  )
}
```

两个关键的工程判断：
1. **并发策略不由模型决定，而由工具语义决定。** 只读工具和有副作用的工具，本来就不应该用同一套并发策略。
2. **流式工具执行必须被认真建模。** 模型还在流式输出时，工具就先开始执行，但又通过状态跟踪、结果缓冲、取消管理来保证正确性。

### 我们怎么学

最值得借鉴的，不是"工具很多"，而是**工具有制度**。

一旦工具开始碰副作用，就应该尽快建设统一 Tool Runtime。一个很务实的起点，是先把"校验、授权、结果格式"三件事统一起来。

## 5. Permission System：不是弹个框就完事了

### 核心矛盾

Agent 的权限问题从来不只是"要不要弹个确认框"，而是四件事同时存在：逻辑上是否允许、自动化能否消化、用户何时必须参与、即使允许执行时进程边界到底被限制在哪。

### Claude Code 的解法

Claude Code 把 permission 拆成一条完整决策链：

```
tool_use → 规则匹配 → 直接执行 / 自动判定链 → 用户确认 → 沙箱内执行 → 结构化执行结果
```

- **规则层：** 匹配允许、拒绝、待确认，保留来源和理由
- **运行时判定层：** classifier、hooks、coordinator 等机制尝试自动决策
- **交互层：** 真的需要用户参与时，再走确认
- **执行隔离层：** 把逻辑权限映射成真实的文件、网络、命令边界

权限决策对象：

```typescript
type PermissionDecision =
  | { behavior: 'allow'; updatedInput?; decisionReason? }
  | {
      behavior: 'ask'
      message: string
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      pendingClassifierCheck?: PendingClassifierCheck
    }
  | { behavior: 'deny'; message: string; decisionReason: string }
```

很多团队的权限系统只有 boolean，Claude Code 则把 decisionReason、suggestions、blockedPath、pendingClassifierCheck 都提升成正式字段。

### 我们怎么学

最值得学的，是**把权限设计成可解释的执行链，而不是弹窗机制**。

> 权限系统真正成熟的标志，从来不是它拦得有多凶，而是它能不能把风险控制、自动化和可解释性同时放进一套机制里。

## 6. Task / 多 Agent / 后台执行：多 Agent 的核心不是 prompt 分工

### 核心矛盾

多 Agent 真正难的地方，从来不是 prompt 怎么分工，而是系统里一旦出现多个可持续执行的执行体，状态怎么管理、进度怎么观察、结果怎么回流、上下文怎么隔离、失败怎么恢复。

### Claude Code 的解法

Claude Code 用 **Task** 统一表达了很多看起来不同的东西：
- 主会话后台化
- 本地 subagent
- in-process teammate
- remote agent

子 Agent 先是任务对象，才是智能体。

本地子 Agent 的任务状态：

```typescript
type LocalAgentTaskState = {
  agentId: string
  prompt: string
  progress?: AgentProgress
  error?: string
  result?: AgentToolResult
  messages?: Message[]
  isBackgrounded: boolean
  pendingMessages: string[]
  retain: boolean
  diskLoaded: boolean
  evictAfter?: number
}
```

pendingMessages 说明子 Agent 不是一次性调用，而是带邮箱的执行体；isBackgrounded 说明前后台切换是正式语义；retain、diskLoaded、evictAfter 说明系统已经开始认真处理"UI 是否还握着它、磁盘记录是否已回灌、什么时候该回收"这些长期运行才会出现的问题。

### 我们怎么学

如果系统开始出现后台执行、子任务协作、远程执行，就先把**统一任务抽象做对**，再谈 fancy 的多 Agent 结构。

> 多 Agent 真正从 demo 走向系统，靠的从来不是 prompt 分工有多聪明，而是任务系统能不能把分出去的执行重新收回来。

## 7. MCP / Skills / Plugins 扩展层：外部可以热闹，内部必须收敛

### 核心矛盾

Agent 一旦走向平台化，扩展来源一定会变多。真正危险的不是来源多，而是每多一种来源，主系统就多一套能力模型、权限模型和 UI 暴露方式，最后 special case 爆炸。

### Claude Code 的解法

Claude Code 在扩展层上坚持的是**"动态能力面，稳定内部对象"**。

外部协议会被翻译成工具、命令、能力单元、资源：

```
外部来源: MCP / Skills / Plugins
       ↓ 能力收敛层
内部对象: Tool / Command / Skill / Task-Plugin 对象
```

Skill 的能力声明：

```typescript
type SkillDescriptor = {
  description: string
  allowedTools: string[]
  whenToUse?: string
  model?: Model
  effort?: Effort
  hooks?: Hooks
  executionContext?: 'fork'
  agent?: string
}
```

Claude Code 里的 skill 不是"顺手塞一段提示词"，而是能约束工具权限、触发条件、执行上下文、模型偏好、推理力度，甚至决定是否 fork 执行。

### 我们怎么学

对想做 Agent 平台化的团队来说，这一层最值得学的不是"也去上更多扩展体系"，而是先吸收一句更底层的原则：**外部世界可以复杂，内部世界必须收敛**。

> 扩展层真正高明的地方，不是让系统认识更多外部世界，而是让系统在面对更多外部世界时，内部仍然只说同一种语言。

## 8. 总结与总架构：把复杂度放在对的位置上

### 总架构

```
用户 / 接口调用 / 远程客户端
        ↓
启动层 —— 模式、权限、会话边界
        ↓
REPL / Host —— 输入、任务、权限、动态能力面
        ↓
Query Loop —— 上下文治理、流式推理、工具回灌、失败恢复
        ↓
Tool Runtime —— 校验、权限、并发、结果协议化
        ↓
Task Runtime —— 后台执行、多 Agent、远程执行
        ↓
MCP / Skills / Plugins → 能力收敛层
        ↓
文件 / Shell / 网络 / IDE / 外部服务
```

### 三条主干链路

1. **控制链：** 启动层 → REPL → Query Loop —— 解决"怎么想、怎么续跑"
2. **执行链：** Tool Runtime → Permission → Sandbox / Tool Call —— 解决"怎么动、怎么受约束"
3. **任务链：** Task Runtime → 后台执行 / 多 Agent / 回流 —— 解决"怎么并发、怎么持续、怎么回流"

### 我们最后该带走什么

如果一定要把整篇文章再压缩成几句最值得带走的话，我会留下这 5 条：

1. **先定义执行边界，再发起第一轮推理。**
2. **当 Agent 进入连续运行阶段，query loop 就必须升级成 runtime。**
3. **工具一旦开始碰副作用，工具层就必须制度化。**
4. **权限系统的核心不是确认框，而是可解释的执行链。**
5. **多 Agent 的前提不是 prompt 分工，而是统一任务抽象。**

> Claude Code 真正值得借鉴的，不是它"做了很多层"，而是它知道每一层在承接哪一种真实复杂度。
>
> 真正成熟的 Agent 系统，不是"模型更会做事"，而是"组织能把模型做事这件事，稳定地接进交付链路里"。
