# ZY-Code 压缩算法优化方案

> **基于**: [`claude-code-compact-strategies.md`](./claude-code-compact-strategies.md) 研究文档 + Claude Code v2.1.146 二进制再核验
> **目标**: 把研究材料落地为可执行的工程动作，剔除已完成项 / 修正不准的论断 / 按真实 ROI 重排优先级；同时把 CC 完整 prompt + 完整算法流程内联，使本文档自包含、可直接实施
> **覆盖**: zy-code 现有压缩栈（`src/services/compact`、`src/services/contextCollapse`、`src/services/SessionMemory`）

---

## 一、现状对账：原研究文档列出的 "缺口" 哪些已经做完

把原文档 §4 / §8.16 的 P0/P1 一项项映射到当前 zy-code 源码，避免重复实施。

| 原文档 P 等级 | 项 | 现状 | 证据（路径:行） |
|---|---|---|---|
| §4.2 P0 | Cache-Sharing 压缩 | **已做** | `reactiveCompact.ts:171-183` `runForkedAgent({skipCacheWrite:true, querySource:'compact', cacheSafeParams: {...}})`；`compact.ts:1128-1135` 同款 |
| §4.5 P3 | Circuit Breaker (3 次失败) | **已做** | `autoCompact.ts:62 AUTOCOMPACT_BUFFER_TOKENS=13_000`、`autoCompact.ts:265 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`、`autoCompact.ts:340-348` 计数器递增并终止 |
| §2 整层 | Snip Compact 兜底裁剪 | **已做** | `snipCompact.ts:23 SNIP_THRESHOLD=0.8`、`MIN_KEEP_GROUPS=4`、`snipMessages` |
| §2 整层 | Microcompact（工具结果裁剪） | **已做** | `cachedMicrocompact.ts`、`apiMicrocompact.ts`、`microCompact.ts` (499 行) |
| §2 整层 | Context Collapse | **已做** | `services/contextCollapse/{index,operations,persist}.ts` 共 595 行 |
| §2 整层 | Session Memory（独立服务） | **已做** | `services/SessionMemory/{sessionMemory,sessionMemoryUtils,prompts}.ts` 共 970 行 |
| §1.3 策略 2 | 9 章节摘要 prompt | **已做** | `compact/prompt.ts` (369 行) |
| §1.3 策略 4 | Partial Compact (up_to) | **已做（prompt 层）** | `compact/prompt.ts` 内已有 `PARTIAL_COMPACT_UP_TO_PROMPT`（按文档 §4.4）；reactive 路径集成度待复查 |

**结论**：原文档列的 P0 "Cache-Sharing"、P3 "Circuit Breaker"、§4.4 "Partial Compact prompt 已有" 都不需要再做。**真正的工作集中在 §8 跨 Agent 调研里被定为 P0/P1 的几项**。

---

## 二、对原研究文档的关键修正（来自 CC 二进制再核验）

原研究文档基于 v2.1.146 逆向，但有几处与本次 v2.x 二进制的实测不一致，会影响优先级判断，先订正：

### 2.1 Claude Code 的 `contextCollapse` 是死代码（重要）

| 论断 | 原文档 §3 表格 | 实际（本次 v2.x 核验） |
|---|---|---|
| CC 是否有 contextCollapse | "❌ 无" | **代码留着，但没人调用** |

实测：
- `recordContextCollapseSnapshot` / `recordContextCollapseCommit`（minified 名 `Ta3` / `Oa3`）函数定义存在，导出存在
- transcript 解析器仍把 `marble-origami-commit` / `marble-origami-snapshot` 注册为合法 entry type（向后兼容，能读旧会话）
- session resume 路径（`Lr8`）仍把 `contextCollapseCommits` / `contextCollapseSnapshot` 字段从盘上拉回来塞进 SessionMetadata
- **但全二进制 `Ta3(` / `Oa3(` 的调用点为零**，没有任何路径产生新的 collapse 记录
- 唯一带 `marble` 的实验 flag `tengu_marble_lark` 是 personal memory sync，**和 origami 没关系**

**对方案的影响**：原文档 §3 把 Context Collapse 列为 zy-code 独有优势是对的，但更准确的描述应该是 "**Anthropic 试过、又收回去了**"。这里有三种可能的解读：
1. CC 团队认为模型摘要在新一代模型上质量已经够好，不需要规则化折叠
2. Collapse 维护成本太高（保前缀不变 + 提交语义 + 撤销路径）
3. 缓存对齐和 verbatim 保留的语义边界很难做对，遗留代码在等被彻底清理

**zy-code 的取舍**：保留 Collapse 是合理的，但要警惕同样的维护成本陷阱——见下文 §5 的"Collapse 健康度审计"。

### 2.2 Claude Code 的 `snipCompact` **从未存在**

原文档 §3 表格说 zy-code 的 snip 是独有，**这点确认**。CC 二进制全文 `grep` `snipCompact|snip_compact|SnipCompact` 零命中；之前看到的 `snip*` 全部是摘要 prompt 模板里 `"code snippets"` / `"full snippets"` 单词碎片。

### 2.3 Claude Code 有 Auto Memory，但 **不参与压缩**

原文档 §3 表格说 "Claude 没有 Session Memory"。**精确说法**：CC 有 Auto Memory（`tengu_moth_copse` 实验门控的 `~/.claude/projects/<sanitized-cwd>/memory/`），但和压缩**正交**：

- 压缩时摘要器 sub-LLM 用 `IYH()` 创建**全新空 memorySelector**、`G4([])` 传**空 memory 数组**给系统提示
- 摘要器用 `maxTurns:1` + 无工具，**不能读 memory 文件、也不能写**
- 压缩仅 `ERH(memorySelector)` 清空"已注入哪些 memory"的运行时缓存，便于后续 cwd 变化时重新挑选
- 磁盘上的 memory 文件本身不被压缩动

**对方案的影响**：zy-code 把 SessionMemory 与压缩流程耦合起来（"压缩时直接复用结构化记忆"），是 **CC 没有做的设计**，不是简单复刻。这点放大了 zy-code 在 §三 中的差异化价值。

### 2.4 Rapid Refill Breaker 的精确规格

原文档 §4.5 P3 写 "压缩后 < 2 轮就重新触发 → 死循环"。**实测精确值**（CC 二进制）：

```
$x8 = 3   // 一次 "rapid" 的定义：压缩后 ≤ 3 轮内又满
hD6 = 3   // 连续 3 次 rapid → 触发熔断
Ox8 = 3   // 普通失败熔断（独立计数器）
```

熔断后用户消息：
> *"Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh."*

**对方案的影响**：zy-code 实现时阈值应是 `<= 3` 而不是 `< 2`，且要 **3 次连续**才触发，单次内部计数（`Ax8` 函数）。

### 2.5 阈值表小修正

原文档 §1.2：

| 参数 | 原文档值 | 实际（CC 二进制） | 备注 |
|---|---|---|---|
| Warn Threshold | `normalThreshold - 20K` | `effectiveWindow - 33K` | 实际是 `T-20000` 其中 T = `effectiveWindow - 13K`（compact 阈值），所以 warn = window - 33K。差 13K |
| Output Reserve | 未列 | `bKK = 20000`（cap） | 输出 token 预留上限 |
| Precompute Buffer | `0.2` | `Hx8 = 0.2`（默认）+ `tengu_amber_rokovoko` 实验可覆盖 | 可被实验覆盖到非 0.2 |

zy-code 当前 `WARNING_THRESHOLD_BUFFER_TOKENS = 20_000`（`autoCompact.ts:63`），如果想严格对齐 CC，应该用 `33_000`。

---

## 三、真实差异化护城河（写给方案评审用）

剔除已做和已死代码后，**zy-code 在压缩这个维度上对 CC 的真实差异化**：

| 能力 | zy-code | CC v2.x | 差异化等级 |
|---|---|---|---|
| 摘要器读不到 memory | 同 CC | ✓ | 持平（都没做） |
| Pre-compact memory flush（让 SM 和压缩联动） | **未做但可做** | 不做 | **可建立护城河** |
| Context Collapse 走在线路径 | ✓ | ❌（死代码） | **已建立护城河** |
| Snip 确定性兜底 | ✓ | 不存在 | **已建立护城河** |
| Microcompact 工具结果裁剪 | ✓ | CC 用 `KKK` 占位符截 skill 内容，没有按 size 裁工具结果 | 部分护城河 |
| Cache-sharing 压缩 | ✓ | ✓ | 持平 |
| Precomputed compact（后台预算） | ❌ | ✓ | **CC 领先**，可追平 |
| 9 章节摘要 + verbatim 字段 | ✓ | ✓ | 持平 |

**结论**：zy-code 不需要全部追平 CC，关键是把已有的零 LLM 层（SM/Collapse/Snip/Microcompact）**串成一条编排过的级联**，并把 §六 的几项中等改动落地。

---

## 四、完整 CC 压缩 prompt（verbatim，来自二进制提取）

以下 prompt 文本全部从 CC 二进制 `claude.exe`（v2.1.146 → v2.x 持续一致）通过 `grep -aob` 定位 byte offset + `dd` 提取 + `LC_ALL=C tr -d '\0'` 剥离 null 得到，minified 符号名与中文功能说明并列给出。实现时可直接拷贝这些 prompt 模板，仅需替换变量槽位。

### 4.1 Tool-Restriction 前缀 `e7K`

**二进制位置**：偏移 ~199615992，变量名 `e7K`。

**作用**：摘要器是 fork 出来的 sub-agent，必须强制禁用所有工具调用。此段文字被追加在**所有**变体 prompt 的尾部。

```text
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

### 4.2 BASE_COMPACT_PROMP（完整对话变体）

**二进制位置**：偏移 ~199605200，函数 `AD6(H)`。当**不是** partial compact（即压缩整个会话而非仅 recent portion）时使用。

**组装逻辑**（函数 `AD6`）：

```javascript
function AD6(customInstructions) {
  return /* e7K 前缀 */ + /* 主体 prompt */ + /* Additional Instructions 槽位 */ + /* e7K 后缀 */
}
```

**主体 prompt 文本**（verbatim，替换变量后）：

```text
Your task is to create a detailed summary of the conversation so far, paying close
attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and
architectural decisions that would be essential for continuing development work
without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to
organize your thoughts and ensure you've covered all necessary points. In your
analysis process:

1. Chronologically analyze each message and section of the conversation. For each
   section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if
     the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g.,
     sensitive files or data to avoid, operations that must not be performed,
     credential or secret handling rules). These MUST be preserved verbatim in the
     summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required
   element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents
   in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and
   frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined,
   modified, or created. Pay special attention to the most recent messages and include
   full code snippets where applicable and include a summary of why this file read or
   edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay
   special attention to specific user feedback that you received, especially if the
   user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are
   critical for understanding the users' feedback and changing intent. Preserve any
   security-relevant instructions or constraints verbatim so they remain in effect
   after compaction.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to
   work on.
8. Current Work: Describe in detail precisely what was being worked on immediately
   before this summary request, paying special attention to the most recent messages
   from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the
   most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in
   line with the user's most recent explicit requests, and the task you were working
   on immediately before this summary request. If your last task was concluded, then
   only list next steps if they are explicitly in line with the users request. Do not
   start on tangential requests or really old requests that were already completed
   without confirming with the user first.
                       If there is a next step, include direct quotes from the most
                       recent conversation showing exactly what task you were working
                       on and where you left off. This should be verbatim to ensure
                       there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure
and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context.
If so, remember to follow these instructions when creating the above summary. Examples
of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember
the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include
file reads verbatim.
</example>
```

**尾部拼接**：

```text
Additional Instructions:
${customInstructions}        <-- 来自 PreCompact hook 的 newCustomInstructions；空则省略整段
```

然后追加 §4.1 的 `e7K` 工具限制文本。

### 4.3 PARTIAL_COMPACT_PROMPT（`aw3`，RECENT portion 变体）

**二进制位置**：偏移 ~199612434，变量名 `aw3`。当 compact 被触发且消息列表过长、需要分段压缩（partial compact）时，对**最近的**那一段使用此 prompt。

**与 §4.2 的关键差异**：
- 标题从 "conversation so far" 改为 **"RECENT portion of the conversation"**
- 明确说 "earlier messages are being kept intact and do NOT need to be summarized"
- Section 6 改为 "List ALL user messages from the **recent portion**"
- Section 7 改为 "pending tasks from the **recent messages**"
- Section 8 改为 "immediately before this summary request"（聚焦 recent）
- Section 9 改为 "Optional"（无 next step 硬性要求）

**主体 prompt 文本**（verbatim）：

```text
Your task is to create a detailed summary of the RECENT portion of the conversation
— the messages that follow earlier retained context. The earlier messages are being
kept intact and do NOT need to be summarized. Focus your summary on what was
discussed, learned, and accomplished in the recent messages only.

${`Before providing your final summary, wrap your analysis in <analysis> tags to
organize your thoughts and ensure you've covered all necessary points. In your
analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if
     the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g.,
     sensitive files or data to avoid, operations that must not be performed,
     credential or secret handling rules). These MUST be preserved verbatim in the
     summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required
   element thoroughly.`}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from
   the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and
   frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined,
   modified, or created. Include full code snippets where applicable and include a
   summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool
   results. Preserve any security-relevant instructions or constraints verbatim so they
   remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this
   summary request.
9. Optional Next Step: [...]
```

同样追加 `Additional Instructions` 槽位 + `e7K` 工具限制后缀。

### 4.4 老版本 UP_TO 变体（仍在二进制中保留）

**二进制位置**：compact_prompt.txt chunk 起始段。这是早期 "up to this message" 的 partial compact 变体，prompt 结构与 §4.2 相似但 section 8/9 用 "Work Completed" / "Context for Continuing Work" 替代：

```text
Your task is to create a detailed summary of this conversation. This summary will be
placed at the start of a continuing session; newer messages that build on this context
will follow after your summary (you do not see them here). Summarize thoroughly so
that someone reading only your summary and then the newer messages can fully
understand what happened and continue the work.

[... 与 §4.2 相同的 <analysis> 引导和 1-7 章节 ...]

8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would
   be needed to understand and continue the work in subsequent messages.
```

> 实现建议：zy-code 直接采用 §4.2 + §4.3 两个变体即可，无需复刻此老变体。

### 4.5 Post-Compact "Session Continued" 模板 `_0_`

**二进制位置**：偏移 ~199611492，函数 `_0_(summaryText, resumeDirective, transcriptPath, hasRecentMessages, replCleared)`。

**作用**：摘要器生成 summary 后，该 summary 被包装成一条 `user` 消息插入新会话。`_0_` 函数负责这个包装，有 **5 个条件分支**，按参数决定是否拼接额外文本。

**5 个分支**：

| 参数 | 触发条件 | 拼接文本 |
|---|---|---|
| 基础 | 总是 | "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${cleanedSummary}" |
| `transcriptPath` | 非空 | "\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}" |
| `hasRecentMessages` | true | "\n\nRecent messages are preserved verbatim." |
| `replCleared` | true | "\n\nYour REPL VM state has been cleared as part of this compaction. Variables defined in REPL calls before this point are no longer accessible — redefine any you still need." |
| `resumeDirective` | true | "\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened." |

**完整拼接伪代码**（verbatim）：

```javascript
function buildPostCompactMessage(
  summaryText, resumeDirective, transcriptPath,
  hasRecentMessages, replCleared
) {
  let msg = `This session is being continued from a previous conversation that ran
out of context. The summary below covers the earlier portion of the conversation.

${cleanupSummary(summaryText)}`

  if (transcriptPath)
    msg += `\n\nIf you need specific details from before compaction (like exact code
snippets, error messages, or content you generated), read the full transcript at:
${transcriptPath}`

  if (hasRecentMessages)
    msg += `\n\nRecent messages are preserved verbatim.`

  if (replCleared)
    msg += `\n\nYour REPL VM state has been cleared as part of this compaction.
Variables defined in REPL calls before this point are no longer accessible —
redefine any you still need.`

  if (resumeDirective)
    msg += `\n\nContinue the conversation from where it left off without asking the
user any further questions. Resume directly — do not acknowledge the summary, do
not recap what was happening, do not preface with "I'll continue" or similar. Pick
up the last task as if the break never happened.`

  return msg
}
```

### 4.6 Summary 清理正则 `sw3`

**二进制位置**：偏移 ~199613000 附近，函数 `sw3(H)`。

**作用**：摘要器输出形如 `<analysis>...</analysis>\n<summary>...</summary>`，`sw3` 把 `<analysis>` 段**丢弃**、把 `<summary>` 段**提取**出来作为最终的 summaryText。

**完整逻辑**（verbatim）：

```javascript
function cleanupSummary(rawOutput) {
  let text = rawOutput

  // 1. 丢弃 <analysis>...</analysis> 块（模型思考过程，不进入会话）
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/, "")

  // 2. 提取 <summary>...</summary> 内容，前缀 "Summary:"
  let match = text.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    let inner = match[1] || ""
    text = text.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${inner.trim()}`)
  }

  // 3. 合并多余空行
  text = text.replace(/\n\n+/g, "\n\n")

  return text.trim()
}
```

> 注意：这个清理逻辑是 §4.5 的 `cleanupSummary(summaryText)` 的实现。它确保即使模型输出格式有偏差（多个空行、忘记闭合标签），post-compact 消息也能正常渲染。

---

## 五、完整 CC 压缩算法流程（带 minified→中文映射）

### 5.1 常量表（全部从二进制核实）

| 二进制符号 | 值 | 中文含义 |
|---|---|---|
| `NKK` | `13000` | compact 阈值偏移：`effectiveWindow - 13K` = 触发压缩的 token 数 |
| `vKK` | `3000` | blocked 阈值偏移：`effectiveWindow - 3K` = 阻塞新消息的硬上限 |
| `bKK` | `20000` | 输出 token 预留上限（cap） |
| `Hx8` | `0.2` | precompute buffer 比例（20% 窗口用作预算缓冲） |
| `$x8` | `3` | rapid refill 的"压缩后 ≤ N 轮内又满"判定 |
| `hD6` | `3` | 连续 rapid refill 多少次触发熔断 |
| `Ox8` | `3` | 普通失败连续熔断阈值（独立计数器） |
| `YD6` | `5` | 单次 compact 最多重试次数 |
| `tw3` | `50000` | 单条消息 token 上限（超过则触发 microcompact） |
| `ew3` | `5000` | skill 内容截断阈值 |
| `Hj3` | `5000` | 另一个内容截断阈值 |
| `_j3` | `25000` | 内容截断阈值 |
| `_KK` | `100` | 单条消息字符数硬截断（用于 `bb8` 递归裁剪） |
| `zKK` | `3` | 另一个小型常量 |
| `Tx8` | `1e5` | 窗口 clamp 下限（最小 effectiveWindow） |
| `xKK` | `1e6` | 窗口 clamp 上限（最大 effectiveWindow） |
| `qKK` | `"[earlier conversation truncated for compaction retry]"` | 重试截断占位符 |
| `wD6` | `"Conversation too long. Press esc twice to go up a few messages and try again."` | 对话过长 UI 提示 |
| `PaH` | `"Not enough messages to compact."` | 消息不足提示 |
| `rrH` | `"Compaction blocked by PreCompact hook"` | hook 阻止提示 |
| `WaH` | `"Compaction interrupted · This may be due to network issues — please try again."` | 中断提示 |
| `KKK` | `"\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]"` | skill 内容截断占位符 |

### 5.2 阈值计算函数

#### `md(model, tools)` — 窗口解析

根据模型 + 工具集解析 effective context window，clamp 到 `[Tx8=1e5, xKK=1e6]`。

#### `A0_(window, config)` — compact 阈值

```javascript
function computeCompactThreshold(window, config) {
  let base = window - 13000                    // NKK
  let testPct = config.testPctOverride
  if (testPct !== undefined && !isNaN(testPct) && testPct > 0 && testPct <= 100)
    return Math.min(Math.floor(window * (testPct / 100)), base)
  return base
}
```

#### `yKK(window, config)` — precompute arm 阈值

```javascript
function computePrecomputeArmThreshold(window, config) {
  return Math.min(
    window - Math.round(window * config.precomputeBufferFraction),  // Hx8=0.2
    computeCompactThreshold(window, config)
  )
}
```

#### `hKK(tokens, window, config, blockedConfig)` — 阈值等级判定

```javascript
function computeThresholdLevel(tokens, window, config, blockedConfig = config) {
  let compactThreshold = computeCompactThreshold(window, config)
  let effectiveThreshold = config.enabled ? compactThreshold : window
  let warnThreshold = effectiveThreshold - 20000

  let blockingOverride = config.testBlockingOverride
  let blockedThreshold = (blockingOverride !== undefined && !isNaN(blockingOverride) && blockingOverride > 0)
    ? blockingOverride
    : blockedConfig - 3000                       // vKK

  let pctLeft = Math.max(0, Math.round((effectiveThreshold - tokens) / effectiveThreshold * 100))

  if (tokens >= blockedThreshold) return { level: "blocked", pctLeft }
  if (config.enabled && tokens >= compactThreshold) return { level: "compact", pctLeft }
  if (tokens >= warnThreshold) return { level: "warn", pctLeft }
  return { level: "ok", pctLeft }
}
```

**等级语义**：
- `ok` — 正常
- `warn` — UI 显示黄色警告条（距离 compact 不到 20K）
- `compact` — 触发 reactive compact
- `blocked` — 阻塞新消息输入，强制压缩

### 5.3 入口决策 `vD6` (reactive compact entry)

**二进制符号**：`vD6(H)`。完整入参：

```typescript
interface ReactiveCompactParams {
  hasAttempted: boolean
  querySource: 'main' | 'compact' | 'sdk' | ...
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams        // 含 toolUseContext、forkContextMessages 等
  precomputed?: PrecomputedResult          // 后台预计算结果（若有）
  precomputeOutcome?: { kind: 'success' | 'failed', failure?: {...} }
  initialTokenGap?: number
  thresholdSource?: string
  spinnerHintText?: string
}
```

**决策流程**：

```
1. 若 precomputed 存在且 kind === 'success'：
   → 直接复用预计算结果，跳过 LLM 调用（零等待 swap）
   → 走 CKK 后处理

2. 否则：
   a. 运行 PreCompact hook（见 §5.7）
      - hook 可返回 { blockedBy: string } → 终止，返回 hookBlocked: true
      - hook 可返回 { newCustomInstructions: string } → 注入摘要 prompt
   b. 触发 Kx8()：调用 PD6 → 分组 → 循环摘要
   c. 成功后走 CKK 后处理

3. 失败分类：
   - aborted → 记录 compact_reactive_aborted
   - error/timeout → 记录 compact_reactive_error
   - exhausted → 重试次数用尽
   - too_few_groups → 消息太少
```

### 5.4 分组与循环摘要 `PD6`

**二进制符号**：`PD6(messages, cacheSafeParams, options)`。

```
1. 过滤 progress 类型消息：K = messages.filter(m => m.type !== "progress")
2. 分组：O = XaH(K)              // XaH = groupMessagesForCompaction
   - 按 user/assistant 对话轮次切分
   - 每组 = 一个 user 消息 + 紧随其后的所有 assistant/tool 消息
3. T = O.length（总组数）
4. 若 T < 2 → 返回 too_few_groups

5. 初始化：
   - $ = 1                         // 当前保留组数（从 1 开始）
   - A = 0                         // 尝试计数
   - w = undefined                 // 步长策略
   - j = false                     // 是否已剥离 media

6. 若 initialTokenGap 给定且 T > 3：
   - 计算每组 token 数
   - 用 jKK() 计算"种子"保留组数
   - $ = 1 + M（M = 种子步长）
   - w = { mode: "seeded", step: M, tokenGap }

7. while $ < T:
   a. 若 abort → 返回 aborted
   b. A++
   c. J = T - $（待摘要组数）
   d. M = O.slice(0, J)（待摘要组）
   e. D = O.slice(J)（保留组）
   f. f = M.flat()（待摘要消息）
   g. 若 f 不含任何 assistant 消息 → 返回 too_few_groups 或 exhausted
   h. 记录遥测：attempt/groupsToSummarize/groupsToPreserve/strippedMedia/stepMode/stepSize
   i. 调用 Yj3(f, cacheSafeParams, customInstructions, strippedMedia)
   j. 若成功 → 返回 { ok: true, result: {...} }
   k. 若 prompt_too_long：
      - 计算新步长 wj3(tokenGap, groupTokenSizes, groups)
      - $ += step（增加保留组数）
      - w = { mode: "gap_guided", step, tokenGap }
      - continue
   l. 若 media_too_large 且 !strippedMedia：
      - strippedMedia = true
      - A--（不计入尝试次数）
      - continue
   m. 其他失败 → 返回

8. while 退出 → 返回 exhausted
```

**关键辅助函数**：

#### `jKK(groupTokenSizes, groupCount, tokenGap)` — 步长计算

```javascript
function computePreserveStepFromGap(groupTokenSizes, groupCount, tokenGap) {
  let accumulated = 0, count = 0
  for (let i = groupCount - 1; i >= 0; i--) {
    accumulated += groupTokenSizes[i]
    count++
    if (accumulated >= tokenGap) break
  }
  if (count >= groupCount - 1)
    return Math.max(1, Math.floor(groupCount / 2))    // 兜底：保留一半
  return count
}
```

#### `wj3(tokenGap, groupTokenSizes, groups)` — gap-guided 步长

```javascript
function computeGapGuidedStep(tokenGap, groupTokenSizes, groups) {
  if (tokenGap === undefined) return { mode: "gap_unparseable", step: 1 }
  return { mode: "gap_guided", step: computePreserveStepFromGap(groupTokenSizes, groups, tokenGap) }
}
```

### 5.5 摘要器调用 `Yj3`

**二进制符号**：`Yj3(messagesToSummarize, cacheSafeParams, customInstructions, strippedMedia)`。

```
1. 构建 prompt：O = AD6(customInstructions)        // §4.2 完整 prompt
2. 包装为消息：T = { role: "user", content: O }

3. 调用 fork agent：
   z = await runForkedAgent({
     promptMessages: [T],
     cacheSafeParams: {
       ...cacheSafeParams,
       forkContextMessages: strippedMedia
         ? stripMediaFromMessages(messagesToSummarize)    // xb8()
         : messagesToSummarize
     },
     canUseTool: neverAllowToolUse,                     // pb8()
     querySource: "compact",
     forkLabel: "reactive-compact",
     maxTurns: 1,
     maxOutputTokens: min(MAX_OUTPUT_TOKENS, modelMaxOutput),
     skipTranscript: true,                              // 不写盘
     skipCacheWrite: true                               // cache-sharing：不创建新 cache
   })

4. 提取最后一条 assistant 消息：$ = getLastAssistantMessage(z.messages)
   若无 → 返回 error

5. 检查错误类型：
   - isPromptTooLong → 返回 { reason: "prompt_too_long", tokenGap }
   - isMediaTooLarge → 返回 { reason: "media_too_large" }
   - isApiErrorMessage → 返回 { reason: "error", detail, status }

6. 提取 summary text：A = extractSummaryText(z.messages)     // $D6()
   若空 → 返回 error

7. 构建最终消息：
   return {
     ok: true,
     summaryText: A,
     forkAssistantMessageCount: countAssistants(z.messages),
     totalUsage: z.totalUsage,
     messages: [{
       role: "user",
       content: buildPostCompactMessage(A, true, transcriptPath, undefined, replCleared),
       isCompactSummary: true,
       isVisibleInTranscriptOnly: true
     }]
   }
```

**Cache-Sharing 机制解析**：
- `skipCacheWrite: true` — 摘要器调用不创建新的 prompt cache 条目
- `forkContextMessages` — 摘要器看到的是**原对话上下文 + 新增的 prompt 消息**
- 这样摘要器能"读到"对话全文（通过 cache read），但不会污染 cache
- 主对话的 cache 命中率不受影响

### 5.6 后处理 `CKK`

**二进制符号**：`CKK(H)`。压缩成功后的清理 + 状态重建。

```
1. 从 cacheSafeParams.toolUseContext 取 j

2. 保存文件读取状态快照：M = clone(j.readFileState)

3. 清理运行时缓存：
   - j.readFileState.clear()
   - delete j.loadedNestedMemoryPaths[*]     // 清空嵌套 memory 路径
   - ERH(j.memorySelector)                   // 清空 memorySelector 缓存

4. 子 agent 清理：if (isSubAgent()) xJ_(querySource, agentId)

5. 若 post_compact_cleanup 启用：
   - OCH()    // 清理函数 1
   - ZaH()    // 清理函数 2

6. 构建 compact metadata：
   - durationMs = performance.now() - startTime
   - preCompactDiscoveredTools = 从 preCompactMessages 提取工具名集合

7. 调用后处理：
   - attachments + hookResults = await runPostCompactHooks(readFileSnapshot, toolUseContext, preservedMessages)
   - postCompactEvent = fire PostCompact hook

8. 组装结果：
   return {
     boundaryMarker: boundaryMessage,
     summaryMessages: compactResult.summaryMessages,
     messagesToKeep: preservedMessages.map(zeroOutUsage),
     attachments: hookAttachments,
     hookResults: hookResults,
     userDisplayMessage: postCompactDisplay,
     preCompactTokenCount: preCompactTokens
   }

9. 记录遥测：
   tengu_reactive_compact_succeeded {
     attempts, groupsPreserved, totalGroups,
     preCompactTokens, postCompactTokens,
     durationMs, userWaitMs,
     precomputed, cacheHitRate, ...
   }
```

**`zeroOutUsage` (`Sj3`)**：保留消息的 `usage` 字段清零（input_tokens / output_tokens / cache_* 全设 0），避免统计重复计算。

### 5.7 PreCompact / PostCompact Hook 协议

#### PreCompact Hook

**触发时机**：压缩开始前（LLM 调用之前）。

**输入 JSON**：
```json
{
  "hook_event_name": "PreCompact",
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "trigger": "auto" | "manual",
  "custom_instructions": null | "..."
}
```

**输出**（stdout JSON，可选）：
```json
{
  "decision": "block" | "allow",   // "block" 阻止压缩
  "reason": "...",                   // 若 block，给用户的原因
  "new_custom_instructions": "..."  // 注入摘要 prompt 的额外指令
}
```

- 非零 exit code → 等同于 `decision: "block"`
- `decision: "block"` → `vD6` 返回 `{ result: null, hookBlocked: true }`

#### PostCompact Hook

**触发时机**：压缩完成后、结果返回给主循环前。

**输入 JSON**：
```json
{
  "hook_event_name": "PostCompact",
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "trigger": "auto" | "manual",
  "compact_summary": "..."           // summaryText 文本
}
```

**输出**：可返回 attachments（附加到压缩后会话）。

### 5.8 Auto-Compact 主循环

**在 zy-code 中的对应**：`autoCompact.ts:autoCompactIfNeeded`。

CC 的实际调度链：

```
每轮 LLM 响应结束后：
  1. 计算当前 token 数：currentTokens = countTokens(messages)
  2. 调用 hKK(currentTokens, window, config)
  3. 根据 level：
     - "ok" → 继续
     - "warn" → UI 显示警告
     - "compact" → 触发 reactive compact（vD6）
     - "blocked" → 强制压缩，阻塞新输入

  4. compact 触发后：
     a. 检查 precomputed 缓存 → 命中则零等待 swap
     b. 未命中 → 执行 reactive compact
     c. 更新 tracking state（consecutiveFailures / lastCompactTurnCounter 等）

  5. 失败处理：
     - consecutiveFailures++ → 达到 Ox8=3 时终止
     - rapid refill 检测（§5.2 常量 $x8/hD6）→ 连续 3 次 rapid 触发熔断

  6. 成功后：
     - 用 compact 结果替换 messages
     - 清理运行时状态
     - 继续主循环
```

### 5.9 Precomputed Compact 后台预算（`Qb8`）

**二进制符号**：`Qb8(H)` — 后台预计算入口。

```
1. 门控检查：
   - Fb8()（tengu_sepia_moth 实验）必须开启
   - querySource 不能是 "compact"
   - 当前 session 不能有进行中的预计算

2. arm 条件：
   - currentTokens >= yKK(window, config)（§5.2，约 80% 阈值）
   - 或 estimateGapTokens 预估即将触发

3. 后台 fork：
   - 创建 AbortController
   - 深拷贝 cacheSafeParams（替换 abortController）
   - 异步执行：
     a. 运行 PreCompact hook
     b. 调用 PD6（分组摘要）
     c. 成功后存入全局 Map<sessionId, PrecomputedState>

4. swap 时机：
   - 主循环触发 reactive compact 时，先查 precomputed 缓存
   - 若命中且 boundary UUID 匹配 → 直接 swap
   - 若预计算基于过时的消息列表 → 丢弃，走正常 reactive 路径

5. 取消：
   - 用户主动 /clear → abort 后台 fork
   - session 结束 → 清理 Map
```

### 5.10 完整调用链图

```
用户消息 → 主循环
  ├── countTokens(messages)
  ├── hKK(tokens, window, config) → level
  │   ├── "ok" → 继续
  │   ├── "warn" → UI 警告
  │   ├── "compact" → vD6()
  │   │   ├── 有 precomputed？→ CKK() 直接 swap
  │   │   └── 无 → PreCompact hook → PD6() → Yj3() → CKK()
  │   │       ├── PD6: XaH() 分组 → while 循环
  │   │       │   ├── Yj3: AD6() 构建 prompt → FW() fork agent
  │   │       │   ├── 成功 → 返回
  │   │       │   ├── prompt_too_long → wj3() 增加保留组 → continue
  │   │       │   └── media_too_large → stripMedia → retry
  │   │       └── CKK: 清理状态 → PostCompact hook → 组装结果
  │   └── "blocked" → 强制 vD6()
  │
  └── 同时（后台）：Qb8() 预计算
      ├── arm 条件满足 → fork agent → 存入 Map
      └── 主循环 swap 时消费
```

---

## 六、优化方案（按 ROI 排序）

> 最后更新：2026-06-06

### P0 — 立即落地（每项 1-3 天）

#### ~~P0.3 Rapid Refill Breaker~~ ✅ 已完成

2026-06 在 `src/services/compact/v2/autoCompact.ts` 中实现。常量 `RAPID_REFILL_TURNS=3`、`MAX_RAPID_REFILLS=3`，连续 3 次在 3 轮内重新触发压缩时熔断。通过 `ZY_COMPACT_V2=1` 环境变量启用。

---

#### P0.1 Observation Masking 中间层（来源：JetBrains/SWE-agent 研究）

**问题**：当前 zy-code 的零 LLM 层全在 80% 以后才触发（Snip 0.8、Collapse 0.85），70% 区间没有任何低成本压缩动作。Observation Masking 正好填这个空档。

**做什么**：
- 新文件 `src/services/compact/observationMask.ts`
- 触发阈值 `tokenCount >= effectiveWindow * 0.7`
- 操作：保留所有 `user` / `assistant`(非 tool_result) 消息原文 + 最近 K 个 `tool_result` 原文（K=10），更旧的 `tool_result.content` 替换为：
  ```
  [Tool {tool_name} result omitted ({n_tokens} tokens) — use Read on transcript if needed]
  ```
- **关键**：保留所有 `tool_use` 块和 reasoning，**只动 result 内容字段**，前缀稳定 → cache 命中

**为什么放在 Snip 之前**：Snip 一删整段，破坏前缀；Observation Masking 只动尾部字段，前缀依然命中 cache。两个机制串行：先 Mask，效果不够再 Snip。

**预期**：在 580 轮的 zy-code 模拟数据集上，配合 Collapse 推迟 reactive compact 1-2 次。

**注意点**：要和 Microcompact 的职责划清——Microcompact 已经在裁单条 tool 结果（按 size），Observation Masking 是按"距今多远"裁；两者维度不同，可共存。

**实现骨架**：

```typescript
// src/services/compact/observationMask.ts

const OBSERVATION_MASK_THRESHOLD = 0.7      // effectiveWindow 的 70%
const RECENT_TOOL_RESULTS_TO_KEEP = 10       // 最近 K 条 tool_result 保留原文

export interface MaskResult {
  messages: Message[]
  maskedCount: number
  tokenSavings: number
}

export function maskOldObservations(
  messages: Message[],
  currentTokenCount: number,
  effectiveWindow: number
): MaskResult {
  if (currentTokenCount < effectiveWindow * OBSERVATION_MASK_THRESHOLD) {
    return { messages, maskedCount: 0, tokenSavings: 0 }
  }

  // 1. 收集所有 tool_result，按出现顺序编号
  const toolResults = collectToolResults(messages)   // [{msgIdx, contentIdx, tokens, toolName}]

  // 2. 保留最近 K 条，其余替换
  const keepFrom = Math.max(0, toolResults.length - RECENT_TOOL_RESULTS_TO_KEEP)
  let tokenSavings = 0
  let maskedCount = 0

  const result = deepClone(messages)
  for (let i = 0; i < keepFrom; i++) {
    const tr = toolResults[i]
    const original = result[tr.msgIdx].message.content[tr.contentIdx]
    if (original.type === 'tool_result' && typeof original.content === 'string') {
      const nTokens = tr.tokens
      tokenSavings += nTokens
      maskedCount++
      original.content = `[Tool ${tr.toolName} result omitted (${nTokens} tokens) — use Read on transcript if needed]`
    }
  }

  return { messages: result, maskedCount, tokenSavings }
}
```

**集成点**：`autoCompact.ts:autoCompactIfNeeded` 入口处，在 hKK 判定之前调用。若 mask 后 tokenCount 降到 compact 阈值以下，则本轮不触发 compact。

**测试用例**：
1. tokenCount < 70% → messages 不变
2. tokenCount > 70%，15 条 tool_result → 前 5 条被 mask，后 10 条保留
3. mask 后 cache 命中率验证：前缀不变 → cache hit

#### P0.2 Pre-Compact Memory Flush（来源：Hermes / OpenClaw）

**问题**：当前 SessionMemory 是后台独立运行的，压缩触发时 SM 可能还没把最新关键信息提取出来。压缩一旦发生，那些"还没提取的"信息会在摘要里被泛化掉，再难找回。

**做什么**：在 `autoCompact.ts:autoCompactIfNeeded` 检测到将要压缩时，先：
1. 调用 `sessionMemoryCompact.ts` 现有 API 强制刷一次 SM 提取（带 `forceFlush: true`）
2. 等待提取完成（带 5s 超时和 abort）
3. **再**进入正常压缩流程

新加：
- `sessionMemoryCompact.ts` 暴露 `flushBeforeCompact(messages, signal): Promise<void>`
- `autoCompact.ts` 在 `autoCompactIfNeeded` 入口处调用

**为什么这是 P0**：这是把 §三中"zy-code 已有但没拼起来"的两个组件正式联动，是最低改动 / 最高差异化的动作。Hermes 的 Pre-Compact Memory Flush 在他们的 paper 里被列为最核心的设计决策。

**实现骨架**：

```typescript
// src/services/compact/sessionMemoryCompact.ts 新增
const FLUSH_TIMEOUT_MS = 5000

export async function flushBeforeCompact(
  messages: Message[],
  signal: AbortSignal
): Promise<void> {
  const timeout = AbortSignal.timeout(FLUSH_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])

  try {
    await extractSessionMemory(messages, { forceFlush: true, signal: combined })
  } catch (e) {
    if (combined.aborted) {
      logEvent('zy_memory_flush_timeout', {})
    } else {
      logEvent('zy_memory_flush_error', { error: String(e) })
    }
    // 不阻塞压缩流程——flush 失败只记日志，不中断
  }
}

// src/services/compact/autoCompact.ts 修改
async function autoCompactIfNeeded(messages, tracking, ...) {
  const level = computeThresholdLevel(tokens, window, config)

  if (level.level === 'compact' || level.level === 'blocked') {
    // P0.2: 先 flush memory
    await flushBeforeCompact(messages, abortController.signal)

    // 然后正常压缩
    return runCompact(messages, ...)
  }
}
```

**测试用例**：
1. flush 成功 → SM 提取完成后再压缩，摘要中包含 SM 结构化信息
2. flush 超时（5s）→ 压缩继续，日志记录 timeout
3. flush 异常 → 压缩继续，日志记录 error

#### P0.3 Rapid Refill Breaker（修正后规格）

**做什么**：补齐原文档 §4.5 P3 但**用本调研订正后的精确值**。在 `autoCompact.ts` `AutoCompactTrackingState` 里加：

```typescript
type AutoCompactTrackingState = {
  consecutiveFailures?: number
  // 新增：
  consecutiveRapidRefills?: number   // 当前连续 rapid 次数
  lastCompactTurnCounter?: number    // 上次压缩时的 turn 计数
}
```

逻辑（在 `autoCompactIfNeeded` 触发判定通过后、实际压缩前）：

```typescript
const RAPID_REFILL_TURNS = 3
const MAX_RAPID_REFILLS = 3

const turnsSinceLastCompact = currentTurnCounter - (tracking?.lastCompactTurnCounter ?? -Infinity)
const isRapid = tracking?.compacted && turnsSinceLastCompact <= RAPID_REFILL_TURNS

if (isRapid) {
  const next = (tracking?.consecutiveRapidRefills ?? 0) + 1
  if (next >= MAX_RAPID_REFILLS) {
    logEvent('zy_rapid_refill_breaker', { turnsSinceLastCompact, count: next })
    return {
      wasCompacted: false,
      rapidRefillBreakerTripped: true,
      // UI 上提示："上下文反复填满 — 文件读取或工具输出可能过大，建议拆分或 /clear"
    }
  }
  tracking.consecutiveRapidRefills = next
} else {
  tracking.consecutiveRapidRefills = 0
}
```

**注意**：单次 rapid 不熔断，是连续 3 次。这个细节决定了体验——单次大文件读取不会被错杀。

**熔断消息**（对齐 CC verbatim）：

```
Autocompact is thrashing: the context refilled to the limit within ${RAPID_REFILL_TURNS}
turns of the previous compact, ${MAX_RAPID_REFILLS} times in a row. A file being read
or a tool output is likely too large for the context window. Try reading in smaller
chunks, or use /clear to start fresh.
```

**测试用例**：
1. 首次 rapid（turnsSince=2）→ 计数 1，不熔断
2. 连续 3 次 rapid → 熔断，返回 rapidRefillBreakerTripped
3. 中间有一次非 rapid（turnsSince=5）→ 计数重置为 0

#### P0.4 大工具结果文件化（来源：Cursor / Manus）

**问题**：bash 跑 `find` / `grep -r` 得到几万 token 的输出会直接灌进 context，触发后续连环压缩。

**做什么**（注意：避免与现有 `toolResultStorage.ts` 重复）：
- 在 `BashTool` / `Grep` / `Read` 这几个高产出工具的输出处理里，加一个**显示前过滤**：
  - 如果 result token > `TOOL_OUTPUT_EXTERNALIZE_THRESHOLD`（建议 8000）：写到 `~/.zy-code/tool-outputs/<sessionId>/<toolUseId>.txt`，context 里只放：
    ```
    [Output: 47K tokens, written to <path>. First 100 lines:]
    <前 100 行>
    [...] use Read on the path to see the rest.
    ```
- 关键决策：**不影响**当前对话能否拿到完整内容（前 100 行 + 路径），只影响**未来轮次**——下轮要看完整内容必须显式 Read

**为什么 P0**：这是 §三表格里 "Microcompact 部分护城河" 升级到 "完整护城河" 的关键动作。CC 完全没做这层。

**实现骨架**：

```typescript
// src/services/compact/toolResultExternalizer.ts

const TOOL_OUTPUT_EXTERNALIZE_THRESHOLD = 8000   // tokens
const EXTERNALIZED_PREVIEW_LINES = 100

export async function externalizeIfNeeded(
  toolName: string,
  toolUseId: string,
  sessionId: string,
  result: string,
  tokenCount: number
): Promise<string> {
  if (tokenCount <= TOOL_OUTPUT_EXTERNALIZE_THRESHOLD) return result

  const dir = path.join(homedir(), '.zy-code', 'tool-outputs', sessionId)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${toolUseId}.txt`)
  await writeFile(filePath, result, 'utf-8')

  const lines = result.split('\n')
  const preview = lines.slice(0, EXTERNALIZED_PREVIEW_LINES).join('\n')
  const tokenLabel = tokenCount >= 1000 ? `${Math.round(tokenCount/1000)}K` : `${tokenCount}`

  return `[Output: ${tokenLabel} tokens, written to ${filePath}. First ${EXTERNALIZED_PREVIEW_LINES} lines:]\n${preview}\n[...] use Read on the path to see the rest.`
}
```

**集成点**：在 `BashTool.call()` / `GrepTool.call()` / `ReadTool.call()` 的返回值处理末尾调用。

**测试用例**：
1. result < 8000 tokens → 原文返回
2. result > 8000 tokens → 文件落盘 + 预览文本
3. 预览文本 token 数验证 < 原 result 的 20%

---

### P1 — 短期增强（每项 1 周）

#### P1.1 压缩 prompt 加 Handoff Framing（来源：Codex CLI）

**做什么**：在 `compact/prompt.ts` 现有 `BASE_COMPACT_PROMPT` 头部加一句：

```
You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume this task.
The next LLM will start with only your summary plus the most recent
messages — design your summary to make their first action correct.
```

并在压缩消息插入新会话时，加 prefix：

```
[CONTEXT COMPACTION] Another model started this task and produced the
summary below. The verbatim recent messages follow. Build on the prior
work; do not redo what's already done.
```

**为什么有效**：模型摘要时的"目的感"会变——从"我在记笔记给自己"变成"我在写交接文档"。Codex CLI 的实验表明这个 framing 能提升续接质量 ~10%。改动量极小，单文件 ~20 行。

**实现位置**：`compact/prompt.ts` — `BASE_COMPACT_PROMP` 模板字符串头部插入。

#### P1.2 User Message Preservation（来源：Codex CLI）

**问题**：当前 reactive compact 把所有旧消息都塞给摘要器，包括早期的用户原话。模型摘要时会复述、归纳，verbatim 约束只对"安全相关"硬性，普通用户消息会被改写。

**做什么**：在 `reactiveCompact.ts` 的分组逻辑里，**user 消息独立成一类**（不参与摘要）：
- 摘要器只看 `assistant` / `tool_use` / `tool_result` 消息
- 所有 `user` 消息按 token 预算从尾部回溯保留（最多保留到 20K token），每条**原文挂在摘要后面**

新结构：
```
[summary message]
[user message N-K] (verbatim)
[user message N-K+1] (verbatim)
...
[user message N] (verbatim)
[recent tool messages] (already preserved by group splitter)
```

**实施位置**：`reactiveCompact.ts` 的 `splitGroupsForCompaction` 附近。

**实现要点**：
1. 在 `XaH`（分组函数）调用前，先把 user 消息从 messages 中抽出
2. 只对 assistant/tool 消息做分组 + 摘要
3. 摘要完成后，从尾部向前把 user 消息原文拼接到 summaryMessage 后面
4. 预算控制：累加 user 消息 token，到 20K 停止

#### P1.3 Post-Compact Goal/Todo Re-injection（来源：Cline / Hermes）

**问题**：压缩后模型注意力会被稀释——摘要文字虽然写了 "Pending Tasks"，但和 system prompt 的距离不一样，attention 不一定还会聚焦。

**做什么**：
- `postCompactCleanup.ts` 已有清理钩子（70 行），扩展它
- 压缩完成后，从压缩前的最后一个 `TaskList` 状态 / 用户最近 goal 消息提取 goal text
- 作为 **system reminder** 在压缩后第一条用户消息前注入：
  ```
  <system-reminder>Active goal from before compaction: "<goal text>"</system-reminder>
  ```

**注意**：只注入一次，不是每轮——和 Cline 的 "每 6 条注入一次 todo" 思路相反，因为 zy-code 已有 TaskCreate 系统能持续提醒。

**实现位置**：`postCompactCleanup.ts` 现有 `postCompactCleanup()` 函数内新增 goal 提取逻辑。

#### P1.4 Precomputed Compact（来源：CC §5.9）

**只在 P0 全部落地后做**。原因：P0.1-P0.4 落地后压缩频率会显著降低，Precomputed 的边际收益（"零等待"）会比未优化时小得多——值得做但不再是最优先。

**做什么**：参考 §5.9 的完整流程，新文件 `src/services/compact/precomputedCompact.ts`：
- 全局 `Map<sessionId, PrecomputedState>`
- 80% 阈值 arm，后台 fork
- 在 `autoCompactIfNeeded` 触发点先 `consumePrecomputed`，命中则零等待 swap
- PreCompact hook 集成（可阻止）

**风险**：
- 后台 fork 期间若用户再发消息，预计算结果可能基于过时的 message 列表 → 需要在 swap 时用 boundary UUID 验证消息序列对齐
- Provider 兼容：百炼 / OpenAI 上若没有 prompt cache，预计算的成本收益反转——必须配置门控

**实现骨架**：

```typescript
// src/services/compact/precomputedCompact.ts

interface PrecomputedState {
  sessionId: string
  boundaryMessageId: string        // swap 时验证消息序列对齐
  compactResult: CompactResult
  messagesSince: Message[]         // arm 后新增的消息
  statusAtPTL: 'ok' | 'overflow'
  leadMs: number
  totalMs: number
  abortController: AbortController
}

const precomputedCache = new Map<string, PrecomputedState>()

export function armPrecomputedCompact(
  sessionId: string,
  messages: Message[],
  cacheSafeParams: CacheSafeParams
): void {
  // 后台 fork，结果存入 precomputedCache
}

export function consumePrecomputed(
  sessionId: string,
  currentMessages: Message[]
): PrecomputedState | null {
  const state = precomputedCache.get(sessionId)
  if (!state) return null

  // 验证 boundary UUID 对齐
  if (!messagesAlign(state.boundaryMessageId, currentMessages)) {
    precomputedCache.delete(sessionId)
    return null
  }

  // 计算 messagesSince（arm 后新增的消息）
  state.messagesSince = currentMessages.slice(/* from boundary */)
  precomputedCache.delete(sessionId)
  return state
}
```

#### P1.5 Collapse 健康度审计（针对 §2.1 修正）

**为什么**：CC 把 Collapse 从在线路径上摘掉了。zy-code 应该确认 Collapse 不会变成自己的负债。

**做什么**：跑一次内部审计：
- Collapse 命中率（多少压缩事件中是 Collapse 而非 LLM compact）
- Collapse 失败率（多少 commit 会被回滚 / PTL 错误）
- Collapse 后的缓存命中率（应当接近 100%，否则前缀稳定性出问题）
- Collapse vs Snip 的实际配合度（是否经常 Collapse 后立刻又 Snip）

输出：`docs/contextCollapse-health-audit-2026Q2.md`。如果数据漂亮，原研究文档 §3 的护城河叙事就站得住；如果不行，考虑学 CC 弃用。

**审计脚本骨架**：

```typescript
// scripts/collapse-health-audit.ts

interface AuditMetrics {
  totalCompactEvents: number
  collapseHits: number              // Collapse 处理的次数
  llmCompactCalls: number           // LLM 摘要调用次数
  collapseFailures: number          // Collapse 回滚 / PTL 错误
  postCollapseCacheHitRate: number  // Collapse 后 cache 命中率
  collapseThenSnipCount: number     // Collapse 后紧接 Snip 的次数
}
```

---

### P2 — 中期（按需）

| 项 | 来源 | 改动量 | 触发条件 |
|---|---|---|---|
| 压缩用便宜模型（可配置 `compaction.model`） | Hermes / Forge | 配置 + 路由 | P1 全做完后，如果压缩占总成本 > 5% |
| Successor Transcripts（不覆写原文件） | OpenClaw | ~150 行 | 用户反馈 "回退到压缩前" 的需求 |
| Identifier Preservation Policy | OpenClaw | prompt 改动 | 出现压缩丢失文件路径的 bug 后再做 |
| 压缩质量评估 pipeline | Factory.ai | ~200 行 | A/B 测试 P0/P1 改动需要量化对比时做 |

### P3 — 远期（架构级）

**Compiled View（来源：Google ADK / MemGPT）**：每次 query 前 compile minimal context = `system + recent(K) + retrieve(SM_relevant) + collapse_view`，而非追加压缩。需要：
- SM 上做向量索引（目前是结构化字段）
- Recent window 大小由模型自己 propose
- Compile pipeline 替换现有 message 累积模型

这是终极架构方向，但只在前面几层都做完且仍有 bottleneck 时启动。

---

## 七、实施路线图（修正版）

> 最后更新：2026-06-06。P0.3 已完成，其余按优先级排列。

```
已完成：
  ✅ P0.3 Rapid Refill Breaker（v2/autoCompact.ts，3+3 阈值）

Week 1 — P0 剩余项：
  Day 1-2: P0.1 Observation Masking（独立模块，70% 阈值）
  Day 3-4: P0.2 Pre-Compact Memory Flush（SM 联动）
  Day 5-7: P0.4 大工具结果文件化（BashTool/GrepTool 输出落盘）

Week 2 — P1 增强：
  Day 8-9:  P1.1 Handoff Framing（prompt 微调，~20 行改动）
  Day 10-12: P1.2 User Message Preservation（reactive 流程）
  Day 13-14: P1.3 Post-Compact Goal Re-injection
  Day 15:    P1.5 Collapse 健康度审计开始（数据收集，跑一周）

Week 3-4 — P1.4 Precomputed Compact + 评估：
  Day 16-22: precomputedCompact.ts + autoCompact 集成
  Day 23-25: 端到端 580 轮 dataset 上跑 A/B
  Day 26-28: 看审计数据决定 Collapse 是否要降级
```

---

## 八、验收指标

每个 P0/P1 落地后需在 `scripts/compact-real.ts` 的 580 轮真实对话回放上跑数据，对比 baseline：

| 指标 | baseline | P0 全做完 | P0+P1 全做完 |
|---|---|---|---|
| LLM compact 触发次数 | 4-6 次 | 期望 -30% | 期望 -50% |
| 平均 cache 命中率 | ~98.5% | ≥99.0% | ≥99.0% |
| 压缩相关 token 成本 | baseline | 期望 -20% | 期望 -40% |
| 压缩后续接质量（人工 eval） | baseline | 持平或+ | 提升 |
| Rapid refill 出现率 | 未知，待测 | < 1% 会话 | < 0.5% |

任何 P0 项做完后 cache 命中率下降，**立刻回滚**——这是 §二 §2.5 修正里 Manus "缓存稳定 > 压缩激进" 哲学的硬性要求。

---

## 九、回到原文档没落地的几项（明确不做的理由）

| 原文档项 | 决定 | 理由 |
|---|---|---|
| §8.7 MemGPT 分层内存 | **不做** | zy-code 已有 SM 充当 archival，再分层是过度设计 |
| §8.5 Cline 每 6 条 re-inject todo | **不做** | TaskCreate 系统已经持续可见，重复注入只会噪声 |
| §8.7 Compiled View 全量重写 | **远期 P3** | 架构 risk 太大，等前面层验证完再考虑 |
| §8.13 Factory.ai 评估 pipeline | **按需 P2** | 当前没有 A/B 决策需求 |

---

## 十、参考

- 原研究文档：[`claude-code-compact-strategies.md`](./claude-code-compact-strategies.md)
- CC 二进制反向得到的精确常量、阈值表、伪代码均见 §一、§二、§四、§五
- 现有 zy-code 压缩栈代码地图（2026-06-06 实测行数）：

```
src/services/
├── compact/
│   ├── autoCompact.ts          (345) ← P0.2 改动点
│   ├── v2/autoCompact.ts       (188) ← P0.3 ✅ 已实现（Rapid Refill Breaker）
│   ├── reactiveCompact.ts      (481) ← P1.2 改动点
│   ├── compact.ts              (1640)
│   ├── prompt.ts               (362) ← P1.1 改动点
│   ├── microCompact.ts         (508)
│   ├── sessionMemoryCompact.ts (586) ← P0.2 改动点
│   ├── postCompactCleanup.ts   (71)  ← P1.3 扩展点
│   ├── observationMask.ts      ← P0.1 待新建
│   ├── toolResultExternalizer.ts ← P0.4 待新建
│   └── precomputedCompact.ts   ← P1.4 待新建
├── contextCollapse/
│   ├── index.ts                (372)
│   ├── operations.ts           (160)
│   └── persist.ts              (75)  // P1.5 审计目标
└── SessionMemory/
    ├── sessionMemory.ts        (464)
    ├── sessionMemoryUtils.ts   (201)
    └── prompts.ts              (304)
```

---

## 附录 A：CC 二进制 minified 符号→功能映射表

| minified 名 | 功能 | 本文档章节 |
|---|---|---|
| `AD6` | 构建完整 BASE_COMPACT_PROMP | §4.2 |
| `aw3` | PARTIAL_COMPACT_PROMPT 变量 | §4.3 |
| `e7K` | Tool-restriction 后缀 | §4.1 |
| `_0_` | Post-compact 消息模板 | §4.5 |
| `sw3` | Summary 清理正则 | §4.6 |
| `hKK` | 阈值等级判定 | §5.2 |
| `md` | 窗口解析 | §5.2 |
| `A0_` | compact 阈值计算 | §5.2 |
| `yKK` | precompute arm 阈值 | §5.2 |
| `vD6` | reactive compact 入口 | §5.3 |
| `PD6` | 分组 + 循环摘要 | §5.4 |
| `Yj3` | 摘要器 fork 调用 | §5.5 |
| `CKK` | 后处理 | §5.6 |
| `Ao` | 最终清理（file state / memory / telemetry） | §5.6 |
| `XaH` | 消息分组 | §5.4 |
| `jKK` | 步长计算 | §5.4 |
| `wj3` | gap-guided 步长 | §5.4 |
| `xb8` | 媒体剥离 | §5.5 |
| `Qb8` | precomputed compact 后台入口 | §5.9 |
| `Sj3` | usage 清零 | §5.6 |
| `ERH` | memorySelector 缓存清理 | §5.6 |
| `FW` | runForkedAgent | §5.5 |
| `pb8` | neverAllowToolUse | §5.5 |
| `$D6` | extractSummaryText | §5.5 |
| `NKK` | 13000 常量 | §5.1 |
| `vKK` | 3000 常量 | §5.1 |
| `bKK` | 20000 常量 | §5.1 |
| `Hx8` | 0.2 常量 | §5.1 |
| `$x8` | 3 常量（rapid turns） | §5.1 |
| `hD6` | 3 常量（rapid 熔断） | §5.1 |
| `Ox8` | 3 常量（失败熔断） | §5.1 |
| `YD6` | 5 常量（最大重试） | §5.1 |
| `Ax8` | rapid refill 检测函数 | §2.4 |
