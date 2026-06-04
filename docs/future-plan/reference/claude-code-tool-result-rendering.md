# Claude Code 工具结果渲染机制分析

> 分析时间：2026-06-05
> 分析对象：zy-code 源码（fork from Claude Code）
> 目的：理解 Bash、Read 等工具如何在非 transcript 模式下直接渲染结果

## 概述

Claude Code 中工具结果在非 transcript 模式下渲染是**默认流水线行为**，而非特殊处理。每个工具只需实现 `renderToolResultMessage()` 方法，框架会自动在主视图中渲染。区别仅在于传入的 `verbose` 参数——非 transcript 时 `verbose=false`，工具自行决定精简展示形式。

---

## 架构总览

```
┌─────────────────────────────────────────────────┐
│ 非 transcript 模式（主聊天视图）                   │
├─────────────────────────────────────────────────┤
│ assistant msg → tool_call 块                     │
│   → AssistantToolUseMessage                      │
│     显示: ● Read(src/foo.ts)                     │
│     执行中: renderToolUseProgressMessage()        │
│                                                  │
│ user msg → tool_result 块                        │
│   → UserToolSuccessMessage                       │
│     → tool.renderToolResultMessage(verbose=false) │
│       Bash: 截断到 3 行 + "… +N lines"           │
│       Read: "Read 42 lines"                      │
│       Search: "Found 5 results"                  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Transcript 模式 (ctrl+o)                         │
├─────────────────────────────────────────────────┤
│ 同样的渲染链路，但:                               │
│   verbose=true → OutputLine 不截断               │
│   isTranscriptMode=true → 额外显示 prompt 等      │
└─────────────────────────────────────────────────┘
```

---

## 渲染管线详解

### 1. 消息循环入口

`src/components/Messages.tsx` 中遍历所有消息：

```typescript
const isTranscriptMode = screen === 'transcript'

// verbose 的传递逻辑
verbose={verbose || isItemExpanded(message) || (cursor?.expanded === true && index === selectedIdx)}
```

不区分 transcript/非 transcript 都会渲染所有消息类型。`isTranscriptMode` 只影响渲染的详细程度，不影响"是否渲染"。

### 2. 消息类型分发（Message.tsx）

`src/components/Message.tsx` 中按消息类型分发：

- **assistant 消息中的 `tool_call`/`tool_use` 块** → `AssistantToolUseMessage`
- **user 消息中的 `tool_result` 块** → `UserToolResultMessage` → `UserToolSuccessMessage`

```typescript
// Message.tsx L294-L311
case 'tool_result': {
  const toolResultWidth = columns - 5
  return (
    <UserToolResultMessage
      param={param}
      message={message}
      lookups={lookups}
      progressMessagesForMessage={progressMessagesForMessage}
      style={style}
      tools={tools}
      verbose={verbose}
      width={toolResultWidth}
      isTranscriptMode={isTranscriptMode}
    />
  )
}
```

### 3. Tool 接口定义（Tool.ts）

每个工具通过 `renderToolResultMessage` 方法定义结果渲染：

```typescript
// src/Tool.ts L510-L524
renderToolResultMessage?(
  content: Output,
  progressMessagesForMessage: ProgressMessage<P>[],
  options: {
    style?: 'condensed'
    theme: ThemeName
    tools: Tools
    verbose: boolean          // 关键：非 transcript=false, transcript=true
    isTranscriptMode?: boolean
    isBriefOnly?: boolean
    input?: unknown
  },
): React.ReactNode
```

省略此方法时，工具结果不渲染（如 TodoWrite 更新 todo 面板而非转录）。

### 4. UserToolSuccessMessage 的渲染链路

`src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx`：

```typescript
const renderedMessage =
  tool.renderToolResultMessage?.(
    toolResult,
    filterToolProgressMessages(progressMessagesForMessage),
    { style, theme, tools, verbose, isTranscriptMode, isBriefOnly, input }
  ) ?? null

// 如果工具结果消息为 null，则不渲染任何内容
if (renderedMessage === null) {
  return null
}
```

---

## 各工具的具体渲染策略

### Bash 工具

**文件**：`src/tools/BashTool/BashToolResultMessage.tsx`

非 verbose 下通过 `OutputLine` 组件显示 stdout/stderr：

```typescript
// OutputLine.tsx L56-64
const shouldShowFull = verbose || expandShellOutput
const formattedContent = shouldShowFull
  ? stripUnderlineAnsi(formatted)
  : stripUnderlineAnsi(renderTruncatedContent(formatted, columns, inVirtualList))
```

截断逻辑在 `src/utils/terminal.ts`：
- `MAX_LINES_TO_SHOW = 3`：非 verbose 最多显示 3 行
- 超出部分显示 `… +N lines (ctrl+o to expand)`
- 仅剩 1 行时直接显示第 4 行（不浪费行数显示提示）

特殊情况处理：
- `noOutputExpected` + 无输出 → 不展示 ⎿ 行
- `backgroundTaskId` → 显示 "Running in background ↓"
- `isImage` → 显示 "Image detected"
- `returnCodeInterpretation` → 显示错误解释

### FileRead 工具

**文件**：`src/tools/FileReadTool/UI.tsx`

不区分 verbose/非 verbose（始终是一行摘要）：

| 输出类型 | 渲染内容 |
|---|---|
| text | "Read **42** lines" |
| image | "Read image (1.2 MB)" |
| notebook | "Read 5 cells" |
| pdf | "Read PDF (3.4 MB)" |
| parts | "Read **3** pages (2.1 MB)" |
| file_unchanged | "File unchanged" (dimColor) |

### Grep/Search 工具

通常在 `collapsed_read_search` 分组中渲染：
- 非 verbose：一行摘要如 "Searched 3 files, read 2 files"
- verbose/transcript：展开显示每个工具调用及其一行结果

---

## 执行期间的实时 UI：setToolJSX

工具**执行过程中**（尚无结果），通过 `setToolJSX` 渲染临时内容到 prompt 区域。这是**独立于消息渲染的路径**。

```typescript
// BashTool.tsx L1363-1368 —— 长时间运行命令显示后台化提示
setToolJSX({
  jsx: <BackgroundHint />,
  shouldHidePromptInput: false,
  shouldContinueAnimation: true,
  showSpinner: true,
})
```

工具完成后：
```typescript
setToolJSX(null) // 清除临时 UI
```

结果随后通过正常的消息渲染管线展示。

### setToolJSX 的使用场景

| 场景 | 内容 | shouldHidePromptInput |
|---|---|---|
| Bash 长时间运行 | `<BackgroundHint />` (ctrl+b to background) | false |
| 权限对话框 | `<ComputerUseApproval />` 等 | true |
| ! bash mode | `<BashModeProgress />` (实时输出流) | false |
| Slash command UI | 各命令的交互 JSX | 视情况 |

---

## CollapsedReadSearchContent：批量折叠渲染

当连续多个 Read/Search/REPL 工具调用时，消息会被折叠为 `collapsed_read_search` 类型：

```typescript
// Messages.tsx L232-246
case 'collapsed_read_search': {
  const shouldShowVerbose = verbose || isTranscriptMode
  return (
    <CollapsedReadSearchContent
      message={message}
      verbose={shouldShowVerbose}
      ...
    />
  )
}
```

- **非 verbose**：一行摘要 "Searched 3 files, read 2 files"
- **verbose（transcript 或 ctrl+o 展开时）**：VerboseToolUse 逐个显示每个调用 + 单行结果

---

## 关键设计决策

1. **统一管线**：transcript 和非 transcript 使用同一套渲染组件，仅通过 `verbose`/`isTranscriptMode` 参数控制行为
2. **工具自治**：每个工具自行决定 verbose=false 时的精简展示形式
3. **渐进展开**：
   - 默认精简（3 行截断）
   - 选中消息可展开（`isItemExpanded`）
   - Ctrl+O 进入 transcript 全量展示
4. **零结果优化**：`renderToolResultMessage` 返回 null 时不渲染任何 DOM（如 TodoWrite）
5. **分离关注点**：执行中的实时 UI (`setToolJSX`) 与完成后的结果渲染 (`renderToolResultMessage`) 是两个独立路径

---

## 相关文件索引

| 文件 | 职责 |
|---|---|
| `src/Tool.ts` | 工具接口定义，包含 renderToolResultMessage 签名 |
| `src/components/Message.tsx` | 消息类型分发 |
| `src/components/Messages.tsx` | 消息列表循环 + verbose/isTranscriptMode 计算 |
| `src/components/messages/AssistantToolUseMessage.tsx` | tool_call 渲染（标题 + 进度） |
| `src/components/messages/UserToolResultMessage/` | tool_result 渲染入口 |
| `src/components/messages/CollapsedReadSearchContent.tsx` | 批量 Read/Search 折叠渲染 |
| `src/components/shell/OutputLine.tsx` | 文本输出行（verbose 截断逻辑） |
| `src/utils/terminal.ts` | renderTruncatedContent —— 3 行截断核心实现 |
| `src/tools/BashTool/BashToolResultMessage.tsx` | Bash 结果渲染 |
| `src/tools/BashTool/UI.tsx` | Bash 进度/错误渲染 |
| `src/tools/FileReadTool/UI.tsx` | FileRead 结果渲染 |
