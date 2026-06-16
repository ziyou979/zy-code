# 折叠分组展开时显示思考内容

## 问题描述

Claude Code 点击折叠摘要行（如 "Thought for 9s, ran 2 shell commands"）展开后，可以看到：
- 每个工具调用及其结果
- 工具调用之间的 **思考内容**（以 `∴` 前缀显示）

zy-code 当前点击展开折叠分组时，**只显示工具调用和结果，不显示思考内容**。

## 根因分析

### CC 的做法（从二进制逆向提取）

CC 的折叠函数 `rlK`（等价于 zy-code 的 `collapseReadSearchGroups`）在处理 thinking 块时有专门的分支：

```javascript
// CC 的 collapseReadSearchGroups 主循环（简化伪代码）
for (let msg of messages) {
    let toolInfo = isCollapsibleToolUse(msg) ? getCollapsibleInfo(msg) : null;
    let thinkingInfo = extractThinking(msg);  // lNO: 提取 thinking 块

    if (toolInfo) {
        // 可折叠工具调用 → 加入分组
        group.messages.push(msg);
    } else if (isToolResult(msg, group.toolUseIds)) {
        group.messages.push(msg);
    } else if (isHookSummary(msg)) {
        // 吸收 hook 摘要
    } else if (isRelevantMemories(msg)) {
        // 吸收 memory 附件
    } else if (thinkingInfo !== undefined) {
        // ★ 关键分支：thinking 块
        group.latestThinkingSummary = thinkingInfo.text.trim().replace(/\s+/g, " ");
        // 计算思考时长
        if (prevTimestamp !== undefined) {
            let duration = Date.parse(msg.timestamp) - Date.parse(prevTimestamp);
            if (duration > 0) group.thoughtForMs += Math.min(duration, 600000);
        }
        group.messages.push(thinkingInfo.message);  // ★ 将 thinking 消息加入 group.messages！
    } else if (shouldSkipMessage(msg)) {
        // 附件、系统消息等 → 延迟输出
        if (group has messages) deferred.push(msg);
        else result.push(msg);
    } else {
        flushGroup();
        result.push(msg);
    }
}
```

CC 的 verbose 展开渲染（`CollapsedReadSearchContent` 等价组件）：

```javascript
// CC 展开时的 verbose 渲染（简化伪代码）
if (verbose) {
    let items = [];
    for (let msg of groupMessages) {
        if (msg.type === "assistant") items.push(msg);
        else if (msg.type === "grouped_tool_use") items.push(...msg.messages);
    }
    return items.map((msg) => {
        let content = msg.message.content[0];
        if (content?.type === "thinking" && content.thinking) {
            // ★ 渲染 thinking 块！使用 AssistantThinkingMessage 组件
            return <AssistantThinkingMessage param={content} isTranscriptMode={true} verbose={true} />;
        }
        if (content?.type !== "tool_use") return null;
        return <VerboseToolUse content={content} ... />;
    });
}
```

### zy-code 当前的做法

**折叠阶段**（`collapseReadSearch.ts` 的 `collapseReadSearchGroups`）：

```typescript
// 当前 shouldSkipMessage 将 thinking 块视为"可跳过"消息
function shouldSkipMessage(msg: RenderableMessage): boolean {
    if (msg.type === 'assistant') {
        const content = msg.message.content[0];
        if (content?.type === 'thinking' || content?.type === 'redacted_thinking') {
            return true;  // ← thinking 被跳过
        }
    }
    // ...
}
```

在主循环中，thinking 块进入 `shouldSkipMessage` 分支 → 被放入 `deferredSkippable` → 在折叠分组**之后**作为独立消息输出。因此 `group.messages` 里**不包含** thinking 块。

**展开渲染阶段**（`CollapsedReadSearchContent.tsx`）：

```typescript
// verbose 路径只渲染 tool_use，没有 thinking 分支
if (verbose) {
    for (const msg of groupMessages ?? []) {
        if (msg.type === 'assistant') {
            toolUses.push(msg);
        } else if (msg.type === 'grouped_tool_use') {
            toolUses.push(...(msg.message as unknown as AssistantMessage[]));
        }
    }
    return toolUses.map((msg) => {
        const content = msg.message.content[0];
        if (content?.type !== 'tool_call') return null;  // ← thinking 被过滤掉
        return <VerboseToolUse ... />;
    });
}
```

### 差异总结

| 方面 | CC | zy-code |
|---|---|---|
| thinking 块在折叠分组中的归属 | 加入 `group.messages` | 延迟到分组之后（`deferredSkippable`） |
| 展开时的 verbose 渲染 | 遍历 messages，遇到 thinking 用 `AssistantThinkingMessage` 渲染 | 只遍历 tool_use，过滤掉非 tool_call |
| 思考时长来源 | `thoughtForMs`（从 timestamp 差值计算） | `thinkingDurationMs`（从消息属性读取） |
| 思考摘要（活跃分组提示行） | `latestThinkingSummary`（thinking 文本截断） | 无（使用 `latestDisplayHint` 显示工具输入） |

## 实施方案

### 阶段 1：折叠分组中保留 thinking 块

**目标**：让 thinking 块进入 `CollapsedReadSearchGroup.messages` 数组。

**修改文件**：`src/utils/collapseReadSearch.ts`

1. 在主循环的 `shouldSkipMessage` 分支之前，增加 thinking 块的处理分支：

```typescript
// 在 isCollapsibleToolResult 和 isPreToolHookSummary 之后，shouldSkipMessage 之前
} else if (isThinkingBlock(msg)) {
    // 提取 thinking 文本作为摘要
    const thinkingText = extractThinkingText(msg);
    if (thinkingText) {
        currentGroup.latestThinkingSummary = thinkingText.trim().replace(/\s+/g, ' ');
    }
    // 计算思考时长（从相邻消息的 timestamp 差值）
    if (lastTimestamp !== undefined && msg.timestamp) {
        const elapsed = Date.parse(msg.timestamp) - Date.parse(lastTimestamp);
        if (Number.isFinite(elapsed) && elapsed > 0) {
            currentGroup.thoughtForMs = (currentGroup.thoughtForMs ?? 0) + Math.min(elapsed, 600_000);
        }
    }
    // 将 thinking 消息加入分组
    currentGroup.messages.push(msg as AssistantMessage);
}
```

2. 新增辅助函数：

```typescript
function isThinkingBlock(msg: RenderableMessage): boolean {
    if (msg.type === 'assistant') {
        const content = msg.message.content[0];
        return content?.type === 'thinking' && !!content.thinking?.trim();
    }
    return false;
}

function extractThinkingText(msg: RenderableMessage): string | undefined {
    if (msg.type === 'assistant') {
        const content = msg.message.content[0];
        if (content?.type === 'thinking') return content.thinking;
    }
    return undefined;
}
```

3. `shouldSkipMessage` 不再需要处理 thinking 块（它们已被上面的分支拦截），但保留 `redacted_thinking` 的跳过逻辑。

4. 在 `createEmptyGroup` 中新增字段：
   - `thoughtForMs?: number`
   - `latestThinkingSummary?: string`

5. 在 `createCollapsedGroup` 中将这两个字段传递到 `CollapsedReadSearchGroup`。

### 阶段 2：展开时渲染 thinking 块

**目标**：verbose 模式下，在工具调用之间内联渲染 thinking 块。

**修改文件**：`src/components/messages/CollapsedReadSearchContent.tsx`

在 verbose 路径中增加 thinking 类型的判断：

```typescript
if (verbose) {
    const items: AssistantMessage[] = [];
    for (const msg of groupMessages ?? []) {
        if (msg.type === 'assistant') {
            items.push(msg);
        } else if (msg.type === 'grouped_tool_use') {
            items.push(...(msg.message as unknown as AssistantMessage[]));
        }
    }
    return (
        <Box flexDirection="column">
            {items.map((msg) => {
                const content = msg.message.content[0];
                // ★ 新增：渲染 thinking 块
                if (content?.type === 'thinking' && content.thinking) {
                    return (
                        <AssistantThinkingMessage
                            key={msg.uuid}
                            param={content}
                            addMargin={true}
                            isTranscriptMode={true}
                            verbose={true}
                        />
                    );
                }
                if (content?.type !== 'tool_call') return null;
                return <VerboseToolUse key={content.id} ... />;
            })}
            {/* hookInfos、relevantMemories 等保持不变 */}
        </Box>
    );
}
```

### 阶段 3（可选）：活跃分组显示思考摘要

**目标**：折叠摘要行的活跃提示（`⎿` 行）在思考阶段显示 thinking 内容预览。

**修改文件**：`src/components/messages/CollapsedReadSearchContent.tsx`

在非 verbose 模式下，当 `isActiveGroup` 且有 `latestThinkingSummary` 时，优先显示思考摘要而非工具输入提示：

```typescript
// 替换当前的 displayedHint 逻辑
const displayedHint = isActiveGroup && message.latestThinkingSummary
    ? truncateThinkingSummary(message.latestThinkingSummary, MAX_HINT_CHARS)
    : useMinDisplayTime(incomingHint, MIN_HINT_DISPLAY_MS);
```

## 注意事项

1. **thinkingDurationMs vs thoughtForMs**：zy-code 当前已有 `thinkingDurationMs` 字段（从 `AssistantMessage` 读取），而 CC 从 timestamp 差值计算 `thoughtForMs`。建议保持 zy-code 现有的 `thinkingDurationMs` 逻辑不变，新增 `thoughtForMs` 作为从 timestamp 差值计算的补充来源，取两者较大值。

2. **类型兼容**：`CollapsedReadSearchGroup.messages` 当前类型为 `AssistantMessage[]`。thinking 消息本身就是 `AssistantMessage` 类型（只是 content[0].type 为 'thinking'），不需要修改类型定义。

3. **redacted_thinking**：加密的思考内容不包含可见文本，不应加入 `group.messages`。保持 `shouldSkipMessage` 对 `redacted_thinking` 的跳过处理。

4. **向后兼容**：`latestThinkingSummary` 和 `thoughtForMs` 作为可选字段添加，不影响现有行为。

5. **import 补充**：`CollapsedReadSearchContent.tsx` 需要导入 `AssistantThinkingMessage` 组件。

## 实施状态

### 已完成

- **阶段 1（折叠分组中保留 thinking 块）** ✅
  - `isThinkingBlock()` / `extractThinkingText()` 辅助函数已添加
  - `collapseReadSearchGroups` 主循环顶部增加 thinking 处理分支（`continue` 模式，在 `isCollapsibleToolUse` 之前执行）
  - `shouldSkipMessage` 已修改：不再跳过普通 `thinking`，仅跳过 `redacted_thinking`
  - `CollapsedReadSearchGroup` 接口新增 `thoughtForMs` / `latestThinkingSummary` 可选字段
  - `flushGroup` 中合并 `pendingThinkingDurationMs` 与 `thoughtForMs` 取较大值

- **阶段 2（展开时渲染 thinking 块）** ✅
  - verbose 路径已增加 `type === 'thinking'` 分支，使用 `AssistantThinkingMessage` 渲染

- **阶段 3（活跃分组显示思考摘要）** ✅
  - `displayedHint` 优先显示 `latestThinkingSummary` 而非工具输入提示

### 已修复的遗漏：纯思考折叠块

CC 中会出现 "Thought for 2s" 这种仅包含思考内容、不含任何工具调用的折叠块。
改造后 `group.messages` 可以包含 thinking 消息，使 `flushGroup()` 能创建纯思考分组，
但 `CollapsedReadSearchContent` 的非 verbose 渲染路径有一个防御性检查：

```typescript
// 修复前：所有计数为 0 时直接 return null
if (!hasMemoryOps && !hasTeamMemoryOps && !hasNonMemoryOps) {
    return null
}
```

纯思考分组的所有工具计数均为 0，被此检查拦截导致不渲染。

**修复**：增加 `hasThinkingContent` 条件：

```typescript
const hasThinkingContent =
    (message.thinkingDurationMs ?? 0) > 0 ||
    message.latestThinkingSummary !== undefined

if (!hasMemoryOps && !hasTeamMemoryOps && !hasNonMemoryOps && !hasThinkingContent) {
    return null
}
```

修复后，纯思考折叠块会正常显示 "Thought for 2s"（由 `nonMemParts` 中的 thinking duration 逻辑渲染）。

### CC 对照验证

从 CC 二进制提取 `ihK`（CollapsedReadSearchContent 等价组件）和 `rlK`（collapseReadSearchGroups）确认：

**折叠逻辑（`rlK`）**：CC 在工具调用到达时 `K.latestThinkingSummary = void 0`（重置摘要），thinking 到达时重新设置。zy-code 不显式重置，但因 thinking 分支的覆盖写入，最终效果一致。

**渲染 guard**：CC 的 `hasNonMemoryOps`（变量 `i`）包含 `hasThinkingContent`（变量 `a`）：
```javascript
let a = n > 0 || H.latestThinkingSummary !== void 0;  // hasThinkingContent
let i = U > 0 || B > 0 || ... || a;                    // hasNonMemoryOps 包含 a
if (!W && !G && !i) return null;                        // guard
```
zy-code 用独立条件 `!hasThinkingContent`，效果等价。

**活跃 tick**：CC 用 `WAO` 组件基于 `Date.now()` 实时更新；zy-code 用 `ThinkingDurationTick` 基于 `setInterval`，行为一致。

**结论**：zy-code 当前实现已与 CC 完全对齐，无需额外修改。

## 影响范围

- `src/utils/collapseReadSearch.ts` — 折叠逻辑（核心变更）
- `src/types/message.ts` — `CollapsedReadSearchGroup` 接口（新增可选字段）
- `src/components/messages/CollapsedReadSearchContent.tsx` — 渲染逻辑（verbose 路径 + 活跃提示 + 防御性检查）
- 无需修改 `Message.tsx` 或 `Messages.tsx`（展开机制已完备）
