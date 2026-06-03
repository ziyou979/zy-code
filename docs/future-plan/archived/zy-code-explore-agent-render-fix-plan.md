# Explore Subagent 主界面卡片缺失修复方案

## 背景

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

## 根因

[AgentTool.tsx:1133-1150](../../src/tools/AgentTool/AgentTool.tsx) 在 subagent 跑超过 `PROGRESS_THRESHOLD_MS = 2000` 后调用 `setToolJSX(<BackgroundHint />)`，把 REPL 的 tool 渲染插槽（[ReplTranscriptView.tsx:177-181](../../src/screens/repl/ReplTranscriptView.tsx)）**整体替换**成 BashTool 借用过来的极简后台提示组件 [BackgroundHint](../../src/tools/BashTool/UI.tsx)。

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
    jsx: <BackgroundHint />,
    shouldHidePromptInput: false,
    shouldContinueAnimation: true,
    showSpinner: true,
  })
}
```

后果：
1. **`⏺ Explore(查找 ...)` 卡片不渲染**——`renderToolUseMessage` 输出的工具调用头部被 BackgroundHint 顶掉。
2. **`⎿ Done (N tool uses · ...)` 卡片也消失**——子 agent 完成时仍处在 toolJSX 占位状态，Done 卡片在折叠态被压没。
3. **进度行（树枝符 + 状态）一并被压**——[AgentProgressLine](../../src/components/AgentProgressLine.tsx) 走的是消息流渲染管线，被 toolJSX 顶替后看不到。

而 Claude Code 的 binary 中 Task 工具调用走标准的 tool_use 卡片渲染，把 `(ctrl+o to expand)` 作为 Done 卡片的副文本与卡片**并列**渲染，不会去抢占额外的 UI 插槽。

## 修复方案：去 toolJSX 抢占 + 头部尾随提示

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
  // ctrl+b 后台化由 task:background keybinding 直接监听（在
  // renderGroupedAgentToolUse 顶层组件中 useKeybinding 注册），
  // UI 提示挪到头部 "Running N Explore agents" 行末尾，与 Claude Code
  // 的 "(ctrl+o to expand)" 副文本形态对齐。这里不再通过 setToolJSX
  // 抢占主渲染区，避免覆盖 ⏺ Explore(...) / ⎿ Done 卡片。

  // Race between next message and background signal
  // ...
```

**清理引用**：
- 检查 `import { BackgroundHint } from '../BashTool/UI.js'` 是否还有其他引用，若无则删除。
- 删除常量 `const PROGRESS_THRESHOLD_MS = 2000`（仅此处使用）。
- 删除局部变量 `let backgroundHintShown = false`、`const elapsed = Date.now() - agentStartTime`（若仅服务此分支）。

### 改动 2：在头部并列显示 ctrl+b 提示

**文件**：[src/tools/AgentTool/UI.tsx](../../src/tools/AgentTool/UI.tsx)

**位置**：renderGroupedAgentToolUse 头部 `{!allAsync && <CtrlOToExpand />}`（约 910 行）

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

**改后**：
```tsx
{!allAsync && (
  <>
    <CtrlOToExpand />
    {anyUnresolved && !isBackgroundTasksDisabled() && <CtrlBToBackground />}
  </>
)}
```

新增 `<CtrlBToBackground />` 组件（与 `<CtrlOToExpand />` 同文件并列定义）：
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

`isBackgroundTasksDisabled()` 抽到 `src/tools/AgentTool/backgroundTasks.ts` 或类似共享模块：
```ts
export function isBackgroundTasksDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_DISABLE_BACKGROUND_TASKS)
}
```

效果：
```
⏺ Running 1 Explore agents (ctrl+o to expand) (ctrl+b to background)
   └─ Explore · 5 tool uses · 12,345 tokens
      ⏿  Searching for ...
```

### 改动 3：keybinding 自检

`task:background` keybinding 原本在 [BackgroundHint.useKeybinding](../../src/tools/BashTool/UI.tsx) 中注册。BashTool 自身的长任务场景仍渲染 `<BackgroundHint />`，所以这个 keybinding 在 BashTool 路径下不会丢。

AgentTool 路径下需要在 [renderGroupedAgentToolUse](../../src/tools/AgentTool/UI.tsx) 顶层组件中独立注册，确保 ctrl+b 在 subagent 跑的时候依然生效：

```tsx
export function renderGroupedAgentToolUse(toolUses, options) {
  // ...
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  useKeybinding(
    'task:background',
    () => backgroundAll(() => store.getState(), setAppState),
    { context: 'Task' },
  )
  // ...
}
```

注意 `renderGroupedAgentToolUse` 当前是普通函数，需要确认它确实在 React 组件渲染上下文中被调用（看其调用方），否则需要包成自定义组件 `<GroupedAgentToolUse />` 后再使用 hook。

### 改动 4：i18n 自检

现有 [src/i18n/locales/zh-CN/misc.ts:629](../../src/i18n/locales/zh-CN/misc.ts) `shortcut.background: '后台运行'` 与 [src/i18n/locales/en/misc.ts:634](../../src/i18n/locales/en/misc.ts) `shortcut.background: 'run in background'` 已存在，`KeyboardShortcutHint.action="background"` 复用即可，**无需新增 key**。

需要在 [actionKeyMap](../../src/components/KeyboardShortcutHint.tsx) 中确认 `background` action 已注册映射到 `shortcut.background`。

## 验证步骤

```bash
# 1. 类型校验
bun tsc --noEmit

# 2. 启动开发模式跑一个 Explore subagent（需要至少 3-5 秒）
bun src/entrypoints/cli.tsx
# REPL 输入："用 Explore agent 找出 src/tools/AgentTool 下所有导出的类型"

# 3. 预期看到：
#    ⏺ Running 1 Explore agents (ctrl+o to expand) (ctrl+b to background)
#       └─ Explore · 5 tool uses · 12,345 tokens
#          ⏿  Searching for ...
# 完成后：
#    ⏺ 1 Explore agents finished (ctrl+o to expand)
#       └─ Explore · 10 tool uses · 65k tokens · Done

# 4. 按 ctrl+b，应进入后台任务列表
# 5. 按 ctrl+o，应展开 transcript

# 6. 反向验证：BashTool 长任务的 BackgroundHint 仍正常显示
# REPL 输入：!sleep 5
# 预期 2s 后看到主界面出现 (ctrl+b 后台运行)，按 ctrl+b 后台化
```

## 风险与回滚

### 风险 A：spinner 显示策略

`<BackgroundHint />` 的 toolJSX 副作用 `shouldHidePromptInput: false` / `showSpinner: true` 被移除后，spinner 可能受影响。

**核对** [ReplMainView.tsx:493](../../src/screens/repl/ReplMainView.tsx) 的 spinner 公式：
```ts
(!toolJSX || toolJSX.showSpinner === true) && isLoading
```

移除 toolJSX 后 `!toolJSX === true`，spinner 仍然按 `isLoading` 显示，**行为不变**。

### 风险 B：后台化入口可发现性

旧用户依赖那条 `(ctrl+b 后台运行)` 提示找到后台化入口。改动后提示仍在，只是位置从工具调用区挪到 `Running N Explore agents` 行末尾，与 `(ctrl+o to expand)` 并列。

**缓解**：保留提示文案不变（"后台运行"），用户视觉熟悉度无损。

### 风险 C：keybinding 重复注册

如 BashTool 与 AgentTool 同时活跃（极罕见，需要 BashTool 长任务和 Agent subagent 并发），`task:background` keybinding 可能被注册两次。

**缓解**：`useKeybinding` 自身应是幂等的（同 `context: 'Task'` 同 keybinding 后注册覆盖前注册）。需要核对 [keybindings/](../../src/keybindings/) 实现。

### 回滚

保留 `import { BackgroundHint }` 与 `PROGRESS_THRESHOLD_MS` 常量，回退 [AgentTool.tsx:1132-1150](../../src/tools/AgentTool/AgentTool.tsx#L1132-L1150) 行恢复旧分支即可。改动局限在两个文件，无数据迁移、无 schema 变更。

## 改动文件汇总

| # | 文件 | 操作 |
|---|---|---|
| 1 | [src/tools/AgentTool/AgentTool.tsx](../../src/tools/AgentTool/AgentTool.tsx) | 删除 1132-1150 的 setToolJSX 分支 + 清理引用 |
| 2 | [src/tools/AgentTool/UI.tsx](../../src/tools/AgentTool/UI.tsx) | 新增 `CtrlBToBackground` 组件，挂头部；renderGroupedAgentToolUse 注册 `task:background` keybinding |
| 3 | `src/tools/AgentTool/backgroundTasks.ts`（新增） | 抽出 `isBackgroundTasksDisabled()` 共享 helper |
| 4 | [src/components/KeyboardShortcutHint.tsx](../../src/components/KeyboardShortcutHint.tsx) | 自检 `background` action 已注册（多半已就绪） |

## 关联文档

- [Explore Agent 渲染层差异分析](./zy-code-explore-agent-render-diff.md)（§6 根因诊断、§7 改动清单原文）
- [Auto Mode 对齐方案](./zy-code-auto-mode-alignment.md)（同期 Claude binary 行为对齐工作）
