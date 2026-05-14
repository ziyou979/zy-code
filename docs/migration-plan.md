# 模块边界与大文件拆分 — 完整迁移方案

> 生成时间: 2026-05-13  
> 状态: 待执行

---

## 目录

- [M1: zy.ts → llmOrchestrator.ts + 拆分](#m1)
- [M2: tools.ts 插件化注册](#m2)
- [M3: BackgroundTasksDialog.tsx 拆分](#m3)
- [M4: REPL.tsx 提取独立组件](#m4)
- [M5: REPL.tsx 提取 hooks](#m5)
- [M6: services/mcp/client.ts 拆分](#m6)
- [M7: 全局验证](#m7)
- [执行顺序与风险评估](#execution-order)

---

## <a id="m1"></a>M1: `zy.ts` → `llmOrchestrator.ts` + 5 个子模块

### 背景

`src/services/api/zy.ts`（3084 行，`@ts-nocheck`）是项目中最大的单文件，承担了 LLM API 交互的全部职责。23 个导出符号、22 个外部依赖方。命名 `zy.ts` 语义不明确，需重命名并按职责拆分。

### 拆分目标

| 新文件 | 职责 | 预估行数 |
|--------|------|---------|
| `apiHelpers.ts` | API 配置、元数据、密钥验证、参数调整 | ~350 |
| `messageTransforms.ts` | 消息格式转换（user/assistant → API 格式） | ~200 |
| `cacheControl.ts` | 提示词缓存控制、缓存断点、系统提示构建 | ~350 |
| `usageTracker.ts` | 用量统计更新、累积、流资源清理 | ~150 |
| `compactQueries.ts` | 轻量级模型查询（compact/withModel） | ~150 |
| `llmOrchestrator.ts` | 核心流式/非流式查询编排 + barrel re-export | ~2000 |

### 符号 → 模块映射

#### `apiHelpers.ts`

```
导出:
  - getExtraBodyParams        (行 232-285)
  - getAPIMetadata            (行 438-458)
  - verifyApiKey              (行 460-472)
  - configureTaskBudgetParams (行 420-436)
  - adjustParamsForNonStreaming(行 ~3040)
  - getMaxOutputTokensForModel(行 ~3070)
  - MAX_NON_STREAMING_TOKENS  (行 ~3020, 常量 = 64000)

内部(不导出):
  - configureEffortParams     (行 399-416)

注意: should1hCacheTTL 被 getCacheControl 调用，归属 cacheControl.ts
注意: getNonstreamingFallbackTimeoutMs/getPreviousRequestIdFromMessages/shouldDeferLspTool
      仅被 queryModel/executeNonStreamingRequest 调用，留在 llmOrchestrator.ts
```

#### `messageTransforms.ts`

```
导出:
  - userMessageToMessageParam      (行 474-508)
  - assistantMessageToMessageParam (行 510-553)
  - stripExcessMediaItems          (行 778-818)

内部(不导出):
  - isMedia      (行 766-768)
  - isToolResult (行 770-772)
```

#### `cacheControl.ts`

```
导出:
  - getPromptCachingEnabled (行 287-312)
  - getCacheControl         (行 314-324, 调用 should1hCacheTTL)
  - addCacheBreakpoints     (行 ~2750)
  - buildSystemPromptBlocks (行 ~2900)

内部(不导出):
  - should1hCacheTTL  (行 346-393, 被 getCacheControl 调用)
    依赖: getAPIProvider, isEnvTruthy, isInternalBuild,
          getPromptCache1hEligible/setPromptCache1hEligible,
          getPromptCache1hAllowlist/setPromptCache1hAllowlist,
          getFeatureValue_CACHED_MAY_BE_STALE
  - isToolResultBlock (行 ~2730)
```

#### `usageTracker.ts`

```
导出:
  - updateUsage     (行 ~2620)
  - accumulateUsage (行 ~2680)
  - cleanupStream   (行 ~2600)
```

#### `compactQueries.ts`

```
导出:
  - queryCompactModel (行 ~2920)
  - queryWithModel    (行 ~2980)

依赖关系:
  两个函数均调用 queryModelWithoutStreaming (来自 llmOrchestrator.ts)
  需要从 llmOrchestrator.ts import { queryModelWithoutStreaming }
  外部 import: withVCR, createUserMessage, asSystemPrompt,
              getEmptyToolPermissionContext, getDefaultCompactModel
```

#### `llmOrchestrator.ts`（原 zy.ts 精简后）

```
导出:
  - Options (type, 行 576)
  - queryModelWithStreaming    (行 628-636)
  - queryModelWithoutStreaming (行 600-626)
  - executeNonStreamingRequest (行 681-749)

内部(不导出):
  - queryModel (核心生成器, 行 820-~2600, ~1800 行)
  - getNonstreamingFallbackTimeoutMs (行 668-674, 仅 executeNonStreamingRequest 使用)
  - getPreviousRequestIdFromMessages (行 756-764, 仅 queryModel 使用)
  - shouldDeferLspTool               (行 642-649, 仅 queryModel 使用)

本模块 import 子模块:
  - from './apiHelpers.js':        getExtraBodyParams, configureEffortParams,
                                   configureTaskBudgetParams, adjustParamsForNonStreaming,
                                   getMaxOutputTokensForModel, MAX_NON_STREAMING_TOKENS
  - from './messageTransforms.js': userMessageToMessageParam, assistantMessageToMessageParam,
                                   stripExcessMediaItems
  - from './cacheControl.js':      getPromptCachingEnabled, getCacheControl,
                                   addCacheBreakpoints, buildSystemPromptBlocks
  - from './usageTracker.js':      updateUsage, cleanupStream

barrel re-export (对外保持原有 API):
  - export * from './apiHelpers.js'
  - export * from './messageTransforms.js'
  - export * from './cacheControl.js'
  - export * from './usageTracker.js'
  - export * from './compactQueries.js'
```

### 22 个外部依赖方 import 路径更新

所有文件只需 `zy.js` → `llmOrchestrator.js`，符号不变（barrel re-export 保证）。

| # | 文件路径 | 导入的符号 |
|---|---------|-----------|
| 1 | `src/QueryEngine.ts` | `accumulateUsage`, `updateUsage` |
| 2 | `src/query/deps.ts` | `queryModelWithStreaming` |
| 3 | `src/hooks/useApiKeyVerification.ts` | `verifyApiKey` |
| 4 | `src/components/Feedback.tsx` | `queryCompactModel` |
| 5 | `src/components/agents/generateAgent.ts` | `queryModelWithoutStreaming` |
| 6 | `src/services/compact/compact.ts` | `getMaxOutputTokensForModel`, `queryModelWithStreaming` |
| 7 | `src/services/compact/autoCompact.ts` | `getMaxOutputTokensForModel` |
| 8 | `src/services/awaySummary.ts` | `queryModelWithoutStreaming` |
| 9 | `src/services/tokenEstimation.ts` | `getAPIMetadata`, `getExtraBodyParams` |
| 10 | `src/services/toolUseSummary/toolUseSummaryGenerator.ts` | `queryCompactModel` |
| 11 | `src/commands/insights.ts` | `queryWithModel` |
| 12 | `src/commands/rename/generateSessionName.ts` | `queryCompactModel` |
| 13 | `src/utils/permissions/yoloClassifier.ts` | `getCacheControl` |
| 14 | `src/utils/forkedAgent.ts` | `accumulateUsage`, `updateUsage` |
| 15 | `src/utils/teleport.tsx` | `queryCompactModel` |
| 16 | `src/utils/sessionTitle.ts` | `queryCompactModel` |
| 17 | `src/utils/shell/prefix.ts` | `queryCompactModel` |
| 18 | `src/utils/mcp/dateTimeParser.ts` | `queryCompactModel` |
| 19 | `src/utils/hooks/apiQueryHookHelper.ts` | `queryModelWithoutStreaming` |
| 20 | `src/utils/hooks/skillImprovement.ts` | `queryModelWithoutStreaming` |
| 21 | `src/utils/hooks/execPromptHook.ts` | `queryModelWithoutStreaming` |
| 22 | `src/tools/WebFetchTool/utils.ts` | `queryCompactModel` |

### 执行步骤

```
Step 1: 创建 5 个新模块文件（从 zy.ts 复制代码 + 添加必要 import）
Step 2: 精简 zy.ts（删除已提取代码 + 添加 barrel re-export）
Step 3: 重命名 zy.ts → llmOrchestrator.ts（git mv）
Step 4: 批量更新 22 个文件的 import 路径（zy.js → llmOrchestrator.js）
Step 5: bun tsc --noEmit 验证
```

### 风险点

- `queryModel` 核心生成器内部调用了 5 个新模块的函数 → `llmOrchestrator.ts` 需从各子模块 import
- 原 zy.ts 有 `@ts-nocheck`，拆分后子模块尝试移除，若类型问题太多暂时保留
- 某些内部函数可能同时被 `queryModel` 和子模块其他函数调用，需确认无遗漏

---

## <a id="m2"></a>M2: `tools.ts` 插件化注册

### 背景

`src/tools.ts`（351 行）静态导入 52 个工具，每次新增工具都需修改此文件。目标：改为插件式自注册，每个工具在自己底部调用 `registry.register()`。

### 现有工具清单（52 个）

**无条件加载（21 个）:**
`AgentTool`, `SkillTool`, `BashTool`, `FileEditTool`, `FileReadTool`, `FileWriteTool`,
`GlobTool`, `NotebookEditTool`, `WebFetchTool`, `TaskStopTool`, `BriefTool`,
`TaskOutputTool`, `WebSearchTool`, `TodoWriteTool`, `ExitPlanModeV2Tool`, `GrepTool`,
`AskUserQuestionTool`, `LSPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`,
`ToolSearchTool`, `EnterPlanModeTool`, `EnterWorktreeTool`, `ExitWorktreeTool`,
`TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`

**条件加载 — `isInternalBuild()` 门控（14 个）:**
`REPLTool`, `SuggestBackgroundPRTool`, `SleepTool`, `CronCreateTool`, `CronDeleteTool`,
`CronListTool`, `RemoteTriggerTool`, `MonitorTool`, `SendUserFileTool`,
`PushNotificationTool`, `SubscribePRTool`, `ConfigTool`, `VerifyPlanExecutionTool`,
`TungstenTool`

**条件加载 — `feature()` 门控（7 个）:**
`OverflowTestTool`, `CtxInspectTool`, `TerminalCaptureTool`, `WebBrowserTool`,
`SnipTool`, `ListPeersTool`, `WorkflowTool`, `PowerShellTool`

**条件加载 — 延迟 require + `isCoordinatorMode()` 门控（3 个）:**
`TeamCreateTool`, `TeamDeleteTool`, `SendMessageTool`

**条件加载 — 平台门控（1 个）:**
`TestingPermissionTool`（仅 `process.env.ZY_CODE_TESTING_TOOL`）

### 现有核心函数签名

```typescript
// 返回所有基础工具（含条件加载逻辑）
export function getAllBaseTools(): Tool[]

// 根据权限上下文过滤工具（ZY_CODE_SIMPLE 模式/拒绝规则/REPL 隐藏/isEnabled）
export function getTools(permissionContext: ToolPermissionContext): Tools

// 合并内置工具 + MCP 工具，按名称排序去重（内置优先）
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools
): Tools

// 合并内置工具 + MCP 工具，直接拼接不去重
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools
): Tools
```

### 改造方案

#### Step 1: 新建 `src/tools/registry.ts`

```typescript
import type { Tool } from '../Tool.js'

type ToolRegistration = {
  tool: Tool
  /** 注册条件: 返回 false 时不注册到 getAllBaseTools 结果中 */
  condition?: () => boolean
}

class ToolRegistry {
  private registrations: ToolRegistration[] = []

  register(tool: Tool, condition?: () => boolean): void {
    this.registrations.push({ tool, condition })
  }

  getAll(): Tool[] {
    return this.registrations
      .filter(r => !r.condition || r.condition())
      .map(r => r.tool)
  }

  getByName(name: string): Tool | undefined {
    return this.registrations.find(r => r.tool.name === name)?.tool
  }
}

export const toolRegistry = new ToolRegistry()
```

#### Step 2: 每个工具主文件底部追加注册

```typescript
// 无条件工具 — 例：src/tools/BashTool/BashTool.ts 底部
import { toolRegistry } from '../registry.js'
toolRegistry.register(bashTool)

// 条件工具 — 例：src/tools/REPLTool/REPLTool.ts 底部
import { toolRegistry } from '../registry.js'
import { isInternalBuild } from '../../utils/envUtils.js'
toolRegistry.register(replTool, () => isInternalBuild())

// feature 门控 — 例：src/tools/SnipTool/SnipTool.ts 底部
import { toolRegistry } from '../registry.js'
import { feature } from 'bun:bundle'
toolRegistry.register(snipTool, () => feature('SNIP_TOOL'))

// 延迟加载 — 例：src/tools/TeamCreateTool/TeamCreateTool.ts 底部
import { toolRegistry } from '../registry.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
toolRegistry.register(teamCreateTool, () => isCoordinatorMode())
```

#### Step 3: 改造 `src/tools.ts`

```typescript
// 触发所有工具自注册（side-effect import）
import './tools/AgentTool/AgentTool.js'
import './tools/BashTool/BashTool.js'
// ... 所有 52 个工具

import { toolRegistry } from './tools/registry.js'
import { uniqBy } from 'lodash-es'

export function getAllBaseTools(): Tool[] {
  return toolRegistry.getAll()
}

// getTools / assembleToolPool / getMergedTools 保持原有逻辑不变
```

### 影响范围

- **52 个工具文件**需在底部追加 `toolRegistry.register()` 调用
- `src/tools.ts` 重写（删除静态 import，改用 registry API）
- 外部调用方（`QueryEngine.ts`、`query.ts` 等）**无需修改**

### 执行步骤

```
Step 1: 创建 src/tools/registry.ts
Step 2: 编写批处理脚本，为 52 个工具文件底部追加 register 调用
Step 3: 改造 src/tools.ts（删除静态 import，改用 registry API）
Step 4: bun tsc --noEmit 验证
```

### 注意事项

- **side-effect import 顺序无关**: `assembleToolPool` 最终通过 `uniqBy` 按 name 去重并排序
- **条件工具的 condition 是惰性求值**: 在 `getAllBaseTools()` 调用时才执行 condition 函数
- **延迟加载工具**: `TeamCreateTool` 等原本用 `require()` 延迟加载，改为 condition 门控后在首次 `getAllBaseTools()` 时加载，时机等价

---

## <a id="m3"></a>M3: `BackgroundTasksDialog.tsx` 拆分

### 背景

`src/components/tasks/BackgroundTasksDialog.tsx`（981 行），已有 `tasks/` 目录 13 个文件。主组件 711 行，包含可提取的子组件和辅助函数。

### 可提取内容分析

#### ✅ 可提取: 渲染组件（行 857-980）

| 函数/组件 | 签名 | 行号 | 依赖 |
|-----------|------|------|------|
| `toListItem` | `(task: BackgroundTaskState) => ListItem` | 857-913 | `BackgroundTaskState`, `ListItem` 类型 |
| `Item` | `({ item, isSelected })` (无类型注解) | 914-936 | `useTerminalSize`, `isCoordinatorMode`, `TEAM_LEAD_NAME`, `Box`, `Text`, `figures`, `BackgroundTaskComponent` |
| `TeammateTaskGroups` | `({ teammateTasks, currentSelectionId })` (无类型注解) | 937-980 | `tSync`, `Box`, `Text`, `TEAM_LEAD_NAME`, `Item`（同文件） |

**注意**: `TeammateTaskGroups` 依赖同文件的 `Item`，两者必须提取到同一文件。

#### ❌ 不可提取: kill*Task 函数（行 365-379）

| 函数 | 原因 |
|------|------|
| `killShellTask(taskId)` | 使用组件内 `setAppState`（来自 `useSetAppState()` hook 返回值） |
| `killAgentTask(taskId)` | 同上 |
| `killTeammateTask(taskId)` | 同上 |
| `killDreamTask(taskId)` | 同上 |
| `killRemoteAgentTask(taskId)` | 同上 |

这些函数是组件内闭包，依赖 `setAppState` 局部变量，**无法提取为独立模块**。保留在主组件内。

### 拆分目标（修正后）

| 新文件 | 提取内容 | 行号范围 |
|--------|---------|---------|
| `src/components/tasks/taskListRenderers.tsx` | `toListItem()` + `Item` 组件 + `TeammateTaskGroups` 组件 + `ListItem` 类型 | 857-980 |

### 执行步骤

```
Step 1: 确认 ListItem 类型的定义位置（在 BackgroundTasksDialog.tsx 内部或 types.ts 中）
Step 2: 创建 taskListRenderers.tsx（提取 toListItem + Item + TeammateTaskGroups）
Step 3: BackgroundTasksDialog.tsx 中替换为 import
Step 4: bun tsc --noEmit 验证
```

---

## <a id="m4"></a>M4: `REPL.tsx` 提取独立组件

### 背景

`src/screens/REPL.tsx`（6198 行）内部定义了 3 个独立的函数组件，可直接提取到单独文件。

### 拆分目标

| 新文件 | 提取内容 | 行号范围 |
|--------|---------|---------|
| `src/components/repl/TranscriptModeFooter.tsx` | `TranscriptModeFooter` 组件 | 525-577 |
| `src/components/repl/TranscriptSearchBar.tsx` | `TranscriptSearchBar` 组件 | 580-710 |
| `src/components/repl/AnimatedTerminalTitle.tsx` | `AnimatedTerminalTitle` 组件 + 3 个常量 | 711-745 |

### 各组件详细信息

#### `TranscriptModeFooter` (行 525-577)

```typescript
// Props（无显式类型注解，从使用处推断）:
function TranscriptModeFooter({
  showAllInTranscript,  // boolean
  virtualScroll,        // boolean
  searchBadge,          // ReactNode
  suppressShowAll,      // boolean (默认 false)
  status,              // string
})
```

**依赖的 import:**
- `tSync` (from `../i18n/index.js`)
- `useShortcutDisplay` (from `../keybindings/useShortcutDisplay.js`)
- `Box`, `Text` (from `../ink.js`)
- `figures` (from `figures`)

**文件内其他引用:** 无

#### `TranscriptSearchBar` (行 580-710)

```typescript
// 有完整类型注解:
function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery,
}: {
  jumpRef: RefObject<JumpHandle | null>
  count: number
  current: number
  onClose: (lastQuery: string) => void
  onCancel: () => void
  setHighlight: (query: string) => void
  initialQuery: string
}): React.ReactNode
```

**依赖的 import:**
- `useSearchInput` (from `../hooks/useSearchInput.js`)
- `JumpHandle` (from `../components/VirtualMessageList.js`)
- `React`, `useEffect` (from `react`)
- `Box`, `Text` (from `../ink.js`)

**文件内其他引用:** 无

#### `AnimatedTerminalTitle` (行 711-745)

```typescript
// Props（无显式类型注解）:
function AnimatedTerminalTitle({ isAnimating, title, disabled, noPrefix })
```

**依赖的 import:**
- `useTerminalFocus`, `useTerminalTitle` (from `../ink.js`)
- `useState`, `useEffect` (from `react`)

**文件内依赖（需一并提取的常量）:**
- `TITLE_ANIMATION_FRAMES` (行 ~711, 字符串数组)
- `TITLE_STATIC_PREFIX` (行 ~712, 字符串常量)
- `TITLE_ANIMATION_INTERVAL_MS` (行 ~713, 数值常量)

### 执行步骤

```
Step 1: 创建 src/components/repl/ 目录
Step 2: 提取 TranscriptModeFooter（含 import + 为 props 补充类型注解）
Step 3: 提取 TranscriptSearchBar（已有完整类型注解）
Step 4: 提取 AnimatedTerminalTitle + 3 个常量（补充 props 类型注解）
Step 5: REPL.tsx 中删除原定义，替换为 import
Step 6: bun tsc --noEmit 验证
```

---

## <a id="m5"></a>M5: `REPL.tsx` 提取 hooks

### 背景

M4 完成后，REPL.tsx 主组件 `Screen` 函数（行 770 起）仍有大量内联状态逻辑。经详细调研，识别出 **33 个可提取的自定义 hook 候选**。按优先级分为 3 层。

### 第一优先级 — 低耦合、可独立提取（7 个）

| Hook 名称 | 行号范围 | 涉及的 state/effect | 外部依赖 |
|-----------|---------|--------------------|---------
| `useEnvironmentGating` | 826-839 | 4 个 `useMemo`（`titleDisabled`, `moreRightEnabled`, `disableVirtualScroll`, `disableMessageActions`） | 仅环境变量和 feature flags |
| `useReplLifecycleLogging` | 841-845 | 1 个 `useEffect`（挂载/卸载日志） | 仅 `disabled` prop |
| `useMcpConfigState` | 936-945 | `dynamicMcpConfig`, `setDynamicMcpConfig`, `onChangeDynamicMcpConfig` | 仅 `initialDynamicMcpConfig` |
| `useScreenAndDisplayState` | 946-970 | `screen`, `showAllInTranscript`, `dumpMode`, `editorStatus`, `editorGenRef`, `editorTimerRef`, `editorRenderingRef` | 无复杂依赖 |
| `useStreamingState` | 1071-1095 | `streamMode`, `streamModeRef`, `streamingToolUses`, `streamingThinking`, `abortController`, `abortControllerRef` | 仅 `streamingThinking`（30s auto-hide effect） |
| `useSwarmTimingState` | 1177-1191 | `swarmStartTimeRef`, `swarmBudgetInfoRef` | 无 |
| `useSpinnerAndUiState` | 1677-1700 | `lastQueryCompletionTime`, `spinnerMessage`, `spinnerColor`, `spinnerShimmerColor`, `isMessageSelectorVisible`, `messageSelectorPreselect`, `conversationId`, `idleReturnPending`, `skipIdleCheckRef` | 无复杂依赖 |

### 第二优先级 — 中等耦合（10 个）

| Hook 名称 | 行号范围 | 涉及的 state/effect | 关键依赖 |
|-----------|---------|--------------------|---------
| `useBootstrapLocalAgent` | 869-903 | `viewedLocalAgent`, `needsBootstrap` + 1 个 `useEffect` | `viewingAgentTaskId`, `tasks`, `setAppState` |
| `useCommandAndToolManagement` | 905-935 | `localCommands`, `proactiveActive`, `isBriefOnly`, `localTools` | `toolPermissionContext`, `initialCommands` |
| `useIdeIntegrationState` | 972-991 | `ideSelection`, `ideToInstallExtension`, `ideInstallationStatus`, `showIdeOnboarding`, `showEffortCallout`, `showDesktopUpsellStartup` | `mcpClients`, notification hooks |
| `useQueryGuardAndLoadingState` | 1097-1175 | `queryGuard`, `isQueryActive`, `isExternalLoading`, `isLoading`, `userInputOnProcessing`, 多个 ref | `remoteSessionConfig` |
| `useDialogState` | 1193-1200 | `focusedInputDialogRef`, `isPromptInputActive`, `autoUpdaterResult` | `addNotification` |
| `useTerminalTitleManagement` | 1334-1380 | `sessionTitle`, `haikuTitle`, `agentTitle`, `terminalTitle`, `titleIsAnimating` | `messages`, `isLoading`, `toolUseConfirmQueue` |
| `useMessageState` | 1382-1470 | `messages`, `rawSetMessages`, `messagesRef`, `dividerIndex`, `cursor`, `unseenDivider` | `initialMessages` |
| `useInputState` | 1565-1620 | `inputValue`, `inputValueRef`, `insertTextRef`, `inputMode`, `stashedPrompt` | `trySuggestBgPRIntercept`, `repinScroll` |
| `useRemoteSessionHooks` | 1622-1665 | `handleRemoteInit`, `inProgressToolUseIDs`, `remoteSession`, `directConnect`, `sshRemote`, `activeRemote` | `remoteSessionConfig`, `directConnectConfig` |
| `useContentReplacementState` | 1667-1675 | `pastedContents`, `submitCount`, `responseLengthRef`, `streamingText`, `visibleStreamingText` | `reducedMotion` |

### 第三优先级 — 高耦合、需仔细设计接口（16 个）

| Hook 名称 | 行号范围 | 核心职责 | 复杂度原因 |
|-----------|---------|---------|-----------|
| `useAgentState` | 847-867 | 从 AppState 读取 20+ 个状态字段 | 依赖几乎所有 AppState 字段 |
| `useToolJsxAndPermissionState` | 1213-1332 | 工具 JSX 渲染 + 权限确认队列 + 沙盒权限 | 涉及 3 个队列 + 桥接清理 |
| `useSurveyAndFeedbackState` | 1702-1795 | 反馈调查 + 技能改进 + 挫败检测 | 依赖多个 survey hooks |
| `useResumeAndSessionManagement` | 2000-2280 | 完整会话恢复逻辑 | 单个超大 useCallback (~280行) |
| `useFileStateCache` | 2282-2310 | 文件状态缓存管理 | 依赖 `initialMessages` |
| `useApiKeyAndExitFlow` | 2312-2320 | API Key 验证 + 退出流程 | 依赖 exit hooks |
| `useFocusedDialogLogic` | 2322-2430 | 焦点对话框状态机 | 依赖 15+ 个对话框状态 |
| `useCancelAndPermissionHandling` | 2432-2550 | 取消请求 + 权限请求桥接 | 涉及沙盒权限、leader 桥接 |
| `useToolPermissionContext` | 2652-2690 | 工具权限上下文管理 | 依赖 `setAppState`, `setToolUseConfirmQueue` |
| `useToolUseContext` | 2692-2880 | 构建完整的 ToolUseContext | 依赖几乎所有主要状态 (~200行) |
| `useBackgroundSession` | 2882-2970 | 后台会话/查询管理 | 依赖 `getToolUseContext` |
| `useQueryEventHandling` | 2972-3080 | 流式查询事件分发 | 依赖 6 个 setter |
| `useQueryImplementation` | 3082-3320 | 核心查询实现 (~240行) | 依赖几乎所有核心状态 |
| `useQueryExecution` | 3322-3540 | 查询执行 + query guard | 依赖 `onQueryImpl` |
| `useInitialMessageProcessing` | 3542-3640 | 初始消息处理 | 依赖 `onQuery` |
| `useSubmitHandler` | 3642-4000+ | 极大的 onSubmit (~360行) | 依赖几乎所有状态和回调 |

### 执行策略

```
Phase 5a: 提取第一优先级 7 个 hooks（低风险，立即可做）
Phase 5b: 提取第二优先级 10 个 hooks（中等风险，需设计 hook 接口）
Phase 5c: 评估第三优先级 16 个 hooks 的提取收益
           （部分 hooks 如 useSubmitHandler/useQueryImplementation 可能不值得提取，
            因为它们的接口会非常庞大，反而增加复杂度）
```

### 执行步骤

```
Step 1: 从第一优先级开始，逐个创建 hook 文件（src/hooks/repl/）
Step 2: 在主组件中替换为 hook 调用，验证类型
Step 3: 推进第二优先级，每个 hook 完成后立即 bun tsc --noEmit
Step 4: 第三优先级逐个评估，只提取接口简洁的 hooks
Step 5: 最终 bun tsc --noEmit 全量验证
```

### 注意事项

- **闭包依赖**: 许多高优先级 hook 的 useCallback 捕获了大量闭包变量，提取时需将这些变量作为参数或通过 context 传入
- **Ref 同步**: 多个 state 有对应的 ref 镜像（如 `inputValue` + `inputValueRef`），必须一起提取
- **第三优先级取舍**: `useSubmitHandler` (360行) 和 `useToolUseContext` (200行) 虽然巨大，但提取后的接口可能比内联更难理解 — 需要评估 ROI

---

## <a id="m6"></a>M6: `services/mcp/client.ts` 拆分

### 背景

`src/services/mcp/client.ts`（3102 行）包含 MCP 客户端的全部功能。经调研，传输协议代码集中在 `connectToServer` 单函数内（~500 行），通过 `serverRef.type` switch 分支处理 5 种传输（SSE/Stdio/HTTP/WebSocket/SDK）。由于传输逻辑无法简单按文件拆分（共享同一函数上下文），改为**按功能域拆分**。

### 文件结构图

```
src/services/mcp/client.ts (3102 行)
├── 类型 + 错误类 (1-200)
│   ├── McpAuthError (行 134)
│   ├── McpToolCallError (行 159)
│   └── isMcpSessionExpiredError (行 185)
│
├── 连接管理 (950-1570)
│   ├── connectToServer [memoized, ~500 行, 含 5 种传输 switch]
│   ├── ensureConnectedClient (行 1550)
│   ├── clearServerCache (行 1510)
│   └── 进程终止逻辑 SIGINT→SIGTERM→SIGKILL (行 1300-1450)
│
├── 资源获取 [memoized] (1600-1700)
│   ├── fetchToolsForClient
│   ├── fetchResourcesForClient
│   ├── fetchCommandsForClient
│   └── fetchMcpSkillsForClient [feature flag]
│
├── 工具调用 (1700-2000)
│   ├── callMCPTool [~250 行]
│   ├── callIdeRpc (行 1950)
│   └── callMCPToolWithUrlElicitationRetry [~400 行] (行 2594-3015)
│
├── 结果处理 (2280-2600)
│   ├── transformResultContent (行 2281)
│   ├── transformMCPResult (行 2450)
│   └── processMCPResult (行 2503)
│
├── 批量操作 (2050-2280)
│   ├── getMcpToolsCommandsAndResources (行 2059)
│   ├── prefetchAllMcpResources (行 2214)
│   └── reconnectMcpServerImpl (行 1971)
│
├── 工具函数 (1570-1600)
│   ├── areMcpConfigsEqual (行 1572)
│   ├── mcpToolInputToAutoClassifierInput (行 1592)
│   └── inferCompactSchema (行 2434)
│
└── SDK 集成 (3017-3102)
    └── setupSdkMcpClients (行 3017)
```

### 拆分目标（按功能域）

| 新文件 | 职责 | 行号范围 | 预估行数 |
|--------|------|---------|---------|
| `mcpConnection.ts` | 连接管理（`connectToServer` + 进程终止 + `ensureConnectedClient` + `clearServerCache` + `reconnectMcpServerImpl`） | 950-1570 + 1971-2050 | ~700 |
| `mcpToolCall.ts` | 工具调用（`callMCPTool` + `callIdeRpc` + `callMCPToolWithUrlElicitationRetry`） | 1700-2000 + 2594-3015 | ~700 |
| `mcpResults.ts` | 结果处理（`transformResultContent` + `transformMCPResult` + `processMCPResult` + `inferCompactSchema`） | 2280-2600 | ~350 |
| `mcpResources.ts` | 资源获取 + 批量操作（`fetchTools/Resources/Commands/Skills` + `getMcpToolsCommandsAndResources` + `prefetchAllMcpResources`） | 1600-1700 + 2050-2280 | ~350 |
| `client.ts` (精简) | 类型/错误类 + barrel re-export + `setupSdkMcpClients` + 工具函数 | 1-200 + 1570-1600 + 3017-3102 | ~350 |

### 关键依赖关系

```
mcpToolCall.ts ──imports──→ mcpConnection.ts (ensureConnectedClient)
mcpToolCall.ts ──imports──→ mcpResults.ts (transformMCPResult, processMCPResult)
mcpResources.ts ──imports──→ mcpConnection.ts (connectToServer, ensureConnectedClient)
client.ts ──re-exports──→ 所有子模块
```

### 执行步骤

```
Step 1: 创建 mcpResults.ts（最少依赖，最先拆出）
Step 2: 创建 mcpConnection.ts（最大文件，connectToServer 完整迁移）
Step 3: 创建 mcpResources.ts（依赖 mcpConnection）
Step 4: 创建 mcpToolCall.ts（依赖 mcpConnection + mcpResults）
Step 5: 精简 client.ts（保留类型/错误类 + barrel re-export）
Step 6: 更新外部依赖方 import 路径（若有）
Step 7: bun tsc --noEmit 验证
```

### 注意事项

- **`connectToServer` 是 memoized 的**: 使用 `memoizeWithLRU`，拆分后缓存逻辑必须保留
- **进程终止逻辑（行 1300-1450）**: SIGINT → SIGTERM → SIGKILL 升级序列与 Stdio 传输紧密耦合，必须留在 `mcpConnection.ts`
- **`callMCPToolWithUrlElicitationRetry`（~400 行）**: 包含 OAuth URL elicitation 重试循环，是最大的单个函数，不宜再拆

---

## <a id="m7"></a>M7: 全局验证

```
Step 1: bun tsc --noEmit（全量类型检查）
Step 2: 确认无循环依赖（可用 madge 或手动审查）
Step 3: bun run build（完整构建验证）
Step 4: 运行 CLI 冒烟测试
```

---

## <a id="execution-order"></a>执行顺序与风险评估

### 推荐执行顺序

```
Phase 1 (低风险，热身):     M3 + M4  （独立，可并行）
Phase 2 (核心，风险最高):   M1       （22 个依赖方，需仔细验证）
Phase 3 (架构变更):         M2       （60+ 工具文件，可脚本辅助）
Phase 4 (依赖 Phase 1):    M5       （需 M4 完成后调研）
Phase 5 (独立):             M6       （3102 行拆分）
Phase 6:                    M7       （全局验证）
```

### 风险矩阵

| 模块 | 影响文件数 | 风险等级 | 回滚难度 | 关键风险 |
|------|-----------|---------|---------|---------|
| M1 | 22 + 6 新文件 | **高** | 中 | `compactQueries→llmOrchestrator` 反向依赖需处理循环引用；`@ts-nocheck` 遗留 |
| M2 | 52 工具 + 2 新文件 | **中** | 低 | condition 函数执行时机、side-effect import 顺序 |
| M3 | 1 新文件 + 1 改 | **低** | 低 | 无 |
| M4 | 3 新文件 + 1 改 | **低** | 低 | `AnimatedTerminalTitle` 需带走 3 个常量 |
| M5 | 7-33 新文件 + 1 改 | **中→高** | 中 | 闭包变量传递、Ref 同步、第三优先级 ROI 评估 |
| M6 | 4 新文件 + 1 改 | **中** | 中 | `connectToServer` memoize 缓存一致性 |

### 里程碑检查点

- **Phase 1 完成后**: `bun tsc --noEmit` 通过，REPL 功能正常
- **Phase 2 完成后**: `bun tsc --noEmit` 通过，所有 LLM 查询功能正常
- **Phase 3 完成后**: `bun tsc --noEmit` 通过，所有工具可用
- **全部完成后**: `bun run build` + CLI 冒烟测试通过
