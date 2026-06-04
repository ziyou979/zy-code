# zy-code Hook 系统对齐 Claude Code 方案

> 对照版本：Claude Code v2.1.158（最新）vs zy-code 当前主干。
> 数据来源：`claude.exe` 二进制反汇编（`grep -aob` + `dd`）+ Claude Code CHANGELOG（2.1.89 → 2.1.158）+ 本仓库 `src/utils/hooks/`、`src/types/hooks/`、`src/query.ts`。
> 维护人填写实施里程碑时请同步更新「状态」列。

---

## 1. 背景

zy-code 的 hook 系统在 **运行时能力**（HTTP/Prompt/Agent/Function hook、流式事件、SSRF 防护、Skill frontmatter 注册）上实际比 Claude Code 更宽，但在 **事件覆盖、安全治理、字段对齐** 三个维度滞后于 Claude Code 近 70 个版本的迭代。

本方案聚焦那些 ROI 高、Claude Code 已经验证过的改进，按优先级分三批落。**不**复刻 Claude Code 的事件名出于"对齐而对齐"的目的——只挑业务有真实需求的事件加入。

---

## 2. 缺失能力总览

| 优先级 | 能力 | Claude Code 版本 | 工作量 | 状态 |
|---|---|---|---|---|
| **P0** | Stop hook 连续 block 自动熔断 | 2.1.143 | 0.5h | ☐ |
| **P0** | `permissions.deny` 覆盖 PreToolUse hook 的 `permissionDecision:"ask"` | 2.1.101 | 1h | ☐ |
| **P0** | hook input 注入 `effort.level` + `$CLAUDE_EFFORT` 环境变量 | 2.1.133 | 1h | ☐ |
| **P0** | hook 输出超阈值落盘（防上下文撑爆） | 2.1.89 / 2.1.97 | 2h | ☐ |
| **P1** | `MessageDisplay` hook 事件 | 2.1.152 | 3h | ☐ |
| **P1** | `PostToolUse.hookSpecificOutput.updatedToolOutput` 推广到所有工具 | 2.1.121 | 1h | ☐ |
| **P1** | `Stop`/`SubagentStop` input 加 `background_tasks` + `session_crons` | 2.1.145 | 2h | ☐ |
| **P1** | hook command 的 `args: string[]` exec form | 2.1.139 | 2h | ☐ |
| **P1** | hook output 的 `terminalSequence` 字段 | 2.1.141 | 1.5h | ☐ |
| **P2** | `PostToolUse.duration_ms` | 2.1.119 | 0.5h | ☐ |
| **P2** | `PostToolBatch` 事件 | 2.x | 4h | ☐ |
| **P2** | `UserPromptExpansion` 事件 | 2.x | 2h | ☐ |
| **P3** | `PermissionDenied` retry 字段对齐 | 2.1.89 | 0.5h | ☐ |
| **P3** | hook `type: "mcp_tool"` 直调 MCP | 2.1.118 | 3h | ☐ |

合计 P0：4.5h；P1：9.5h；P2：6.5h；P3：3.5h。建议先做 **P0 全量**（一次 PR），再分批 P1。

---

## 3. P0 详细方案

### 3.1 Stop hook 连续 block 自动熔断（2.1.143）

#### 现状

[src/query.ts](file:///Users/zy979/IdeaProjects/zy-code/src/query.ts) line 1188 在 stop hook 触发 blocking 后只会把 `stopHookActive: true` 写回 state，**没有连续计数**——理论上恶意/写错的 stop hook 可让会话死循环，吃光 token、token 与 API quota。

#### Claude Code 实现要点

二进制反编译片段（`claude.exe` offset `203838143`，原始 minified 已格式化）：

```js
// === claude.exe @ ~0xC264FBF ===
if (Continuation) return { reason: "stop_hook_prevented" };
if (b_.blockingErrors.length > 0) {
  let V_ = p + 1, tH = I + 1;

  // (a) 先撞 maxTurns 上限
  if (A && V_ > A)
    return d("tengu_stop_hook_block_count", {
      count: tH,
      is_subagent: Boolean(Z.agentId),
      hit_max_turns: true,
      hit_cap: false,
    }),
    yield k9({ type: "max_turns_reached", maxTurns: A, turnCount: V_ }),
    { reason: "max_turns", turnCount: V_ };

  // (b) 再撞 stop hook block cap（核心熔断逻辑）
  let U_ = parseInt(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? "", 10),
      F_ = Number.isNaN(U_) ? 8 : U_;          // 默认 8 次
  if (F_ > 0 && tH > F_)
    return d("tengu_stop_hook_block_count", {
      count: tH,
      is_subagent: Boolean(Z.agentId),
      hit_max_turns: false,
      hit_cap: true,
    }),
    yield V3(
      `A hook blocked the turn from ending ${tH} consecutive times \u2014 overriding and ending turn. ` +
      `For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. ` +
      `Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.`,
      "warning",
    ),
    { reason: "completed" };

  // (c) 否则继续重试，counter +1 写回 state
  M = {
    messages: [...U, ...OH, ...b_.blockingErrors],
    toolUseContext: Z,
    compactTracking: g,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: E,
    maxOutputTokensOverride: void 0,
    pendingToolUseSummary: void 0,
    stopHookActive: true,
    stopHookBlockingCount: tH,
    turnCount: V_,
    transition: { reason: "stop_hook_blocking" },
  };
  continue;
}
return { reason: "completed" };
```

关键三处：
- (a) `hit_max_turns` 与 (b) `hit_cap` 是互斥的两条路径；遥测 `tengu_stop_hook_block_count` 都用同一名字但 boolean 字段不同。
- 默认 `cap = 8`；环境变量 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=0` 可禁用熔断；未设置或非数字时 fallback 到 8。
- 熔断时强制 `reason: "completed"` 收尾，**不抛错**（防止 hook 写错把整个 session 干崩）。

要点：
1. 读 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 环境变量（默认 8，0 表示禁用熔断）。
2. 计数器从 1 起算，到第 `cap+1` 次时强制结束 turn。
3. 给用户一个**带建议**的 warning：提示要检查 `stop_hook_active` 字段。
4. 上报遥测 `tengu_stop_hook_block_count` 区分 `hit_max_turns` 与 `hit_cap`。

#### zy-code 改动点

**文件**：[src/query.ts](file:///Users/zy979/IdeaProjects/zy-code/src/query.ts)

```diff
 type QueryState = {
   ...
   stopHookActive: boolean | undefined
+  stopHookBlockingCount: number     // 新增
   turnCount: number
   ...
 }
```

在第 1186 行附近的 stop hook blocking 分支：

```ts
// 在判定要进 stop_hook_blocking 之前
const nextBlockCount = (state.stopHookBlockingCount ?? 0) + 1
const capRaw = parseInt(process.env.ZY_CODE_STOP_HOOK_BLOCK_CAP ?? '', 10)
const cap = Number.isNaN(capRaw) ? 8 : capRaw
if (cap > 0 && nextBlockCount > cap) {
  // 注意 i18n key 走 hooks.ts 文件
  yield createWarning(
    tSync('hooks.stopHookBlockCapHit', { count: nextBlockCount }),
  )
  reportTelemetry('zy_stop_hook_block_count', {
    count: nextBlockCount,
    is_subagent: Boolean(toolUseContext.agentId),
    hit_cap: true,
  })
  return { reason: 'completed' }
}
// 否则正常 fallthrough，把 nextBlockCount 写入 state
state = {
  ...,
  stopHookActive: true,
  stopHookBlockingCount: nextBlockCount,
  transition: { reason: 'stop_hook_blocking' },
}
```

**i18n**：在 `src/i18n/locales/{en,zh-CN}/hooks.ts` 加 `stopHookBlockCapHit` key，含 `{count}` 插值。

**变量命名**：用 `ZY_CODE_STOP_HOOK_BLOCK_CAP`（与 Claude Code 不同前缀，避免误读环境）；可在文档里注明兼容 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`。

#### 测试

`tests/query/stopHookCap.test.ts`：
- mock 一个永远 block 的 stop hook，断言第 9 次直接 `reason: 'completed'`
- 设 `ZY_CODE_STOP_HOOK_BLOCK_CAP=2`，断言第 3 次熔断
- 设 `ZY_CODE_STOP_HOOK_BLOCK_CAP=0`，断言不熔断（兼容老行为）

---

### 3.2 `permissions.deny` 覆盖 PreToolUse hook 的 `"ask"`（2.1.101）

#### 现状

zy-code 的 PreToolUse hook 可以返回 `permissionDecision: 'ask'`，**这会下穿 `permissions.deny` 规则**——也就是说一个三方插件的 hook 能把组织级 deny 偷偷降级成 prompt，**这是一个真实的安全合规漏洞**。

Claude Code changelog：
> 2.1.101 – Fixed `permissions.deny` rules not overriding a PreToolUse hook's `permissionDecision: "ask"` — previously the hook could downgrade a deny into a prompt

#### Claude Code 二进制原文

Claude Code 内置 hook docs（offset `75634300`，给用户的官方说明）：

```
- `hookSpecificOutput` - Event-specific output (must include `hookEventName`):
  - `additionalContext` - Text injected into model context
  - `permissionDecision` - "allow", "deny", or "ask" (PreToolUse only)
  - `permissionDecisionReason` - Reason for the permission decision (PreToolUse only)
  - `updatedInput` - Modified tool input (PreToolUse only)
```

hook output 的 schema 校验位置（offset `119825027`，错误消息中可见枚举）：

```
Hook output does not start with {, treating as plain text

Expected schema:
  ...
  "approve" | "block"                                          (optional, deprecated)
  "allow" | "deny" | "ask"                                     (PreToolUse)
  "allow" | "deny" | "ask" | "defer"                          (PostToolUse / PostToolBatch)
  ...
Failed to parse hook output as JSON:
```

注意：Claude Code 的 PreToolUse `permissionDecision` **不允许 `defer`**——只在 PostToolUse 才有 `defer`。zy-code 现状对齐这一点即可。

CHANGELOG 2.1.101 原文：

> Fixed `permissions.deny` rules not overriding a PreToolUse hook's `permissionDecision: "ask"` — previously the hook could downgrade a deny into a prompt

#### 修复模式

**优先级链应当是**：`permissions.deny`（policy/managed）> hook decision > 默认 prompt。

#### zy-code 改动点

**文件**：[src/utils/hooks/executors/tool.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/tool.ts) + 调用 PreToolUse 的权限合并位置（搜 `permissionDecision` 引用点确定）。

伪代码：

```ts
function resolvePreToolUseDecision(
  hookOutput: PreToolUseHookSpecificOutput | undefined,
  permissions: PermissionConfig,
  toolName: string,
  toolInput: unknown,
): ResolvedDecision {
  const denyMatch = matchDenyRules(permissions.deny, toolName, toolInput)
  if (denyMatch) {
    // policy 优先，无论 hook 返回什么
    return { behavior: 'deny', reason: denyMatch.reason, source: 'policy' }
  }
  if (hookOutput?.permissionDecision === 'allow') return { behavior: 'allow', source: 'hook' }
  if (hookOutput?.permissionDecision === 'deny') return { behavior: 'deny', source: 'hook' }
  // 'ask' / undefined → 默认流程
  return { behavior: 'ask', source: 'default' }
}
```

#### 测试

`tests/hooks/permissionsDenyOverride.test.ts`：
- 配 `permissions.deny: ["Bash(rm *)"]` + 一个返回 `permissionDecision:"ask"` 的 PreToolUse hook
- 断言 `Bash(rm -rf /)` 直接 deny，不走 prompt

---

### 3.3 hook input 注入 effort（2.1.133）

#### 现状

zy-code 已经有 [`src/utils/effort.ts`](file:///Users/zy979/IdeaProjects/zy-code/src/utils/effort.ts) + `settings.effortLevel` + AppState 中的 effortLevel——但 [`createBaseHookInput()`](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/lifecycle.ts) 没有把它注入到 hook input。hook 脚本看不到当前 effort，无法做差异化逻辑（比如 low effort 时跳过昂贵的代码扫描类 hook）。

#### Claude Code 二进制原文

**Schema 定义**（offset `199705500`，`ow()` 是 Claude Code 内部 base hook input schema 工厂）：

```js
// === claude.exe @ ~0xBE65A04 ===
// 多个 hook event schema 都基于 ow() 扩展
bl5 = yH(() => ow().and(h.object({
  hook_event_name: h.literal("TeammateIdle"),
  teammate_name: h.string(),
  team_name: h.string(),
})));
Il5 = yH(() => ow().and(h.object({
  hook_event_name: h.literal("TaskCreated"),
  task_id: h.string(),
  task_subject: h.string(),
  task_description: h.string().optional(),
  ...
})));
```

**`ow()` 内部就含 `effort: { level: string }` 可选字段**（在 schema 描述里）：

```
effort.level — Active effort level for the current turn (e.g., "low",
"medium", "high", "xhigh", "max"), after any silent downgrade for the selected model.
```

**环境变量注入**（offset `94944576` 与 `101424690` 双处出现）：

```
CLAUDE_EFFORT
CLAUDE_CODE_SESSION_ID
```

这两个变量在 hook 子进程 spawn 时一起 export。还有模板字符串 `${CLAUDE_EFFORT}` 表明 hook 配置里的 `command` / `args` 字段支持变量插值。

#### zy-code 改动点

**文件 1**：[src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) `BaseHookInputSchema`：

```ts
export const BaseHookInputSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional().describe(...),
    agent_type: z.string().optional().describe(...),
    effort: z.object({
      level: z.string().describe(
        '当前 turn 生效的 effort 等级（已含模型 silent downgrade）。' +
        '可能值: "minimal" | "low" | "medium" | "high" | "max"',
      ),
    }).optional(),
  }),
)
```

同步更新 [src/types/hooks/payloads.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/payloads.ts) 的 `BaseHookInput` 类型。

**文件 2**：[src/utils/hooks/executors/lifecycle.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/lifecycle.ts) 的 `createBaseHookInput()`：

```ts
import { getEffortLevel } from 'src/state/AppStateStore.js'
import { resolveEffortForModel } from 'src/utils/effort.js'

function createBaseHookInput(permissionMode: string): BaseHookInput {
  const rawEffort = getEffortLevel()
  const model = getCurrentModel()
  const effective = rawEffort ? resolveEffortForModel(rawEffort, model) : undefined
  return {
    session_id: getSessionId(),
    transcript_path: getTranscriptPath(),
    cwd: process.cwd(),
    permission_mode: permissionMode,
    ...(effective && { effort: { level: effective } }),
  }
}
```

注意：必须用 **silent downgrade 后的实际 level**，不是用户设置的原始值。

**文件 3**：[src/utils/hooks/commandRunner.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/commandRunner.ts) 的子进程环境注入：

```ts
const env = {
  ...process.env,
  ZY_CODE_SESSION_ID: input.session_id,
  ...(input.effort?.level && { ZY_CODE_EFFORT: input.effort.level }),
}
```

#### 测试

`tests/hooks/effortInjection.test.ts`：
- 设 `effortLevel: 'high'`，断言 hook input 含 `effort.level: 'high'` 且 env 有 `ZY_CODE_EFFORT=high`
- 设一个不支持 max 的模型 + `effortLevel: 'max'`，断言 hook 收到 silent downgrade 后的值

---

### 3.4 Hook 输出超阈值落盘（2.1.89 / 2.1.97）

#### 现状

zy-code 的 hook stdout 直接灌进上下文（[src/utils/hooks/executors/tool.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/tool.ts) 中拼 `additionalContext`）。一个写错的 hook（比如 `cat 大日志`）能瞬间把上下文撑爆，触发 reactive compaction 甚至 OOM。

Claude Code changelog：
> 2.1.89 – Changed hook output over 50K characters to be saved to disk with a file path + preview instead of being injected directly into context

#### Claude Code 二进制原文

**Spill 模板字符串**（offset `89137888`，紧邻出现）：

```
Output too large ({bytes}). Full output saved to: {path}

Preview (first {previewBytes}):
{preview}

...
```

这就是 Claude Code 注入回上下文的真实内容——三段式：原始大小、磁盘路径、前缀预览。

**遥测**：`tengu_hook_output_too_large` 系列事件（offset `119909104` 邻近 hook 区有多处 `tengu_hook` 前缀）。

#### 实现模式

```ts
const HOOK_OUTPUT_INLINE_LIMIT = 50_000  // 字符（与 Claude Code 文档一致）

function maybeSpillHookOutput(
  hookName: string,
  output: string,
): { inline: string; spillPath?: string } {
  if (output.length <= HOOK_OUTPUT_INLINE_LIMIT) {
    return { inline: output }
  }
  const spillPath = path.join(getHookSpillDir(), `${hookName}-${Date.now()}.txt`)
  fs.writeFileSync(spillPath, output, 'utf8')
  const preview = output.slice(0, 2000)
  // 与 Claude Code 文案对齐
  return {
    inline: tSync('hooks.outputSpilled', {
      bytes: output.length,
      path: spillPath,
      previewBytes: preview.length,
      preview,
    }),
    spillPath,
  }
}
```

落盘目录：`~/.zy/hook-outputs/<sessionId>/`，跟随会话清理。

#### zy-code 改动点

- 新增 [src/utils/hooks/spillOutput.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/spillOutput.ts)（约 80 行）
- 在所有 `additionalContext` 拼接路径前过一遍 `maybeSpillHookOutput()`
- i18n key `hooks.outputSpilled` 含 `{bytes}` `{path}` `{preview}` 三个插值
- 加常量 `ZY_CODE_HOOK_OUTPUT_INLINE_LIMIT` 环境变量覆盖（默认 50000）

#### 测试

- 50001 字节 hook 输出，断言写盘 + 上下文里只剩前缀 + 提示
- 50000 字节 hook 输出，断言全部 inline，不落盘

---

## 4. P1 详细方案

### 4.1 `MessageDisplay` 事件（2.1.152）

#### Claude Code 二进制原文

**事件名及回调**（offset `128988500`）：

```
onStreamingDisplay
onMessageDisplay
newTurn
```

**Flush 失败回退**（offset `128995700`，错误消息原文）：

```
attachment
hook_non_blocking_error
hook_cancelled
Iterator result interface is not an object.
MessageDisplay hook flush ${name} failed; displaying original delta:
```

关键设计：
1. **双回调**：`onStreamingDisplay`（每个 delta）+ `onMessageDisplay`（整条消息完成）——流式与最终各一个拦截点。
2. **安全 fallback**：hook 抛错不会阻断消息显示——会重新显示原始 delta，需服务可用性与加工能力二选一时倒向服务可用性。
3. **non-blocking error 事件**：不抹黑 hook，下次还会试。

#### 价值

输出层最终拦截点：脱敏（密码/token 掩码）、敏感关键词折叠、UI 重排。zy-code 现有 hook 全在生成阶段拦，没有渲染阶段钩子。

#### 改动

1. [src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) 加 `MessageDisplay` 到 `HOOK_EVENTS` + 输入/输出 schema：

```ts
export const MessageDisplayHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(z.object({
    hook_event_name: z.literal('MessageDisplay'),
    message_id: z.string(),
    message_role: z.enum(['assistant', 'user', 'system']),
    text: z.string(),
  }))
)

export const MessageDisplayHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('MessageDisplay'),
    transformedText: z.string().optional(),
    hide: z.boolean().optional(),
  })
)
```

2. 新建 [src/utils/hooks/executors/messageDisplay.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/messageDisplay.ts)
3. 在 [src/components/messages](file:///Users/zy979/IdeaProjects/zy-code/src/components) 渲染入口（搜 `<AssistantMessage>` 或 markdown 渲染处）触发 hook 同步执行（必须是 sync，否则会闪现原文）

⚠️ 性能注意：MessageDisplay 在每条消息渲染时都会跑，**强烈建议** 加超时（500ms）+ 失败时跳过。

---

### 4.2 `updatedToolOutput` 推广到所有工具（2.1.121）

#### Claude Code 二进制原文

**双字段并存证据**（offset `99898784`，同一区段出现）：

```
updatedToolOutput
updatedMCPToolOutput
chainId
mcpServerType
queryChainId
```

**实际 schema 位置**（offset `100634976`）中看到几个关键字段名是拼接顺序出现的：

```
outcome=ok durationMs= text
structuredPatch content stdout
notebook_path tengu_tool_use_success
... updatedToolOutput d_output string attachment
```

表明 Claude Code 在 PostToolUse 的 `hookSpecificOutput` 同时提供：
- `updatedToolOutput`：面向所有工具的通用覆盖字段（string，会重写 model 看到的 tool result）
- `updatedMCPToolOutput`：MCP 工具专属（结构化，可携带 image / resource）

#### 现状

[src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) line 504-510：

```ts
export const PostToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().optional(),
    updatedMCPToolOutput: z.unknown().optional(),  // 仅 MCP
  }),
)
```

#### Claude Code

二进制 offset `99839456`：同时存在 `updatedToolOutput` 和 `updatedMCPToolOutput`，前者全工具适用。

#### 改动

加字段 `updatedToolOutput` 与 `updatedMCPToolOutput` 并存（兼容旧 hook），在 [src/utils/hooks/executors/tool.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/tool.ts) 应用顺序：`updatedToolOutput` 优先，回退 `updatedMCPToolOutput`。

---

### 4.3 `Stop`/`SubagentStop` 加 `background_tasks` + `session_crons`（2.1.145）

#### Claude Code 二进制原文

offset `119720500` 附近 schema 字段名连续出现：

```
background_tasks
session_crons
stop_hook_active
agent_transcript_path
extendedHookInput
```

`extendedHookInput` 表明 Claude Code 是把这些字段放在 Stop/SubagentStop input 的一个可选肃身里，而不是顶层——避免老 hook 看到额外字段时报 schema 错。zy-code 可以考虑同样拆分：

zy-code 已有：
- `src/services/background/`（后台任务）
- 推测有 cron 类似服务（搜 `cronTasks` 验证）

改动：[src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) 的 `StopHookInputSchema` / `SubagentStopHookInputSchema` 加：

```ts
background_tasks: z.array(z.object({
  id: z.string(),
  command: z.string(),
  status: z.enum(['running', 'pending']),
  pid: z.number().optional(),
})).optional(),
session_crons: z.array(z.object({
  id: z.string(),
  schedule: z.string(),
  next_run: z.string().optional(),
})).optional(),
```

[src/utils/hooks/executors/lifecycle.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/lifecycle.ts) 在构造 Stop input 时填充。

---

### 4.4 hook command 的 `args: string[]` exec form（2.1.139）

#### Claude Code 二进制原文

**内置错误提示文案**（offset `141698693`，这个字符串在用户填错 schema 时跳出）：

```
Command hooks require `command`. For exec form (no shell),
set `command` to the executable and `args` to its arguments:
  {"type": "command", "command": "echo", "args": ["hi"]}.
For shell form, set `command` to the full shell string:
  {"type": "command", "command": "echo hi"}.
```

另在 offset `80829506`、`123133520`、`194299789` 多处出现 "exec form" / "shell form" 关键字，表明这个定义被在多个代码路径中复用。

#### 现状

zy-code [src/utils/hooks/commandRunner.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/commandRunner.ts) 一律走 shell（`spawn('sh', ['-c', command])`）。配置示例：

```json
{ "type": "command", "command": "echo \"$CLAUDE_PROJECT_DIR/foo bar.txt\"" }
```

路径含空格必须转义，痛苦。

#### Claude Code 双形态

```json
// 1. shell form（旧）
{ "type": "command", "command": "echo $FOO" }

// 2. exec form（新，2.1.139）
{ "type": "command", "command": "/usr/bin/echo", "args": ["foo", "bar baz.txt"] }
```

#### 改动

[src/utils/hooks/hooksSettings.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/hooksSettings.ts) schema 加 `args` 字段（与 `command` 共存），[src/utils/hooks/commandRunner.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/commandRunner.ts) 分流：

```ts
if (hook.args !== undefined) {
  // exec form: 直接 spawn，不经 shell
  child = spawn(hook.command, hook.args, { env, stdio: [...] })
} else {
  // shell form: 兼容旧
  child = spawn(getDefaultShell(), ['-c', hook.command], { env, stdio: [...] })
}
```

---

### 4.5 hook output 的 `terminalSequence`（2.1.141）

让 hook 直接发桌面通知/响铃/窗口标题，不需要持有 TTY（hook 子进程 stdout 会污染 UI）。

#### Claude Code 二进制原文

offset `119826200` schema 字段顺序出现（`hookSpecificOutput` 完整出口）：

```
plainText
suppressOutput
terminalSequence
permissionDecision
permissionDecisionReason
  for PreToolUse
  for UserPromptSubmit
  for PostToolUse
  for PostToolBatch
```

并列证据表明 `terminalSequence` 是 hook 输出 schema 一等公民字段。`suppressOutput` 与其配套表明 Claude Code 允许 hook 同时决定“不走文本输出但发 OSC”。

#### 改动

[src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) 的 `SyncHookJSONOutputSchema` 加：

```ts
terminalSequence: z.string().optional()
  .describe('原始终端序列字符串，由 zy-code 主进程在 UI 安全位置写入 stdout（如 OSC 9; / 标题序列 / 响铃 \\x07）'),
```

执行端：[src/utils/hooks/executeEngine.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executeEngine.ts) 收到 hook 响应后，把 `terminalSequence` 通过 [src/ink/termio](file:///Users/zy979/IdeaProjects/zy-code/src/ink) 直接 write 到 stdout，避免与 Ink 重渲染冲突。

⚠️ 安全：必须做 escape sequence 校验，禁止 CSI 光标移动等可能破坏渲染的序列。仅放行：
- OSC 9; ... \\007（桌面通知）
- OSC 0; ... \\007（窗口标题）
- \\x07（响铃）
- OSC 9;4;... \\007（进度条）

---

## 5. P2/P3 简要方案

### 5.1 `PostToolUse.duration_ms`（P2，2.1.119）

[src/utils/hooks/executors/tool.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/tool.ts) 在 PostToolUse 触发处记录 `Date.now() - toolStartedAt`，扣除权限弹窗与 PreToolUse 时间。

### 5.2 `PostToolBatch` 事件（P2）

设计要点：当一轮里多个 tool_use 一起返回时，N 次 PostToolUse 后再触发一次 PostToolBatch，含整批 `tool_uses: Array<{tool_name, tool_use_id, status}>`。zy-code 有 parallel tool calls，这个事件能避免 hook N+1 抖动。

### 5.3 `UserPromptExpansion` 事件（P2）

在 `@mention`/`$var`/slash 命令展开**之后**、`UserPromptSubmit` **之前**。安全审计场景刚需（现在 zy-code 看不到 `@file` 实际注入的内容）。

### 5.4 `PermissionDenied.retry`（P3，2.1.89）

zy-code 已有 `PermissionDeniedHookSpecificOutputSchema.retry`，对齐到位，仅需文档化。

### 5.5 hook `type: "mcp_tool"`（P3，2.1.118）

让 hook 不必 spawn 子进程就能调 MCP 工具，性能更好。zy-code 有 [src/services/mcp/](file:///Users/zy979/IdeaProjects/zy-code/src/services/mcp)，可直接复用 MCP client，新增 [src/utils/hooks/execMcpToolHook.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/execMcpToolHook.ts)。

---

## 6. 实施里程碑

### Sprint 1：P0 安全与稳定性（1 个 PR）

- [ ] 3.1 Stop hook 熔断
- [ ] 3.2 deny 覆盖 ask
- [ ] 3.3 effort 注入
- [ ] 3.4 hook 输出落盘

**验收**：所有现有 hook 测试通过 + 4 个新增测试通过 + `bun tsc --noEmit` 无错。

### Sprint 2：P1 能力扩展（2 个 PR）

PR-A（schema 层）：
- [ ] 4.2 `updatedToolOutput`
- [ ] 4.3 background_tasks/session_crons
- [ ] 4.4 args exec form
- [ ] 4.5 terminalSequence

PR-B（事件层）：
- [ ] 4.1 MessageDisplay

**验收**：含手动验证—— `terminalSequence` 必须在真实 iTerm2/Windows Terminal/VS Code 终端里测过桌面通知。

### Sprint 3：P2/P3 增量

按业务驱动，不强制集中落。每个能力一个独立 PR。

---

## 7. 不做的事

明确**不**对齐的 Claude Code 行为，避免 reviewer 反复问：

| Claude Code 行为 | 不做原因 |
|---|---|
| `MessageDisplay` 用 OSC sequence 重排 UI | zy-code 用 Ink 渲染，与 OSC 冲突；只支持 transformedText/hide |
| `pluginSuggestionMarketplaces` 等 marketplace hook 治理 | zy-code 没有等价的 marketplace 概念 |
| `claude-ai`/`console` 双登录模式 hook 过滤 | zy-code 的 provider 模型不同 |
| `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` 等克隆策略 hook | 不属于 hook 系统范畴 |

---

## 8. 引用与证据

### 8.1 二进制定位表

以下偏移量针对 Claude Code v2.1.158 (`~/.nvm/.../@anthropic-ai/claude-code/bin/claude.exe`，205MB esbuild bundle)。其他版本偏移会变，但字符串常量不变，可用 `grep -aob '<keyword>' claude.exe` 重新定位。

| 本文章节 | 关键字 | offset (decimal) | 用途 |
|---|---|---|---|
| 3.1 Stop cap | `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | 106753145 / 203838143 | env 名与实现体 |
| 3.1 Stop cap | `tengu_stop_hook_block_count` | (邻接 203838143) | 遥测事件 |
| 3.2 deny override | `permissionDecision` schema docs | 75634300 | 官方 hook docs 原文 |
| 3.2 deny override | hook output schema 校验 | 119825027 | 枚举 `"allow"\|"deny"\|"ask"\|"defer"` |
| 3.3 effort | `effort.level` schema | 115969799 / 199705500 | base hook input schema |
| 3.3 effort | `CLAUDE_EFFORT` env | 94944576 / 101424690 | 子进程 env 变量 |
| 3.3 effort | `${CLAUDE_EFFORT}` template | 101424690 | hook config 插值 |
| 3.4 spill | `Output too large … saved to:` | 89137888 | inline 模板 |
| 3.4 spill | `Spilled` 词 | 65305879+ | 内部状态名 |
| 3.4 spill | `tengu_hook` 遥测前缀 | 119909104 | 事件名名空间 |
| 4.1 MessageDisplay | `onStreamingDisplay` / `onMessageDisplay` | 128988500 | 双回调 |
| 4.1 MessageDisplay | `MessageDisplay hook flush … failed` | 128995700 | fallback 错误消息 |
| 4.2 updatedToolOutput | `updatedToolOutput` / `updatedMCPToolOutput` | 99839456 / 99898784 / 100634976 | 双字段并存 |
| 4.3 background_tasks | schema 字段名连续出现 | 119720500 | Stop/SubagentStop 肃身 |
| 4.4 args exec form | `Command hooks require...` docs | 141698693 | schema 错误提示 |
| 4.4 args exec form | `exec form` / `shell form` 多处 | 80829506 / 123133520 / 194299789 | 多路径复用证据 |
| 4.5 terminalSequence | hookSpecificOutput 出口字段列 | 119826200 | schema 一等公民 |

### 8.2 外部参考

- Claude Code CHANGELOG raw：<https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md>
- Hooks docs：`https://code.claude.com/docs/en/hooks#exec-form-and-shell-form`

### 8.3 zy-code 现状关键文件

- [src/utils/hooks/](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks)（34 个文件）
  - [executors/lifecycle.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/lifecycle.ts) — Stop/SubagentStop/SessionStart/End 触发入口
  - [executors/tool.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executors/tool.ts) — PreToolUse/PostToolUse 与权限决策
  - [commandRunner.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/commandRunner.ts) — 子进程 spawn
  - [executeEngine.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/hooks/executeEngine.ts) — 多 hook 编排与 merge
- [src/types/hooks/schemas.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/schemas.ts) — 27 个事件 schema
- [src/types/hooks/payloads.ts](file:///Users/zy979/IdeaProjects/zy-code/src/types/hooks/payloads.ts) — TS payload 类型
- [src/query.ts](file:///Users/zy979/IdeaProjects/zy-code/src/query.ts)（stop hook 现状在 line 1186 附近，没有熔断）
- [src/utils/effort.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/effort.ts) — effort 数据已齐备，差最后一步注入 hook input
- [src/utils/settings/applySettingsChange.ts](file:///Users/zy979/IdeaProjects/zy-code/src/utils/settings/applySettingsChange.ts) — effort 在 settings 与 AppState 间同步逻辑参考

