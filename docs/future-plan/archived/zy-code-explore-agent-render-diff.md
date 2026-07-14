# zy-code Explore Agent 与 Claude Code 差异（含渲染层）

> 验证方式：对 Claude CLI 二进制（`@anthropic-ai/claude-code/bin/claude.exe`，version `2.1.160`，build `de93a1b1...`）进行 `grep -aob` + `dd` 提取，与 zy-code 源码逐项比对。

---

## 1. Agent 定义层（业务逻辑）

### 1.1 字段对照

| 字段 | Claude Code (binary `e6H`) | zy-code (`EXPLORE_AGENT`) | 差异 |
|---|---|---|---|
| `agentType` | `"Explore"` | `"Explore"` | 一致 |
| `whenToUse` | 长文案（`mo5`） | `EXPLORE_WHEN_TO_USE` | **逐字相同** |
| `whenToUseLean` | 长文案（`po5`） | `EXPLORE_WHEN_TO_USE_LEAN` | **逐字相同** |
| `disallowedTools` | 5 项（Agent/ExitPlan/Edit/Write/NotebookEdit） | 5 项相同 | 一致 |
| `source` / `baseDir` | `"built-in"` / `"built-in"` | 同 | 一致 |
| `model` | `"haiku"`（fallback） | `isInternalBuild() ? 'inherit' : 'compact'` | **差异 1** |
| `omitClaudeMd` / `omitAgentsMd` | `true` | `true` | 一致（命名差异） |
| Model GrowthBook flag | `tengu_quartz_heron` 切到 `inherit` | `zy_explore_agent`（注释说） | **差异 2** |
| PowerShell 分支白/黑名单 | 完整存在 | 完整存在 | **逐字相同** |
| 系统 prompt 主体（READ-ONLY/strengths/guidelines） | 完整 | 完整 | 仅署名差异（`Claude Code, Anthropic` vs `ZY Code`） |

→ **业务定义层**已完全对齐，默认 model 也是等价的（`compact` 对应 Claude 的 `haiku`，有意分化命名）：

```js
// Claude binary (uo5 上下文)
function KOH(H) {
  if (H.agentType !== e6H.agentType) return H.model
  return W_("tengu_quartz_heron", !1) ? "inherit" : "haiku"  // 默认 haiku
}
```

```ts
// zy-code exploreAgent.ts:95
model: isInternalBuild() ? 'inherit' : 'compact',
```

Claude Code 普通用户拿到的是 `haiku`，zy-code 普通用户拿到的是 `compact`——两者是**有意的对应关系**（`compact` 即 zy-code 对 `haiku` 的本地化命名/路由），能力定位一致，非差异点。

### 1.2 二进制证据（偏移 `200,302,924` 起）

```js
e6H = {
  agentType: "Explore",
  whenToUse: mo5,
  whenToUseLean: po5,
  disallowedTools: [H9, JG, HK, q1, kG],
  source: "built-in",
  baseDir: "built-in",
  model: "haiku",
  omitClaudeMd: !0,
  getSystemPrompt: () => uo5()
}
```

`uo5()` 内部根据 `W1()`（PowerShell gate）和 `lX()`（embedded search tools gate）切换 `find/grep` vs `Glob/Grep`、Bash vs PowerShell 工具名 + 白/黑名单。**与 [`getExploreSystemPrompt`](../../src/tools/AgentTool/built-in/exploreAgent.ts#L16-L70) 1:1 对应**。

---

## 2. 渲染层（UI）

### 2.1 颜色主题（8 色 `*_FOR_SUBAGENTS_ONLY`）

| 文件 | 内容 |
|---|---|
| [`agentColorManager.ts`](../../src/tools/AgentTool/agentColorManager.ts#L14-L34) | `red/blue/green/yellow/purple/orange/pink/cyan` 8 色映射 |
| [`theme.ts:40-152`](../../src/utils/theme.ts#L40-L152) | 主题层定义 RGB 值 |

Claude binary 中 `red_FOR_SUBAGENTS_ONLY` 等 8 个 key 全部命中（`grep -aob` 偏移 `159,853,808` 起连续 8 处）→ **完全对齐**。

### 2.2 `task_progress` SDK 事件 schema

zy-code 已实现的 schema：

```ts
// src/services/task/taskProgress.ts
{
  type: 'system',
  subtype: 'task_progress',
  task_id, tool_use_id, subagent_type,
  tool_uses, last_tool_name, summary, workflow_progress
}
```

Claude binary 偏移 `93,129,744` 处的字段名串：

```
subagentType  toolUses  tool_uses
lastToolName  last_tool_name
workflowProgress  workflow_progress  hook_progress
... agent_progress
```

**字段命名、camelCase / snake_case 双形式、嵌套结构全部一致** → 渲染层 SDK 流事件契约已对齐。

### 2.3 Task tool 卡片渲染

| 元素 | Claude binary | zy-code |
|---|---|---|
| 完成标签 | `Done (` + `1 tool use` / ` tool uses` + ` tokens` | [`UI.tsx:570`](../../src/tools/AgentTool/UI.tsx) 同款 `Done (N tool uses)` |
| 切换转录快捷键 | `app:toggleTranscript` / `ctrl+o` / `expand` | 一致（keybindings 注册） |
| Backgrounded / Remote 标签 | `Remote agent launched` / `Backgrounded agent` / `async_launched` | RemoteAgentTask + LocalAgentTask 双轨 |
| 进度组件 | `AgentProgressSummary` | [`AgentProgressLine`](../../src/components/AgentProgressLine.tsx) + [`AgentSessionView.getProgressSummary`](../../src/components/agents/AgentSessionView.tsx#L72) |
| Spinner 树 | Subagents 多实例并发渲染 | [`TeammateSpinnerTree`](../../src/components/Spinner/TeammateSpinnerTree.tsx) |

### 2.4 进度摘要（SDK Agent Progress Summary）

Claude binary 中存在：

```
getSdkAgentProgressSummariesEnabled
setSdkAgentProgressSummariesEnabled
```

zy-code 这边对应：

| 文件 | 角色 |
|---|---|
| 历史全局状态文件（现已按领域拆分） | getter / setter |
| [`cli/headless/controlLoop.ts:694`](../../src/cli/headless/controlLoop.ts#L694) | Headless 模式默认开启 |
| [`tasks/local-agent-task/LocalAgentTask.tsx:454`](../../src/tasks/local-agent-task/LocalAgentTask.tsx#L454) | `captured && getSdkAgentProgressSummariesEnabled()` 触发摘要 |
| [`services/AgentSummary/agentSummary.ts`](../../src/services/AgentSummary/agentSummary.ts) | "1-2 句进度摘要" 生成器 |

→ Hook 点 + 默认开关 + 摘要生成全链路对齐。

---

## 3. Claude Code 渲染层最近的改动方向

从 binary 字符串 + 字段命名推断出的几条新动向：

### 3.1 Subagent Transcript 持久化与回放

binary 中存在密集的：

```
SubagentTranscripts        SubagentEventReader        SubagentInternalEvents
SubagentStartHooks         loadAllSubagentTranscriptsFromDisk
```

→ Claude Code 把 subagent 的全程消息流落盘，主线程可以"重新打开"任意 subagent 的完整 transcript（独立窗格）。zy-code 已经有 [`agentMemorySnapshot.ts`](../../src/tools/AgentTool/agentMemorySnapshot.ts)、[`forkSubagent.ts`](../../src/tools/AgentTool/forkSubagent.ts)、[`resumeAgent.ts`](../../src/tools/AgentTool/resumeAgent.ts) 三件套，能力上对齐，但 UI 层面 Claude 似乎把 transcript 切换升格成主流程的 toggle（`app:toggleTranscript` / `ctrl+o`）。

### 3.2 Hook 体系扩展到 subagent

binary 中相邻字符串：

```
SubagentStartHooks  executeStopHooks  executePostToolBatchHooks
executePermissionRequestHooks  executePermissionDeniedHooks
executeMessageDisplayHooks  executeInstructionsLoadedHooks
```

→ subagent 的 lifecycle hook 已经和主线程对齐；`PermissionRequest` / `PermissionDenied` / `MessageDisplay` / `InstructionsLoaded` 都是 Claude 较新加入的事件名，zy-code 这边需要核对 hook registry 是否同步。

### 3.3 Workflow 进度作为一等公民

`task_progress` 事件多出 `workflow_progress: WireWorkflowProgress[]` 字段，binary 同样存在。zy-code 已经在 [`types/wire/messageSchemas.ts:517-519`](../../src/types/wire/messageSchemas.ts#L517-L519) 定义了对应 schema。这是**为 IDE / VS Code panel 实时显示工作流分阶段进度**而加的。

### 3.4 进度摘要由模型小步生成

`getSdkAgentProgressSummariesEnabled` + `Thinking` 多次出现的偏移挨在一起，再对照 zy-code 的 [`agentSummary.ts`](../../src/services/AgentSummary/agentSummary.ts)（"1-2 句进度摘要"），可以确认 Claude 现在采用的方案是：

> 主 agent 周期性发一段非常短的 thinking 给一个轻量子模型（`haiku`），把 subagent 当前的工具使用轨迹压缩成一句话，写入 `task_progress.summary` 字段，UI 显示。

zy-code 实现完全相同，且 explore agent 默认走 `compact` 模型也吻合"用便宜模型生成摘要"的设计。

---

## 4. 收敛建议

### 4.1 中优（UI 体验差）

- **核对 ctrl+o 切换 transcript**：确认 [`keybindings/`](../../src/keybindings/) 中的 `app:toggleTranscript` 已注册并指向 `ctrl+o`，与 Claude 默认绑定一致。
- **subagent hook 命名**：确认 [`hooks/`](../../src/hooks/) 中的 `PermissionRequest` / `PermissionDenied` / `MessageDisplay` / `InstructionsLoaded` 4 个事件名都已实现并在 subagent 内部 dispatch。

### 4.2 低优（可观测性）

- **GrowthBook flag 命名同步**：注释里"`zy_explore_agent`" → 校对 flag 是否真的注册；Claude 的 `tengu_quartz_heron` 是 internal-only flag，zy-code 不必复用。

---

## 5. 验证用 grep 命令（可复现）

```bash
CLAUDE_BIN="$(dirname "$(readlink -f "$(which claude)")")/claude.exe"

# explore agent 对象（whenToUseLean 是稳定锚点）
grep -aob 'whenToUseLean' "$CLAUDE_BIN" | head -5
LC_ALL=C dd if="$CLAUDE_BIN" bs=1 skip=200298000 count=8000 2>/dev/null \
  | LC_ALL=C tr -d '\0'

# task_progress SDK 事件 schema
grep -aob 'subagentType' "$CLAUDE_BIN" | head -3
LC_ALL=C dd if="$CLAUDE_BIN" bs=1 skip=93128000 count=3500 2>/dev/null \
  | LC_ALL=C tr -d '\0'

# 8 色主题
grep -aob 'red_FOR_SUBAGENTS_ONLY' "$CLAUDE_BIN" | head -3

# subagent transcript / hook 体系
grep -aob 'SubagentTranscripts' "$CLAUDE_BIN" | head -3
grep -aob 'SubagentStartHooks' "$CLAUDE_BIN" | head -3
```

--

## 6. 主界面卡片缺失：BackgroundHint 抢占了 tool_use 渲染区

**用户复现现象**

Claude Code 主界面（折叠态）：
```
⏺ Explore(查找 Explorer agent prompt)
  ⎿  Done (10 tool uses · 65.3k tokens · 49s)
  (ctrl+o to expand)
```

zy-code 主界面（同一时刻）：
```
⏺ 好的，你问的是用户能否自定义扩展 工具（tool） 和 提示词（prompt） 这类能力。让我看看现有的扩展机制。
     （ctrl+b 后台运行）
```

`⏺ Explore(...)` 工具调用卡片 + `⎿ Done` 结果卡片**整个消失**了，只剩一行 `（ctrl+b 后台运行）`。

**根因定位**

[AgentTool.tsx:1133-1150](../../src/tools/AgentTool/AgentTool.tsx)：

```ts
const PROGRESS_THRESHOLD_MS = 2000  // Show background hint after 2 seconds
// ...
if (
  !isBackgroundTasksDisabled &&
  !backgroundHintShown &&
  elapsed >= PROGRESS_THRESHOLD_MS &&
  toolUseContext.setToolJSX
) {
  backgroundHintShown = true
  toolUseContext.setToolJSX({
    jsx: <BackgroundHint />,             // ← 来自 BashTool/UI.tsx
    shouldHidePromptInput: false,
    shouldContinueAnimation: true,
    showSpinner: true,
  })
}
```

subagent 跑超过 2 秒后，`setToolJSX(<BackgroundHint />)` 把 REPL 的 tool 渲染插槽（[ReplTranscriptView.tsx:177-181](../../src/screens/repl/ReplTranscriptView.tsx)）**整体替换**成只显示 `(ctrl+b 后台运行)` 一行的极简组件 [BackgroundHint](../../src/tools/BashTool/UI.tsx)。

这个组件的本意是 BashTool 长任务提示，被 AgentTool 直接复用，导致：

1. **`⏺ Explore(查找 ...)` 卡片不渲染**——`renderToolUseMessage` 输出的工具调用头部被 BackgroundHint 顶掉。
2. **`⎿ Done (N tool uses · ...)` 卡片也消失**——子 agent 完成时仍处在 toolJSX 占位状态，Done 卡片在折叠态被压没。
3. **进度行（树枝符 + 状态）一并被压**——[AgentProgressLine](../../src/components/AgentProgressLine.tsx) 走的是消息流渲染管线，被 toolJSX 顶替后看不到。

而 Claude Code 的 binary 中 Task 工具调用走标准的 tool_use 卡片渲染，不会去抢占额外的 UI 插槽，并且没有"超过 N 秒就把整张卡片换成后台提示"这条逻辑——它把 `(ctrl+o to expand)` 作为 Done 卡片的副文本一起渲染，而不是劫持渲染区。

**最小改动建议**

方案 A（保留 BackgroundHint 但不抢占主区）：
- `BackgroundHint` 改为通过 `progressMessages` 推一条 hint message 进消息流，让其与 `AgentProgressLine` 同列出现，而非覆盖 toolJSX。
- 或者在 [renderGroupedAgentToolUse](../../src/tools/AgentTool/UI.tsx) 头部 `Running 1 Explore agents` 行末尾追加 `<KeyboardShortcutHint shortcut="ctrl+b" action="background" parens />`，复刻 `(ctrl+o to expand)` 的形式。

方案 B（移除 toolJSX 抢占）：
- 删除 [AgentTool.tsx:1137-1150](../../src/tools/AgentTool/AgentTool.tsx) 的 `setToolJSX(<BackgroundHint />)` 调用，让 Task tool 走与 Claude 同样的标准 tool_use 渲染管线。
- 后台能力本身（ctrl+b 触发 `task:background` keybinding）在 [BackgroundHint.useKeybinding](../../src/tools/BashTool/UI.tsx) 已注册，与 UI 显示解耦：keybinding 仍在监听，只是不再显示提示条。如要保留提示，单独挂在树枝行末尾即可。

**推荐方案 B + 头部尾随提示**：去掉 toolJSX 抢占，在 [renderGroupedAgentToolUse](../../src/tools/AgentTool/UI.tsx) 头部已有的 `<CtrlOToExpand />` 旁边并列加一个 `<CtrlBToBackground />`，效果与 Claude 形态一致：
```
⏺ Running 1 Explore agents (ctrl+o to expand) (ctrl+b to background)
   └─ Explore · 5 tool uses · 12,345 tokens
      ⏿  Searching for explore agent prompt
```

**验证**

```bash
# 确认 toolJSX 抢占链路
rg -n 'setToolJSX.*BackgroundHint' src/tools/AgentTool/

# 确认 BackgroundHint 是 BashTool 借用的
rg -n 'export function BackgroundHint' src/

# 确认 Claude binary 没有 "BackgroundHint" / "ctrl+b background" 渲染分支
grep -aob 'BackgroundHint' "$CLAUDE_BIN"      # 预期 0
grep -aob 'ctrl+b' "$CLAUDE_BIN" | head -3   # 预期 0 或仅 tmux/keybinding 文档
```

---

## 7. 落地改动清单（推荐方案 B + 头部尾随提示）

### 改动 1：移除 toolJSX 抢占

**文件**：[src/tools/AgentTool/AgentTool.tsx](../../src/tools/AgentTool/AgentTool.tsx)

**位置**：1132-1150 行（while 循环内的 BackgroundHint 注入分支）

**改前**：
```ts
while (true) {
  const elapsed = Date.now() - agentStartTime

  // Show background hint after threshold (but task is already registered)
  // Skip if background tasks are disabled
  if (
    !isBackgroundTasksDisabled &&
    !backgroundHintShown &&
    elapsed >= PROGRESS_THRESHOLD_MS &&
    toolUseContext.setToolJSX
  ) {
    backgroundHintShown = true
    toolUseContext.setToolJSX({
      jsx: <BackgroundHint />,
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
      showSpinner: true,
    })
  }

  // Race between next message and background signal
  // ...
```

**改后**：
```ts
while (true) {
  // ctrl+b 后台化由 task:background keybinding 直接监听（在 BackgroundHint
  // 中 useKeybinding 注册），UI 提示挪到 renderGroupedAgentToolUse 头部，
  // 与 Claude Code 的 "(ctrl+o to expand)" 副文本形态对齐。这里不再
  // 通过 setToolJSX 抢占主渲染区，避免覆盖 ⏺ Explore(...) / ⎿ Done 卡片。

  // Race between next message and background signal
  // ...
```

同时删除文件顶部不再使用的 `BackgroundHint` 与 `PROGRESS_THRESHOLD_MS` 引用：
- 检查 `import { BackgroundHint } from '../BashTool/UI.js'` 是否还有其他引用，若无则删除。
- `PROGRESS_THRESHOLD_MS` 常量若仅在此处使用，一并删除；同时删除局部变量 `backgroundHintShown`、`elapsed`（若仅服务此分支）。

### 改动 2：在头部并列显示 ctrl+b 提示

**文件**：[src/tools/AgentTool/UI.tsx](../../src/tools/AgentTool/UI.tsx)

**位置**：renderGroupedAgentToolUse 头部的 `{!allAsync && <CtrlOToExpand />}`（约 910 行）

**改前**：
```tsx
<Text>
  {allComplete ? ( ... ) : (
    <>
      {tSync('agent.runningPrefix')} <Text bold>{toolUses.length}</Text>{' '}
      {commonType
        ? tSync('agent.runningAgents', { count: toolUses.length, type: `${commonType} agents` })
        : tSync('agent.runningAgentsNoType', { count: toolUses.length })}
    </>
  )}{' '}
</Text>
{!allAsync && <CtrlOToExpand />}
```

**改后**：在 `<CtrlOToExpand />` 旁边并列加 `<CtrlBToBackground />`，仅在前台、非禁用且未后台化时显示：
```tsx
{!allAsync && (
  <>
    <CtrlOToExpand />
    {anyUnresolved && !isBackgroundTasksDisabled() && <CtrlBToBackground />}
  </>
)}
```

其中：
- `<CtrlBToBackground />` 是新增的极简组件，套 `KeyboardShortcutHint`：
  ```tsx
  function CtrlBToBackground() {
    const shortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b')
    return (
      <Text dimColor>
        {' '}
        <KeyboardShortcutHint shortcut={shortcut} action="background" parens />
      </Text>
    )
  }
  ```
- `isBackgroundTasksDisabled()` 即原来 [AgentTool.tsx](../../src/tools/AgentTool/AgentTool.tsx) 顶部的 `isEnvTruthy(process.env.ZY_CODE_DISABLE_BACKGROUND_TASKS)` 检查，提取成共享 helper 复用。
- 单 agent 行尾形态：
  ```
  ⏺ Running 1 Explore agents (ctrl+o to expand) (ctrl+b to background)
  ```

### 改动 3：i18n key 注册

**文件**：[src/i18n/locales/zh-CN/misc.ts](../../src/i18n/locales/zh-CN/misc.ts) / [src/i18n/locales/en/misc.ts](../../src/i18n/locales/en/misc.ts)

现有 `shortcut.background` 已存在（zh-CN: "后台运行"、en: "run in background"），`KeyboardShortcutHint.action="background"` 复用即可，**无需新增 key**。需要在 [actionKeyMap](../../src/components/KeyboardShortcutHint.tsx) 中确认 `background` action 已注册。

### 改动 4：keybinding 自检

`task:background` keybinding 在 [BackgroundHint](../../src/tools/BashTool/UI.tsx) 中通过 `useKeybinding('task:background', ..., { context: 'Task' })` 注册。BashTool 自身的长任务场景仍然渲染 `<BackgroundHint />`，所以这个 keybinding 注册并不会丢。AgentTool 路径下，由于不再渲染 `<BackgroundHint />`，需要在 AgentTool 的某处独立注册 `task:background`，或在 [renderGroupedAgentToolUse](../../src/tools/AgentTool/UI.tsx) 中复用一次 `useKeybinding`：

```tsx
useKeybinding(
  'task:background',
  () => backgroundAll(() => store.getState(), setAppState),
  { context: 'Task' },
)
```

挂在 `renderGroupedAgentToolUse` 顶层组件中即可，确保 ctrl+b 在 subagent 跑的时候依然生效。

### 验证步骤

```bash
# 1. 类型校验
bun tsc --noEmit

# 2. 启动开发模式跑一个 Explore subagent（需要至少 3-5 秒的任务）
bun src/entrypoints/cli.tsx
# 在 REPL 中输入："用 Explore agent 找出 src/tools/AgentTool 下所有导出的类型"

# 3. 预期看到：
#    ⏺ Running 1 Explore agents (ctrl+o to expand) (ctrl+b to background)
#       └─ Explore · 5 tool uses · 12,345 tokens
#          ⏿  Searching for ...
# 完成后：
#    ⏺ 1 Explore agents finished (ctrl+o to expand)
#       └─ Explore · 10 tool uses · 65k tokens · Done

# 4. 按 ctrl+b，应进入后台任务列表
# 5. 按 ctrl+o，应展开 transcript
```

### 风险与回滚

- **风险 A**：`<BackgroundHint />` 的 `shouldHidePromptInput: false` / `showSpinner: true` 这些 toolJSX 副作用被移除后，spinner 显示策略可能改变。需要核对 [ReplMainView.tsx:493](../../src/screens/repl/ReplMainView.tsx) 的 spinner 公式 `(!toolJSX || toolJSX.showSpinner === true) && isLoading`：移除 toolJSX 后，`!toolJSX` 为 true，spinner 仍然按 `isLoading` 显示，行为不变。
- **风险 B**：旧用户依赖那条 `(ctrl+b 后台运行)` 提示找到后台化入口。改动后提示仍在，只是位置从工具调用区挪到 `Running N Explore agents` 行末尾，与 `(ctrl+o to expand)` 并列。
- **回滚**：保留 `import { BackgroundHint }` 和 `PROGRESS_THRESHOLD_MS` 常量，回退 1132-1150 行恢复旧分支即可。改动局限在两个文件，无数据迁移。

--

## 8. Subagent 折叠视图中 Bash/Update 工具始终可见（`briefStandalone`）

**用户复现现象**

Claude Code 在 Explore subagent 跑的过程中，**即使在折叠视图**也会直接显示 Bash 和 Update 的摘要行：

```
⏺ Bash(mvn compile -pl helper-basic-service -am -q 2>&1 | tail -3)
  ⎿  main_end:2026-06-03T14:25:28+08:00
  ⎿  (timeout 3m)

⏺ Update(helper-basic-service/src/main/java/com/alitrip/btriphelper/service/program/dto/StoreRouteItemDTO.java)
  ⎿  Added 2 lines, removed 2 lines
```

以前这些内容只有在 ctrl+o 展开 transcript 后才可见。现在是**默认可见**。

**根因定位**

Claude binary 中的消息折叠算法 `akK`（偏移 `205,898,500` 起）有一段关键逻辑：

```js
// 从后向前遍历所有 tool_use，每种工具名只保留最后一次调用
for (let W = z - 1; !A && W >= T; W--) {
  let Z = H[W];
  if (Z.type !== "assistant") continue;
  let G = Z.message.content[0];
  if (G?.type !== "tool_use" || j.has(G.name)) continue;
  // ↓ 关键：如果工具有 briefStandalone=true，则豁免折叠
  if (j.add(G.name), h4(_, G.name)?.briefStandalone) {
    w.add(W);  // 保留此 tool_use
    // 同时保留对应的 tool_result
    for (let L = W + 1; L < z; L++) {
      let k = H[L];
      if (k.type === "assistant") break;
      if (k.type !== "user") continue;
      let v = k.message.content[0];
      if (v?.type === "tool_result" && v.tool_use_id === G.id) {
        w.add(L); break;
      }
    }
  }
}
```

`briefStandalone` 是**工具定义对象**上的布尔属性（偏移 `104,985,808`）。标记为 `true` 的工具在 brief/折叠视图中**不会被折叠到计数摘要中**，而是作为独立行保留。

至少 Bash 和 Update（FileEdit）工具被标记为 `briefStandalone: true`。

**zy-code 当前行为**

[AgentTool/UI.tsx:565-567](../../src/tools/AgentTool/UI.tsx)：

```ts
const displayedMessages = isTranscriptMode
  ? processedMessages
  : processedMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW)  // MAX = 3
```

subagent progress 视图只简单取最后 3 条消息显示，其余全部折叠为 "N more tool uses (ctrl+o to expand)"。没有按工具类型进行"豁免"判断。

**对比**

| | Claude Code | zy-code |
|---|---|---|
| 折叠策略 | 按工具属性 `briefStandalone` 豁免关键工具 | 简单取最后 3 条 |
| Bash 可见性 | **最后一次** Bash 调用始终可见 | 仅恰好在最后 3 条时才可见 |
| Update 可见性 | **最后一次** Update 始终可见 | 同上 |
| Tool 接口属性 | `briefStandalone?: boolean` | 不存在 |
| 折叠算法位置 | 主折叠函数 `akK` | `processProgressMessages` |

**对齐改动建议**

1. **Tool 接口新增属性**：[Tool.ts:392](../../src/Tool.ts) 附近加 `briefStandalone?: boolean`
2. **标记关键工具**：BashTool、FileEditTool、FileWriteTool 设为 `briefStandalone: true`
3. **修改 subagent 折叠算法**：[AgentTool/UI.tsx:processProgressMessages](../../src/tools/AgentTool/UI.tsx) 中，在 `slice(-3)` 之前，先从后向前扫描 progress messages，对每种 `briefStandalone` 工具保留最后一次 tool_use + tool_result 独立行
4. **主线程折叠算法对齐**：[collapseReadSearch.ts:collapseReadSearchGroups](../../src/utils/collapseReadSearch.ts) 中，对 `briefStandalone` 工具在折叠分组时保留为独立行（目前 Bash/FileEdit 在非全屏模式下已是 `isCollapsible: false`，此项可能已部分满足）

**验证**

```bash
# 确认 Claude binary 中 briefStandalone 存在
CLAUDE_BIN="$(dirname "$(readlink -f "$(which claude)")")/claude.exe"
grep -aob 'briefStandalone' "$CLAUDE_BIN"  # 预期 2 处

# 确认 zy-code 当前无此属性
rg 'briefStandalone' src/  # 预期 0 结果
```

---

## 附：核心结论一句话

> **Explore Agent 业务定义已经 1:1 对齐**（whenToUse / whenToUseLean / PowerShell 分支 / disallowedTools / 系统 prompt 全部逐字相同），默认 `model` 是等价对应（`compact` = Claude 的 `haiku`，有意分化）。**渲染层** 颜色主题、SDK `task_progress` 事件 schema、Done 卡片、转录切换、进度摘要管线都已经对齐；Claude 近期加的 `workflow_progress` 字段、新版 subagent hook 命名、ctrl+o 切换 transcript 也都能在 zy-code 找到对应实现。**仍存在的 4 处显著渲染差距**：(1) 缺少从 assistant 流式文本中抽取活动短语（`Exploring/Searching/...`）的管线；(2) 单 subagent 时 `hideType=true` 把 `Explore` 类型标签隐藏；(3) 跑超 2 秒后 `setToolJSX(<BackgroundHint />)` 抢占主渲染区，导致 `⏺ Explore(...)` + `⎿ Done` 标准卡片完全消失，只剩 `(ctrl+b 后台运行)` 一行；(4) subagent 折叠视图缺少 `briefStandalone` 工具豁免机制，Bash/Update 等关键工具调用被折叠为计数摘要而非独立行显示。
