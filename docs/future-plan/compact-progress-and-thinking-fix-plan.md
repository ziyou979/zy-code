# /compact 进度条停在 ~50% + 压缩后首条为思考内容 — 根因分析与修复计划

> **分析日期**: 2026-07-12  
> **CC 版本**: Claude Code **2.1.207**（`claude.exe` ~249MB）  
> **提取方法**: `extract-claude-internal` skill — 字节偏移定位 + 上下文抽取  
> **zy-code 主要路径**: `src/services/compact/compact.ts`、`src/screens/repl/useReplLoadingState.ts`、`src/services/compact/prompt.ts`、`src/utils/messages/predicates.ts`  
>
> **实施状态（2026-07-12）**：Phase 1–3 已落地；**statusline 上下文比例** 同步修复  
> - `summarySelection.ts`（zQn/KQn）  
> - `formatCompactSummary` 只保留 `<summary>` 正文  
> - `compactProgress.ts` + UI 渐近 %（删除业务层线性伪进度）  
> - `getDisplayContextUsage` + `compactMetadata.postTokens`：压缩后 statusline 不再读边界前旧 usage  
> - 测试：`tests/services/compact/*` + `tokens.getDisplayContextUsage` + statusline context

---

## 一、现象复述

1. **进度条**：`/compact` 时 spinner 上的进度条经常涨到大约 **50%** 就结束（spinner 消失），从未自然走到 100%。  
2. **首条消息**：压缩完成后，**第一条可感知的消息内容**像是模型的思考/推理（thinking / chain-of-thought），而不是干净的 compact summary。  
3. **后续影响担忧**：该内容会作为压缩后对话的核心 user 上下文进入下一轮 API，可能污染后续调用。

---

## 二、问题 A：进度条 ~50% 就结束

### 2.1 zy-code 现状

`compactConversation`（`src/services/compact/compact.ts`）在 API 调用期间用 **伪进度定时器**：

```ts
// 约 L445–455
let progressPct = 10
progressTimer = setInterval(() => {
  progressPct = Math.min(progressPct + 3, 80)  // 每 2s +3%，封顶 80%
  context.onCompactProgress?.({
    type: 'compact_progress',
    stage: 'api',
    pct: progressPct,
  })
}, 2000)
```

API 结束后再瞬间跳到：

| 阶段 | pct |
|------|-----|
| attachments | 85 |
| session_start | 90 |
| hooks | 95 |
| `compact_end` | 清除 spinner |

UI 侧（`useReplLoadingState.ts` → `buildCompactProgressMessage`）用 `pct` 画 `▰▱` 条 + 百分比，**没有** CC 的 `isCompacting` 状态机。

### 2.2 CC 2.1.207 真实实现（二进制）

**没有** `stage:"api"` / 假 `setInterval` pct。事件模型极简：

```js
// applyCompactProgress（偏移 ~231974xxx）
case "hooks_start":
  // spinner 文案：Running PreCompact/PostCompact/SessionStart hooks…
case "compact_start":
  r("Compacting conversation")
  s(true, u.hintText ?? null)  // setCompacting(true, hintText)
case "compact_end":
  a()  // resetCompactionState
```

进度百分比在 **Spinner 渲染层**用墙钟时间做**渐近曲线**（不是业务层推 pct）：

```js
// JQu — 偏移 234437572
function JQu(elapsedMs) {
  const t = Math.max(0, elapsedMs) / 1000   // 秒
  const r = 1 - Math.exp(-t / 90)           // 时间常数 90s
  return Math.min(95, Math.round(r * 100))  // 封顶 95%，永不 100%
}

// Spinner 内：
// y = isCompacting, _ = compactingStartTime, k = Date.now()
// Pe 为单调 ref，百分比只增不减
const je = y && _ !== null ? Math.max(Pe.current, JQu(k - _)) : null
const Ke = je !== null ? `${je}%` : null
```

| 压缩耗时 | CC 渐近 % | zy 线性伪进度（约） |
|---------|-----------|---------------------|
| 15s | ~15% | ~31% |
| 30s | ~28% | ~52% |
| 60s | ~49% | ~80%（封顶） |
| 90s | ~63% | 80% |
| 180s | ~86% | 80% |
| 完成瞬间 | 清 spinner（不冲 100%） | 85→95 一闪后清 spinner |

**结论**：CC 的 % 是「心理进度」，故意永不填满；完成时直接卸 spinner。zy 的线性 +3%/2s 在常见 20–40s 摘要耗时下正好停在 **~40–55%**，用户体感就是「到 50% 就结束了」。

### 2.3 根因归纳（进度条）

| # | 根因 | 严重度 |
|---|------|--------|
| A1 | zy 自造线性伪进度，与 CC 渐近模型不一致 | P1 UX |
| A2 | 完成后瞬间 85/95 再 `compact_end`，用户几乎看不到「完成」态 | P1 UX |
| A3 | 缺少 CC 的 `isCompacting` / `compactingStartTime` / Spinner 侧 `JQu` | P1 |
| A4 | Session Memory 快速路径几乎不发 progress，体验割裂 | P2 |

---

## 三、问题 B：压缩后首条变成「思考内容」

### 3.1 压缩后消息顺序（两边一致）

```text
boundaryMarker (system compact_boundary)
→ summaryMessages[0]  (user, isCompactSummary + isVisibleInTranscriptOnly)
→ messagesToKeep / slash 合成消息
→ attachments / hookResults
```

`summaryMessages[0].content` 会进入后续 API 上下文（`getMessagesAfterCompactBoundary` 之后仍保留）。  
**若摘要文本是思考/草稿而非结构化 summary，后续轮次确实会被污染**——用户的担忧成立。

### 3.2 CC 如何选「摘要消息」（关键差异）

CC 二进制（偏移 ~232360432）：

```js
// zQn：优先选「含 <summary> 标签的、带 text 的 assistant」；否则 findLast 任意带 text 的 assistant
function zQn(messages) {
  const hasText = (n) =>
    n.type === "assistant" &&
    !n.isApiErrorMessage &&
    n.message.content.some((o) => o.type === "text")
  return (
    messages.findLast(
      (n) =>
        hasText(n) &&
        n.message.content.some(
          (o) => o.type === "text" && o.text.includes("<summary>"),
        ),
    ) ?? messages.findLast(hasText)
  )
}

// KQn：从 zQn 结果取第一个 text 块
function KQn(messages) {
  return zQn(messages)?.message.content.find((n) => n.type === "text")?.text.trim() || null
}
```

Fork 路径与流式路径返回前都走这套：

```js
// fork: return zQn(A.messages) ?? T
// stream: return P.isApiErrorMessage ? P : zQn(x) ?? P
// reactive: l = KQn(s.messages)
```

### 3.3 zy-code 现状

```ts
// compact.ts streamCompactSummary / reactiveCompact
const assistantMsg = getLastAssistantMessage(result.messages)
const summary = getAssistantMessageText(assistantMsg)
```

| 能力 | CC | zy-code |
|------|----|---------|
| 选消息 | `zQn`：优先含 `<summary>` | `getLastAssistantMessage`：仅最后一条 assistant |
| 抽文本 | `KQn`：第一个 text 块 | `getAssistantMessageText`：所有 text join |
| 格式化 | `MHg` ≈ `formatCompactSummary`（剥 `<analysis>`，替换 `<summary>`） | 同逻辑 |
| thinkingConfig（流式） | `Ojr(context)` = 继承主循环 thinking（不强制 disabled） | 流式路径 **disabled**；**fork 路径继承 cacheSafeParams**（thinking 可能开启） |

### 3.4 污染如何发生（机制）

1. **Fork + 开启 thinking / 多段 assistant**  
   - 摘要 agent 可能产出：thinking-only 或「纯推理 text」消息 + 真正带 `<summary>` 的消息。  
   - zy 取 **最后一条** assistant：若最后一条是推理草稿或空 text，则摘要错误/不完整。  
   - CC 用 `zQn` 显式偏好 `<summary>`。

2. **模型把 CoT 写进 text，且标签不规范**  
   - `formatCompactSummary` 只剥 **成对的** `<analysis>...</analysis>`。  
   - 标签外的长推理、未闭合标签、中文「思考过程」等会 **原样进入** summary user 消息。  
   - 进入 transcript（ctrl+o）时首屏就是大段思考；进入下一轮 API 时同样带上。

3. **SM / reactive 保留尾部时的 thinking 块**  
   - `sessionMemoryCompact.adjustIndexToPreserveAPIInvariants` 会为 tool_result 配对 **回挂** 同 `message.id` 的 thinking 条。  
   - 若索引调整不当，压缩后「第一条可见 assistant」可能是 **thinking-only**（渲染为 `∴` 思考），用户描述与此吻合。  
   - 这与「摘要文本被污染」是两条独立路径，都要修。

4. **UI 过滤**  
   - `isVisibleInTranscriptOnly` 使 summary 在普通模式不显示全文；普通模式只见「已压缩」。  
   - 用户在 **transcript / 展开** 或 **下一轮模型读到的上下文** 中看到思考内容。

### 3.5 对后续 API 的影响

| 影响 | 说明 |
|------|------|
| 上下文污染 | summary user 消息是 post-compact 主上下文；CoT 草稿会占 token 且误导模型 |
| 角色错位 | 模型可能把「上一轮思考」当成任务状态，重复推理或跑偏 |
| 体积 | 思考 dump 可能很大，削弱 compact 的 token 收益 |
| tool 配对 | SM 路径若留下 orphan thinking / 错误合并，可能 400 或丢 thinking 签名 |

**是的，会导致后续调用问题**——优先修摘要选取与格式化。

---

## 四、CC vs zy 对照总表

| 项 | CC 2.1.207 | zy-code | 状态 |
|----|------------|---------|------|
| compact 事件 | `hooks_start` / `compact_start`(+hintText) / `compact_end` | 同 + 额外 `compact_progress{stage,pct}` | 过度设计 |
| 进度 % | Spinner：`1-exp(-t/90)` 封顶 95 | 业务层线性 10→80 | ❌ 不一致 |
| `isCompacting` 状态 | 有 | 无（仅 remote session ref） | ❌ 缺失 |
| 摘要消息选取 | `zQn` / `KQn` | `getLastAssistantMessage` + join text | ❌ 缺失 zQn |
| 摘要格式化 | `MHg` 剥 analysis | `formatCompactSummary` 同构 | 基本一致，需加强 |
| summary 标记 | `isCompactSummary` + `isVisibleInTranscriptOnly` | 同 | ✅ |
| 文案模板 | `This session is being continued...` | 同 | ✅ |
| fork `skipTranscript` | true | 未对齐（需确认） | 部分 |
| fork `skipCacheWrite` | true | true | ✅ |
| 流式 thinking | `Ojr(n)` 继承 | disabled | 故意差异（可保留） |

---

## 五、修复计划

### Phase 0 — 验证与埋点（0.5d）

**目标**：用数据确认本地复现路径，避免盲改。

1. 在 `streamCompactSummary` 成功返回前临时 log：
   - `result.messages` 中 assistant 条数、每条 content 类型、是否含 `<summary>` / `<analysis>`
   - `getLastAssistantMessage` vs 拟议 `pickCompactSummaryAssistant` 选中的 uuid 是否不同
   - `formatCompactSummary` 前后字符数
2. 手动 `/compact` 两次：一次短会话、一次带 thinking 的长会话；记录 spinner 最后可见 % 与摘要预览（ctrl+o）。
3. 确认当前默认是否走 fork（`zy_compact_cache_prefix`）还是流式回退。

**验收**：有一份复现笔记（路径：fork/stream/SM；是否含 thinking）。

---

### Phase 1 — P0：摘要选取对齐 CC `zQn`/`KQn`（1d）

**目标**：绝不用「最后一条 assistant 的思考草稿」当 compact summary。

#### 1.1 新增选取工具

文件建议：`src/services/compact/summarySelection.ts`（或放入 `predicates.ts` 旁的 compact 专用模块，**不要**塞进 `utils/` 大杂烩）。

```ts
/** 对齐 CC zQn：优先含 <summary> 的 assistant，否则最后一条带 text 的 assistant */
export function pickCompactSummaryAssistant(
  messages: Message[],
): AssistantMessage | undefined

/** 对齐 CC KQn：从选中消息取 text（建议：优先 join 所有 text，与现 getAssistantMessageText 一致更稳） */
export function getCompactSummaryText(messages: Message[]): string | null
```

注意：CC 的 `KQn` 只用 **第一个** text 块；zy 现 join 全部。建议 **join 全部 text**，但消息选择必须用 zQn 语义（比 CC 更稳，不丢第二 text 块）。

#### 1.2 替换调用点

| 文件 | 现逻辑 | 改后 |
|------|--------|------|
| `compact.ts` `streamCompactSummary` fork 分支 | `getLastAssistantMessage` + `getAssistantMessageText` | `getCompactSummaryText(result.messages)`；返回 `pickCompactSummaryAssistant(...) ?? last` |
| `compact.ts` 流式分支 | 仅最后一条 `response` | 累积 assistant 数组，返回 `pick... ?? last`（对齐 CC `zQn(x)??P`） |
| `reactiveCompact.ts` | 同上 | 同上 |
| 任何其它 compact 摘要抽取 | 审计 | 统一走选取器 |

#### 1.3 测试

`tests/services/compact/summarySelection.test.ts`：

- 最后一条是 thinking-only / 纯推理 text，前一条含 `<summary>` → 选前一条  
- 仅一条含 `<summary>` → 正常  
- 仅 API error → 不误选  
- 多 text 块 join 行为  

**验收**：带 thinking 的会话 compact 后，summary 文本必含章节结构或至少含 `<summary>` 剥离后的正文，而非纯 CoT。

---

### Phase 2 — P0：加强 `formatCompactSummary`（0.5–1d）

**目标**：即使模型标签不规范，进入上下文的也只是「摘要正文」。

文件：`src/services/compact/prompt.ts`

建议算法（在现有 `MHg` 兼容基础上加强）：

```text
1. 若存在 <summary>...</summary>：
   - 只保留 summary 内正文（丢弃标签外一切内容，含未包进 analysis 的思考）
   - 格式化为 "Summary:\n..." + 原章节
2. 否则若存在 <analysis>...</analysis>：
   - 剥 analysis，用剩余文本
3. 否则：
   - 可选：剥 <thinking>...</thinking>、常见「思考过程：」前缀
   - 若过长且像 CoT（启发式），打 warn 日志，不阻断
4. 折叠多余空行
```

同步：

- 单测覆盖：标签外有长 CoT、未闭合 analysis、仅 summary、无标签  
- i18n 不涉及（内部 API 字符串）

**验收**：format 后不应再出现大段「让我先分析…」类标签外草稿（有 `<summary>` 时）。

---

### Phase 3 — P1：进度条对齐 CC 渐近模型（1–1.5d）

**目标**：不再出现「卡在 50% 结束」的体感；与 CC spinner 行为一致。

#### 3.1 状态层

在 loading/spinner 状态中增加（对齐 CC）：

```ts
isCompacting: boolean
compactingStartTime: number | null
compactingHintText: string | null
```

事件处理：

| 事件 | 行为 |
|------|------|
| `hooks_start` | 蓝 spinner 文案（已有） |
| `compact_start` | `isCompacting=true`，记录 `compactingStartTime`，文案「压缩中」 |
| `compact_end` | 复位上述字段 + override 文案 |
| `compact_progress`（可选） | 仅用于 hooks 文案 / hintText；**删除 pct 业务推送** |

#### 3.2 Spinner 渲染

```ts
function compactProgressPercent(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000
  return Math.min(95, Math.round((1 - Math.exp(-t / 90)) * 100))
}
// 用 ref 保持单调不减
```

显示：`压缩中 42%` 或 CC 风格 byline（不必强行 `▰▱` 条；若保留条，pct 必须来自 `JQu`）。

#### 3.3 删除伪进度

从 `compact.ts` / `partialCompactConversation` 删除：

- `progressTimer` / `progressPct` setInterval  
- `stage: 'api'|'attachments'|...` + 硬编码 85/90/95  

保留 `hooks_start` / `compact_start` / `compact_end` 即可。

#### 3.4 SM 快速路径

`trySessionMemoryCompaction` 成功时也发 `compact_start`→（极短）→`compact_end`，或直接 displayText，避免 spinner 行为不一致。

**验收**：

- 压缩 30s 时 % 约 25–35% 平滑上升（渐近），完成时 spinner 干净消失  
- 不再出现「固定停在 50%」的线性伪进度  
- `bun tsc --noEmit` 通过  

---

### Phase 4 — P1：SM / 保留尾部 thinking 首条问题（1d）

**目标**：压缩后 UI/API 第一条 assistant 不应是孤立 thinking。

1. 复查 `adjustIndexToPreserveAPIInvariants` 在真实 session 切片上的行为（补测试：thinking@N + tool_use@N+1）。  
2. 渲染层：对 post-compact 消息列表，若首条 `isThinkingMessage`，折叠进下一 assistant 或隐藏（与主循环 thinking 策略一致）。  
3. 确认 `normalizeMessagesForAPI` 在 compact 后不会因 thinking 丢块而 400。

**验收**：SM compact 后普通模式首条可见内容不是裸 thinking 块。

---

### Phase 5 — P2：Fork 路径加固（0.5d）

1. 评估 fork 时 `skipTranscript: true`（CC 有）——避免侧链 transcript 污染。  
2. 评估是否在 compact fork 的 `overrides` 中强制 `thinkingConfig: { type: 'disabled' }`：  
   - **优点**：摘要更短、少 thinking 块干扰  
   - **缺点**：可能破坏 cache-key 对齐（CC 注释强调 thinking 配置影响 cache）  
   - **建议**：默认保持与主线程一致（cache 优先）；依赖 Phase 1 的 zQn 纠错。仅在 fallback 流式路径继续 disabled。  
3. 对 `assistantText` 为空但存在 thinking 的情况，fallback 原因写清 `lastAssistantKind`（CC 已有 `GHg` 遥测）。

---

### Phase 6 — 回归与文档（0.5d）

1. `bun tsc --noEmit`  
2. 手测矩阵：

| 场景 | 期望 |
|------|------|
| 短会话 /compact | 成功；spinner 渐近 %；结果「已压缩」 |
| 长会话 + thinking 开 | summary 无大段 CoT；ctrl+o 摘要可读 |
| SM compact | 无错误 thinking 首条 |
| 取消 Esc | 「已取消」；无半截 summary 写入 |
| 压缩后再提问 | 模型延续任务，不复述「思考过程」 |

3. 更新 `docs/future-plan/zy-code-compact-optimization-plan.md` 交叉链接或归档说明。  
4. 清理临时提取目录 `tmp-cc-extract/`（勿提交）。

---

## 六、实施顺序与工作量

```text
Phase 0 验证埋点     ████░░░░░░  0.5d
Phase 1 zQn 选取     ████████░░  1d     ← P0 先做（影响后续 API）
Phase 2 format 加强  ██████░░░░  0.5–1d ← P0
Phase 3 进度条 JQu   ████████░░  1–1.5d ← P1（用户直接体感）
Phase 4 SM thinking  ██████░░░░  1d     ← P1
Phase 5 fork 加固    ████░░░░░░  0.5d   ← P2
Phase 6 回归文档     ████░░░░░░  0.5d
────────────────────────────────
合计约 5–6 人日
```

**推荐合并 PR 策略**：

1. **PR-A**：Phase 1+2（摘要正确性，可独立测）  
2. **PR-B**：Phase 3（进度 UX）  
3. **PR-C**：Phase 4+5（边界路径）

---

## 七、关键代码锚点（实施时直接打开）

| 主题 | 路径 |
|------|------|
| 伪进度 setInterval | `src/services/compact/compact.ts` ~445–510, 780–786 |
| 摘要抽取 | `src/services/compact/compact.ts` ~1215–1240, 1330–1365 |
| reactive 抽取 | `src/services/compact/reactiveCompact.ts` ~188–190 |
| format | `src/services/compact/prompt.ts` `formatCompactSummary` |
| 进度 UI | `src/screens/repl/useReplLoadingState.ts` `buildCompactProgressMessage` |
| 消息过滤 | `src/utils/messages/predicates.ts` `shouldShowUserMessage` / `getLastAssistantMessage` |
| Compact UI | `src/components/CompactSummary.tsx` |
| 组装 post-compact | `buildPostCompactMessages` + `processSlashCommand.tsx` ~875–917 |
| SM thinking 索引 | `sessionMemoryCompact.ts` `adjustIndexToPreserveAPIInvariants` |

---

## 八、结论（直接回答用户）

1. **进度条到 ~50% 结束**：不是压缩在 50% 失败，而是 zy 自研线性伪进度（10% 起、每 2s +3%、API 阶段封顶 80%）在常见摘要耗时下恰好停在约一半；完成后 spinner 被立刻清掉。CC 用 `isCompacting` + **`1 - exp(-t/90)` 封顶 95%** 的渐近百分比，没有这套 stage pct。  
2. **首条变成思考内容**：**会**影响后续调用。根因是摘要选取缺少 CC 的 `zQn`（优先 `<summary>`），加上 `formatCompactSummary` 无法清掉标签外的 CoT；SM 路径还可能让 thinking-only assistant 出现在保留尾部之首。  
3. **修复优先级**：先保证摘要文本正确（Phase 1–2），再对齐进度 UX（Phase 3），最后收 SM/fork 边角（Phase 4–5）。

---

## 九、附录：CC 关键偏移（2.1.207）

| 符号/字面量 | 约偏移 | 含义 |
|-------------|--------|------|
| `function zQn` / `KQn` | 232360432 | 摘要消息选取 |
| `function Ljr` / `MHg` | 232361965+ | summary 用户文案 / format |
| `function nxu` streamCompact | 232393200+ | 摘要 API（fork+stream） |
| `function JQu` | 234437572 | 渐近 compact % |
| `applyCompactProgress` | 231974641+ | hooks/compact_start/end |
| `isCompactSummary:!0` | 232383465 等 | 摘要消息标记 |
| `Compacting conversation` | 108287120 | spinner 文案 |
