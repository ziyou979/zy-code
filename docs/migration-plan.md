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
  - getCacheControl         (行 314-324)
  - addCacheBreakpoints     (行 ~2750)
  - buildSystemPromptBlocks (行 ~2900)

内部(不导出):
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

barrel re-export (从子模块):
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

`src/tools.ts`（351 行）静态导入 40+ 个工具，每次新增工具都需修改此文件。目标：改为插件式自注册，每个工具在自己底部调用 `registry.register()`。

### 改造方案

#### Step 1: 新建 `src/tools/registry.ts`

```typescript
// 工具注册表单例
class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  getByName(name: string): Tool | undefined {
    return this.tools.get(name)
  }
}

export const toolRegistry = new ToolRegistry()
```

#### Step 2: 每个工具主文件底部追加注册

```typescript
// 例：src/tools/BashTool/BashTool.ts 底部
import { toolRegistry } from '../registry.js'
toolRegistry.register(bashTool)
```

#### Step 3: 改造 `src/tools.ts`

- 删除 40+ 个静态 import
- 改为 side-effect import 触发自注册：`import './tools/BashTool/BashTool.js'`
- `getAllBaseTools()` → `toolRegistry.getAll()` + 条件过滤
- 保持 `getTools()` / `assembleToolPool()` / `getMergedTools()` API 不变

### 影响范围

- 60+ 个工具文件需在底部追加 `toolRegistry.register()`
- `src/tools.ts` 重写
- 外部调用方（`QueryEngine.ts`、`query.ts` 等）无需修改

### 执行步骤

```
Step 1: 创建 src/tools/registry.ts
Step 2: 逐个工具文件底部追加 register 调用（可用脚本批量处理）
Step 3: 改造 src/tools.ts（删除静态 import，改用 registry API）
Step 4: bun tsc --noEmit 验证
```

---

## <a id="m3"></a>M3: `BackgroundTasksDialog.tsx` 拆分

### 背景

`src/components/tasks/BackgroundTasksDialog.tsx`（981 行），已有 `tasks/` 目录 13 个文件。主组件 711 行，包含可提取的子组件和辅助函数。

### 拆分目标

| 新文件 | 提取内容 | 行号范围 |
|--------|---------|---------|
| `taskListRenderers.tsx` | `toListItem()`, `Item` 组件, `TeammateTaskGroups` 组件 | 856-981 |
| `taskOperations.ts` | `killShellTask`, `killAgentTask`, `killTeammateTask`, `killDreamTask`, `killRemoteAgentTask` | 364-380 |

### 执行步骤

```
Step 1: 创建 taskListRenderers.tsx（提取渲染组件）
Step 2: 创建 taskOperations.ts（提取操作函数）
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
| `src/components/repl/TranscriptModeFooter.tsx` | `TranscriptModeFooter` 组件 | 524-590 |
| `src/components/repl/TranscriptSearchBar.tsx` | `TranscriptSearchBar` 组件 | 592-720 |
| `src/components/repl/AnimatedTerminalTitle.tsx` | `AnimatedTerminalTitle` 组件 | 723-760 |

### 执行步骤

```
Step 1: 创建 src/components/repl/ 目录
Step 2: 逐个提取 3 个组件到独立文件（含必要 import）
Step 3: REPL.tsx 中替换为 import
Step 4: bun tsc --noEmit 验证
```

---

## <a id="m5"></a>M5: `REPL.tsx` 提取 hooks

### 背景

M4 完成后，REPL.tsx 主组件仍有大量内联状态逻辑，需提取为自定义 hooks。

### 拆分目标（需在 M4 完成后深入调研确认）

| 新文件 | 提取内容 |
|--------|---------|
| `src/hooks/useTranscriptMode.ts` | 转录模式状态管理 |
| `src/hooks/useTranscriptSearch.ts` | 转录搜索逻辑 |
| `src/hooks/useSessionManagement.ts` | 会话管理状态 |

### 执行步骤

```
Step 1: 深入阅读 REPL.tsx 主组件（M4 完成后，789-6198 行）
Step 2: 识别可提取的状态逻辑块
Step 3: 逐个创建 hook 文件
Step 4: REPL.tsx 中替换为 hook 调用
Step 5: bun tsc --noEmit 验证
```

---

## <a id="m6"></a>M6: `services/mcp/client.ts` 拆分

### 背景

`src/services/mcp/client.ts`（3102 行）包含 MCP 客户端的全部传输协议实现，需按传输协议拆分。

### 拆分目标（需在 M1 完成后深入调研确认）

| 新文件 | 职责 |
|--------|------|
| `transportFactory.ts` | 统一创建传输层 |
| `sseTransport.ts` | SSE 传输实现 |
| `stdioTransport.ts` | Stdio 传输实现 |
| `httpTransport.ts` | HTTP 传输实现 |
| `mcpClient.ts` | 核心客户端（高层 API） |

### 执行步骤

```
Step 1: 深入调研 client.ts 结构，确认按传输协议拆分的边界
Step 2: 逐个创建传输实现文件
Step 3: 精简 client.ts 为核心客户端
Step 4: bun tsc --noEmit 验证
```

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
| M1 | 22 + 6 新文件 | **高** | 中 | 循环依赖、`@ts-nocheck` 遗留问题 |
| M2 | 60+ 工具 + 1 | **中** | 低 | 注册顺序、side-effect import |
| M3 | 3 新文件 + 1 | **低** | 低 | 无 |
| M4 | 3 新文件 + 1 | **低** | 低 | 无 |
| M5 | 待定 | **中** | 中 | 闭包依赖、状态共享 |
| M6 | 待定 | **高** | 中 | 传输协议边界不清晰 |

### 里程碑检查点

- **Phase 1 完成后**: `bun tsc --noEmit` 通过，REPL 功能正常
- **Phase 2 完成后**: `bun tsc --noEmit` 通过，所有 LLM 查询功能正常
- **Phase 3 完成后**: `bun tsc --noEmit` 通过，所有工具可用
- **全部完成后**: `bun run build` + CLI 冒烟测试通过
