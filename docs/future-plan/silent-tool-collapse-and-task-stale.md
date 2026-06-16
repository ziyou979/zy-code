# 静默工具打断折叠分组 & Task 状态栏残留

## 问题 1：静默工具打断折叠分组

### 现象

用户看到两个连续折叠块，中间没有其他可见内容：

```
思考了 2 分 20 秒, 根据 5 个匹配模式搜索完成, 读取了 4 个文件, 列出了 3 个目录, 运行了 3 条命令

思考了 1 分 15 秒
```

### 根因

从 session JSONL 追踪实际消息序列：

```
209-256: thinking + 可折叠工具 (Glob, Grep, Bash, Read) → 第一组
257:     thinking (1409ms) → 加入第一组
258:     TaskCreate (不可折叠!) → flushGroup() → 创建第一组折叠块
259:     TaskCreate tool_result
260:     thinking (75126ms = 1分15秒) → 加入空的新组
261:     text → flushGroup() → 创建第二组折叠块(纯思考)
```

**关键**：`TaskCreate` 的 `renderToolUseMessage()` 返回 `null`，在 UI 上完全不可见，但它是"不可折叠工具"（`isNonCollapsibleToolUse`），会触发 `flushGroup()` 打断当前折叠分组。

后续的 thinking 块被孤立到新的空分组中，最终产生仅含思考内容的折叠块，而前一个折叠块和后一个折叠块之间在 UI 上看不到任何内容——因为 TaskCreate/TaskUpdate/TaskList/TaskGet 都是静默工具。

### CC 的做法（从二进制逆向提取）

CC 有专门的 `isAbsorbedSilently` 标记。从偏移 212751000 提取的 `xBH` 函数（等价于 zy-code 的工具分类函数）：

```javascript
function xBH(H, _, q) {
  // Bash/REPL 工具 — 可折叠且静默吸收
  if (H === FA) return {isCollapsible:true, isREPL:true, isAbsorbedSilently:true, ...};
  // Memory 写入工具 — 可折叠
  if (UNO(H, _)) return {isCollapsible:true, isMemoryWrite:true, isAbsorbedSilently:false, ...};
  // TodoWrite/TaskCreate 工具 — 可折叠且静默吸收（当 b9() 即 isBash 模式时）
  if (b9() && H === u$) return {isCollapsible:true, isAbsorbedSilently:true, ...};
  // MCP 工具 — 可折叠但不静默
  ...
  // 其他工具 — 不可折叠
  if (!K?.isSearchOrReadCommand) return {isCollapsible:false, isAbsorbedSilently:false, ...};
}
```

在 `rlK`（collapseReadSearchGroups）主循环中的消费方式：

```javascript
if (Y.isMemoryWrite) {
  // memory 写入 → 增加计数但不打断分组
  K.memoryWriteCount += w;
} else if (Y.isAbsorbedSilently) {
  // ★ 静默工具 → 什么都不做！不增加计数，不打断分组，不加入 group.messages
} else if (Y.mcpServerName) {
  // MCP 调用 → 增加 mcpCallCount
} else if (isBash && Y.isBash) {
  // bash 命令 → 增加 bashCount
} else if (Y.isList) {
  // 列表操作 → 增加 listCount
} else if (Y.isSearch) {
  // 搜索 → 增加 searchCount
} else {
  // 读取 → 增加 readCount
}
```

**关键差异**：CC 将 `isAbsorbedSilently` 的工具视为**可折叠**（`isCollapsible: true`），在折叠分组内部静默吸收——不增加任何计数、不加入 `group.messages`、不打断分组。zy-code 将这些工具视为**不可折叠**（`isNonCollapsibleToolUse`），导致 `flushGroup()` 打断分组。

### CC 工具分类字段一览

从偏移 105500736 提取的工具元数据字段：

| 字段 | 含义 | zy-code 等价 |
|---|---|---|
| `isCollapsible` | 是否可折叠 | `isToolSearchOrRead()` |
| `isSearch` | 是否搜索 | `isToolSearchOrRead()` 中的 isSearch |
| `isRead` | 是否读取 | `isToolSearchOrRead()` 中的 isRead |
| `isList` | 是否列表 | `listCount` |
| `isREPL` | 是否 REPL/Bash | `bashCount` |
| `isMemoryWrite` | 是否 memory 写入 | `memoryWriteCount` |
| **`isAbsorbedSilently`** | **是否静默吸收** | **无等价字段** |
| `isSearchOrReadCommand` | 是否搜索/读取命令 | `isToolSearchOrRead()` |
| `isBash` | 是否 Bash | `bashCount` |
| `briefStandalone` | 是否独立简要显示 | 无等价字段 |

### 修复方案

**方案 A：添加 `isAbsorbedSilently` 标记（对齐 CC）**

1. 在 `src/Tool.ts` 的 `ToolDef` 接口中添加 `isAbsorbedSilently?: boolean` 属性
2. 在 `TaskCreateTool`、`TaskUpdateTool`、`TaskListTool`、`TaskGetTool` 等静默工具上设置 `isAbsorbedSilently: true`
3. 在 `collapseReadSearchGroups` 的主循环中，当 `isNonCollapsibleToolUse` 为 true 但 `isAbsorbedSilently` 也为 true 时：
   - 不调用 `flushGroup()`
   - 不加入 `group.messages`
   - 跳过该消息的 tool_result（需要追踪 toolUseIds）
   - 继续处理下一条消息

```typescript
// 主循环中新增分支
} else if (isAbsorbedSilentlyToolUse(msg, tools)) {
  // 静默工具：不增加计数，不打断分组
  // 但需要追踪 toolUseId 以跳过对应的 tool_result
  const ids = getToolUseIdsFromMessage(msg)
  for (const id of ids) absorbedSilentToolUseIds.add(id)
  // 不 push 到 currentGroup.messages，不 flushGroup
} else if (isNonCollapsibleToolUse(msg, tools)) {
  // 不可折叠且非静默 → flushGroup
  flushGroup()
  result.push(msg)
}
```

对应的 `isCollapsibleToolResult` 修改：
```typescript
// tool_result 属于静默工具 → 同样静默吸收
if (absorbedSilentToolUseIds.has(toolResult.toolCallId)) {
  continue  // 跳过
}
```

**方案 B：最小改动（仅修改折叠逻辑）**

不添加新属性，在 `isNonCollapsibleToolUse` 之前增加 `isSilentNonCollapsibleToolUse` 检查：

```typescript
function isSilentNonCollapsibleToolUse(msg: RenderableMessage, tools: Tools): boolean {
  if (!isNonCollapsibleToolUse(msg, tools)) return false
  const toolName = extractToolName(msg)
  if (!toolName) return false
  const tool = findToolByName(tools, toolName) ?? findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool) return false
  // renderToolUseMessage 返回 null 的工具是静默工具
  return tool.renderToolUseMessage == null
}
```

> **注意**：方案 B 已在代码中实现（`isSilentNonCollapsibleToolUse` 函数存在于 `collapseReadSearch.ts`），
> 但主循环中尚未使用该函数——仍需完成接入。

### 涉及的静默工具

| 工具 | renderToolUseMessage | shouldDefer | 说明 |
|---|---|---|---|
| TaskCreate | null | true | 创建任务 |
| TaskUpdate | null | true | 更新任务状态 |
| TaskList | null | true | 列出任务 |
| TaskGet | null | true | 获取单个任务 |

### 影响范围

- `src/utils/collapseReadSearch.ts` — 主循环逻辑
- `src/Tool.ts` — 可选：添加 `isAbsorbedSilently` 属性
- 各静默工具文件 — 可选：添加 `isAbsorbedSilently: true`

---

## 问题 2：Task 状态栏残留 "1 open"

### 现象

模型完成任务后，底部状态栏仍显示类似 "3 tasks (2 done, 1 open)" 的提示，即使任务实际上已经完成。

### 根因

从 session JSONL 确认：

```
行 20:  TaskCreate  → 创建 "补齐折叠分组展开时显示思考内容" (status: pending)
行 143: TaskUpdate  → status: completed ✅
行 258: TaskCreate  → 创建 "排查连续折叠行根因" (status: pending)
         ← 没有 TaskUpdate status:completed！任务永远停留在 pending
```

**根因**：模型创建了任务但**忘记调用 TaskUpdate 将其标记为 completed**。这是模型行为问题，不是代码 bug，但 CC 有机制来缓解此问题。

### CC 的缓解机制（从二进制逆向提取）

CC 有两个关键机制 zy-code 缺少：

#### 1. 任务管理提醒系统

从偏移 213232000 提取的 `FbO` 函数（等价于 task reminder）：

```javascript
function FbO(H) {
  // 计算距离上次 TaskCreate/TaskUpdate 的轮数
  let turnsSinceLastTaskManagement = 0;
  let turnsSinceLastReminder = 0;
  for (let T = H.length - 1; T >= 0; T--) {
    let z = H[T];
    if (z?.type === "assistant") {
      if (uB6(z)) continue;  // 跳过 thinking-only 块
      if (turnsSinceLastTaskManagement === -1 &&
          z.message.content.some($ => $.type === "tool_use" && ($.name === uP || $.name === Dk))) {
        turnsSinceLastTaskManagement = T;  // uP=TaskCreate, Dk=TaskUpdate
      }
      turnsSinceLastTaskManagement++;
    } else if (z?.type === "attachment" && z.attachment.type === "task_reminder") {
      turnsSinceLastReminder = T;
    }
  }
  return {turnsSinceLastTaskManagement, turnsSinceLastReminder};
}

async function gbO(H, _) {
  if (!_M()) return [];  // isTodoV2Enabled 检查
  // 检查工具是否包含 TaskUpdate
  if (!_.options.tools.some(O => m1(O, Dk))) return [];
  // 常量
  const mm_ = {TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10};
  if (turnsSinceLastTaskManagement >= 10 && turnsSinceLastReminder >= 10) {
    // 注入 task_reminder 附件
    let tasks = await listTasks(getTaskListId());
    return [{type: "task_reminder", content: tasks, itemCount: tasks.length}];
  }
  return [];
}
```

**关键**：CC 每 10 轮对话如果没有使用 TaskCreate/TaskUpdate，就注入一个 `task_reminder` 附件提醒模型更新任务状态。这防止了模型"忘记"更新任务。

CC 的 TodoWrite 工具也有类似的提醒机制（`BbO` + `UbO`）：

```javascript
const mm_ = {TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10};
// 检查 TodoWrite 使用频率
if (turnsSinceLastTodoWrite >= 10 && turnsSinceLastReminder >= 10) {
  return [{type: "todo_reminder", content: currentTodos, itemCount: currentTodos.length}];
}
```

#### 2. `isAbsorbedSilently` 标记

如问题 1 所述，CC 将 TaskCreate/TaskUpdate 标记为 `isAbsorbedSilently: true`，这意味着：
- 这些工具调用不会打断折叠分组
- 它们在折叠分组内部被静默吸收
- 模型可以自由使用这些工具而不破坏 UI 流畅性

在 zy-code 中，因为 TaskCreate 打断了折叠分组，模型可能**倾向于少用**这些工具来保持 UI 整洁，进一步加剧了任务状态不更新的问题。

### 修复方案

#### 方案 A：添加 task_reminder 提醒机制（对齐 CC）

在 `src/services/attachments/` 或 `src/hooks/` 中添加任务管理提醒：

1. 实现 `getTaskManagementReminder` 函数：
   - 遍历最近消息，计算 `turnsSinceLastTaskManagement`
   - 当超过阈值（如 10 轮）时，注入 `task_reminder` 附件
   - 附件内容为当前未完成任务列表

2. 在消息附件生成流程中调用此函数（类似 CC 的 `gbO`）

3. 添加 `task_reminder` 附件类型到 `src/types/message.ts`

4. 渲染组件中处理 `task_reminder` 附件（可选：显示提醒文本）

#### 方案 B：自动完成过期任务

在 `TasksV2Store` 的 `#fetch` 中增加"过期任务"检测：

```typescript
// 如果所有任务都是 pending 状态且最后创建时间超过 5 分钟
// 自动将其标记为 completed（或直接 resetTaskList）
const allPending = current.every(t => t.status === 'pending')
const lastCreated = Math.max(...current.map(t => Date.parse(t.createdAt)))
if (allPending && Date.now() - lastCreated > 300_000) {
  // 提示模型或自动完成
}
```

#### 方案 C：改进 prompt 指令

在 TaskCreate 工具的 prompt 中明确要求模型在完成工作时调用 TaskUpdate status:completed。

当前 `TaskCreateTool/prompt.ts` 的提示可能不够强。CC 的 TaskCreate/TaskUpdate prompt 中可能包含更明确的"完成后必须更新状态"指令。

### 推荐方案

**方案 A（task_reminder）+ 问题 1 的修复（isAbsorbedSilently）** 组合：

1. 修复静默工具打断分组 → 模型更愿意使用 TaskCreate/TaskUpdate
2. 添加 task_reminder → 即使模型忘记，也会被提醒更新

这是 CC 采用的完整方案，效果最可靠。

### 影响范围

- `src/types/message.ts` — 新增 `task_reminder` 附件类型
- `src/services/attachments/` 或 `src/hooks/` — 新增 task_reminder 逻辑
- `src/components/` — 可选：渲染 task_reminder 附件
- `src/utils/collapseReadSearch.ts` — 问题 1 的修复
