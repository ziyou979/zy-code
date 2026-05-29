# Claude Code 最新版压缩策略完整梳理 & ZY-Code 融合方案

> **基于**: Claude Code v2.1.146 二进制逆向 + ZY-Code v2.1.88 源码分析
> **日期**: 2026-05-21
> **目的**: 梳理 Claude Code 原版的完整压缩架构，对比 ZY-Code 现有能力，提出融合方案

---

## 一、Claude Code 最新版压缩架构全景

### 1.1 架构概览

Claude Code v2.1.146 的压缩采用 **3 层级联 + 1 后台预计算** 的架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Claude Code 压缩触发链                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ① 后台: Precomputed Compact                                       │
│     └─ 80% 窗口时 arm → 后台 fork 预计算摘要                       │
│                                                                     │
│  ② 主线程触发点 (每次 API 调用前):                                  │
│     └─ tokenCount >= effectiveWindow - 13K ?                        │
│         ├─ YES + 有预计算结果 → 零等待 swap                         │
│         ├─ YES + 无预计算结果 → Reactive Compact (分组摘要)         │
│         └─ NO  → 正常请求                                           │
│                                                                     │
│  ③ 兜底: Prompt-Too-Long (413) 恢复                                │
│     └─ API 返回 413 → 裁剪最旧 group 后重试                        │
│                                                                     │
│  ④ 断路器: MAX_CONSECUTIVE_FAILURES = 3                            │
│     └─ 连续 3 次压缩失败 → 停止重试，避免无限循环                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 关键阈值参数（从二进制提取）

| 参数 | 值 | 函数 | 说明 |
|------|------|------|------|
| Normal Compact Threshold | `effectiveWindow - 13,000` | `A0_(H, _)` | 超过即触发压缩 |
| Precompute Threshold | `min(effectiveWindow × 0.8, normalThreshold)` | `yKK(H, _)` | 超过即后台启动预计算 |
| precomputeBufferFraction | `0.2` | `Hx8` 常量 | 即 80% 窗口 |
| Warn Threshold | `normalThreshold - 20,000` | `hKK` | UI 黄色警告 |
| Blocked Threshold | `effectiveWindow - 3,000` | `hKK` | 阻断新请求 |
| Summary Compression Ratio | ~30% | 实测 | LLM 摘要约为原文 30% |

**Token 状态分级（`hKK` 函数）**:
```
ok → warn → compact → blocked
        ↑              ↑          ↑
   threshold-20K   threshold   window-3K
```

### 1.3 策略详解

#### 策略 1: Precomputed Compact（核心创新）

**原理**：在 token 达到 80% 窗口时，后台 fork 一个 agent 提前计算摘要。当真正需要压缩时，直接 swap 预计算结果，用户零等待。

**触发链路（从二进制还原）**：

```
gb8(H) 守卫检查:
  ├─ compactionResult 为空?
  ├─ 不是 isPreFirstCompactFork?
  ├─ consecutiveFailures 为空?
  ├─ 没有 hasAttemptedReactiveCompact?
  ├─ lastTransitionReason ≠ "precomputed_compact_swap"?
  ├─ Feature flag Fb8() 开启?
  └─ isReactiveFallbackEnabled?
  全部通过 → 调用 Qb8(H) 启动预计算

Qb8(H) 启动:
  ├─ 创建 AbortController
  ├─ 记录开始时间
  ├─ 触发 PreCompact hook (可阻止)
  ├─ 后台调用 PD6 (reactive compact engine)
  └─ 存入 Fx Map, 状态: pending

JKK(H) 消费 (PTL 触发时):
  ├─ pending → await (带 abort race)
  ├─ ready  → Xj3 找边界 UUID → swap
  └─ failed → fallback 正常压缩
```

**关键设计点**：
- **后台 fork**：不阻塞主线程，用户可继续对话
- **Fx Map 状态管理**：`pending` → `ready` / `failed`
- **PreCompact Hook**：外部可阻止预计算（退出码 2 或 `{"decision":"block"}`）
- **跨 Agent 借用**：sub-agent 可检查其他 agent 的 Fx Map

#### 策略 2: Reactive Compact（反应式压缩）

**触发条件**：`tokenCount >= effectiveWindow - 13,000` 且无可用预计算结果

**执行流程**：
1. `groupMessagesByApiRound(messages)` — 按 API 轮次边界分组
2. 保留最近 N 个 group 原样
3. 对更旧的 group 发送 `BASE_COMPACT_PROMPT` 给 LLM
4. LLM 生成 9 章节结构化摘要
5. 如果摘要本身触发 PTL → 渐进丢弃最旧 group 重试（最多 `MAX_STRIP_ITERATIONS` 次）

**摘要 Prompt（9 章节）**：
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections（含完整代码片段）
4. Errors and fixes
5. Problem Solving
6. All user messages（完整列出所有非工具结果的用户消息）
7. Pending Tasks
8. Current Work
9. Optional Next Step

**输出格式**：
```
<analysis>[草稿区，最终会被剥离]</analysis>
<summary>[9 章节结构化摘要]</summary>
```

`formatCompactSummary()` 会剥离 `<analysis>` 块，只保留 `<summary>` 内容。

#### 策略 3: Cache-Sharing 压缩

**核心思想**：压缩调用复用主线程的 Prompt Cache，避免额外缓存写入。

```typescript
const result = await runForkedAgent({
  promptMessages: [summaryRequest],
  cacheSafeParams,          // 复用主线程 cache key
  querySource: 'compact',
  skipCacheWrite: true,     // 读缓存不写缓存
  maxTurns: 1,
})
```

**为什么 `skipCacheWrite: true`**？
- 压缩调用的消息序列与主线程前缀相同 → 能命中主线程的 cache
- 但压缩结果不应写入缓存（一次性使用，污染后续请求）
- 效果：压缩调用本身的 input token 成本降低约 90%

**回退路径**：如果 cache-sharing fork 失败（无文本响应 / API 错误），回退到常规流式压缩。

#### 策略 4: Partial Compact（局部压缩）

**两种方向**：
- `forward`（从前向后）：摘要旧消息，保留最近消息原样
- `up_to`（到某点为止）：摘要到指定点的前缀，供后续消息续接

**`up_to` 模式特殊之处**：
- 摘要置于新会话开头，后面跟保留的近期消息
- 第 9 章节改为"Context for Continuing Work"（而非 Optional Next Step）
- 适用于 session continuation 场景

#### 策略 5: 断路器（Circuit Breaker）

```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

连续 3 次压缩失败后停止重试，防止：
- 上下文不可恢复地超过限制时的死循环
- 每轮都发注定失败的压缩请求轰炸 API

---

## 二、ZY-Code 现有压缩架构

### 2.1 五层级联（从 v2.1.88 继承 + 独立演进）

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ZY-Code 压缩触发链                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ① Session Memory Compact（零 LLM 调用）                           │
│     └─ 后台持续提取结构化记忆 → 压缩时直接用记忆替代全文            │
│                                                                     │
│  ② Context Collapse（零 LLM 调用）                                 │
│     └─ 85% 窗口时折叠旧 span → 插入轻量占位符 → 前缀不变          │
│                                                                     │
│  ③ Auto-Compact / Reactive Compact（需 LLM）                       │
│     └─ effectiveWindow - 13K 触发 → 分组 + LLM 摘要                │
│                                                                     │
│  ④ Snip Compact（确定性裁剪）                                      │
│     └─ 80% 窗口时触发 → 保留最近 4 个 API round → 丢弃其余         │
│                                                                     │
│  ⑤ PTL 恢复 (413)                                                  │
│     └─ API 返回 413 → Context Collapse 提交暂存 span               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 ZY-Code 独有优势

| 能力 | 说明 | Claude 是否有 |
|------|------|--------------|
| Session Memory | 后台持续提取结构化记忆，压缩时零 LLM 开销 | ❌ |
| Context Collapse | 细粒度多 span 折叠，前缀不变 → 缓存命中率最高 | ❌ |
| Snip | 确定性兜底裁剪，不依赖 LLM | ❌ |
| Microcompact | 工具结果压缩（截断大输出） | ❌ |
| Partial Compact (forward/up_to) | 局部摘要，保留近期 | ✅ 有 |

---

## 三、差异对比

| 维度 | Claude Code v2.1.146 | ZY-Code (当前) |
|------|---------------------|----------------|
| **零 LLM 压缩层** | 0 | 3 (SM + Collapse + Snip) |
| **LLM 压缩层** | 3 (Precomputed + Reactive + Full) | 2 (Full + Reactive) |
| **零等待压缩** | Precomputed（后台预计算） | Session Memory（已有记忆） |
| **细粒度保留** | 无 | Context Collapse（多 span） |
| **缓存优化** | Cache-Sharing + skipCacheWrite | ❌ 无 |
| **确定性兜底** | 无 | Snip（80% 裁剪） |
| **断路器** | consecutiveFailures ≥ 3 | ✅ 有 (相同) |
| **Hook 可控** | PreCompact hook（阻止压缩） | ✅ 有 (相同) |
| **压缩调用成本** | cache-sharing 降 90% | 全价 |
| **用户感知** | 零等待（预计算命中时） | 需等待 LLM 摘要 |

---

## 四、融合方案

### 4.1 优先级排序

| 优先级 | 能力 | 收益 | 难度 | 说明 |
|--------|------|------|------|------|
| **P0** | Cache-Sharing 压缩 | 压缩成本降 90% | 低 | 仅需 `skipCacheWrite: true` + 复用 cacheSafeParams |
| **P1** | Precomputed Compact | 零等待压缩 | 中 | 需要后台 fork + 状态管理 + hook 集成 |
| **P2** | Partial Compact (up_to) | 保留近期消息 | 低 | prompt 已有，需集成到 reactive 流程 |
| **P3** | Rapid Refill Breaker | 防止压缩死循环 | 低 | 已有断路器基础，需补充大文件检测 |

### 4.2 P0: Cache-Sharing 压缩

**当前问题**：ZY-Code 的 `compact.ts` 和 `reactiveCompact.ts` 已经有 `skipCacheWrite: true`，但 cache-sharing fork 路径的完整性需要验证。

**需要做的**：
1. 确保 `runForkedAgent` 传入与主线程相同的 `cacheSafeParams`
2. 确保 fork 的 system prompt、tools、model 配置与主线程一致（cache key 匹配）
3. 添加 `zy_compact_cache_sharing_success` 遥测（已有）
4. 验证在百炼/OpenAI 等非 Anthropic provider 上的 fallback 行为

**代码变更**：
```typescript
// src/services/compact/compact.ts — 已有基础，需验证 cacheSafeParams 传递
const result = await runForkedAgent({
  promptMessages: [summaryRequest],
  cacheSafeParams,           // 关键：必须与主线程 cache key 匹配
  querySource: 'compact',
  skipCacheWrite: true,      // 读缓存不写
  maxTurns: 1,
})
```

### 4.3 P1: Precomputed Compact

**设计方案**：

```typescript
// src/services/compact/precomputedCompact.ts (新文件)

interface PrecomputedState {
  status: 'pending' | 'ready' | 'failed'
  result?: CompactionResult
  startedAt: number
  abortController: AbortController
}

// 全局状态 Map（与 Claude 的 Fx Map 对应）
const precomputedStore = new Map<string, PrecomputedState>()

/**
 * 守卫函数：判断是否应启动预计算
 */
export function shouldArmPrecomputed(
  tokenCount: number,
  model: string,
  tracking?: AutoCompactTrackingState,
): boolean {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const precomputeThreshold = Math.floor(effectiveWindow * 0.8)
  
  if (tokenCount < precomputeThreshold) return false
  if (tracking?.consecutiveFailures) return false
  // 避免刚 swap 后立即再 arm
  if (precomputedStore.has(currentSessionId)) return false
  
  return true
}

/**
 * 后台启动预计算
 */
export async function startPrecomputed(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
): Promise<boolean> {
  // 触发 PreCompact hook
  const hookResult = await triggerPreCompactHook()
  if (hookResult?.decision === 'block') return false
  
  const state: PrecomputedState = {
    status: 'pending',
    startedAt: Date.now(),
    abortController: new AbortController(),
  }
  precomputedStore.set(currentSessionId, state)
  
  // 后台 fork（不 await）
  runForkedAgent({
    promptMessages: [createUserMessage({ content: getCompactPrompt() })],
    cacheSafeParams,
    querySource: 'compact',
    skipCacheWrite: true,
    maxTurns: 1,
    overrides: { abortController: state.abortController },
  }).then(result => {
    state.status = 'ready'
    state.result = extractCompactionResult(result)
  }).catch(() => {
    state.status = 'failed'
  })
  
  return true
}

/**
 * 消费预计算结果（在正常压缩触发点调用）
 */
export async function consumePrecomputed(
  sessionId: string,
): Promise<CompactionResult | null> {
  const state = precomputedStore.get(sessionId)
  if (!state) return null
  
  if (state.status === 'ready') {
    precomputedStore.delete(sessionId)
    return state.result!
  }
  
  if (state.status === 'pending') {
    // 等待最多 5 秒
    const result = await Promise.race([
      waitForReady(state),
      sleep(5000).then(() => null),
    ])
    precomputedStore.delete(sessionId)
    return result
  }
  
  precomputedStore.delete(sessionId)
  return null // failed → fallback
}
```

**集成点**（`autoCompact.ts`）：
```typescript
// 在 shouldAutoCompact 返回 true 时
const precomputed = await consumePrecomputed(sessionId)
if (precomputed) {
  // 零等待 swap
  return { wasCompacted: true, compactionResult: precomputed }
}
// fallback 到正常 reactive/full compact
```

### 4.4 P2: Partial Compact (up_to 模式)

**场景**：reactive compact 时不是全量摘要，而是只摘要到某个分界点之前的旧消息，保留新消息原样。

**已有基础**：`prompt.ts` 中的 `PARTIAL_COMPACT_UP_TO_PROMPT` 已经定义好。

**需要做的**：
1. 在 `reactiveCompact.ts` 中添加分界点检测逻辑
2. 找到合适的 UUID 边界（最近 N 个 group 的第一条消息 UUID）
3. 用 `up_to` prompt 摘要前缀，保留后缀原样

### 4.5 P3: 大文件 Rapid Refill 检测

**问题**：如果用户读取了一个 100K token 的大文件，压缩后下一轮该文件又被重新注入 → 立即重新触发压缩 → 死循环。

**Claude 的做法**（从二进制推断）：
- 检测压缩后到下一次触发的 turn 间隔
- 如果 < 2 轮就重新触发 → 认为是 rapid refill
- 启动熔断：跳过本次压缩，标记 `hasAttemptedReactiveCompact`

**ZY-Code 融合**：
```typescript
// 在 autoCompact 中添加
if (tracking?.compacted && tracking.turnCounter < 2) {
  logEvent('zy_rapid_refill_detected', { turnCounter: tracking.turnCounter })
  return { wasCompacted: false } // 跳过本次，避免死循环
}
```

---

## 五、预期收益（基于真实 580 轮对话验证）

基于 `scripts/compact-real.ts` 对真实 580 轮对话的渐进模拟：

| 策略 | 压缩次数 | 平均间隔 | 缓存命中率 | 费用 vs baseline |
|------|---------|---------|-----------|-----------------|
| ZY Context Collapse | 4 次 | 169 turn | 99.0% | **省 67.3%** |
| Claude Precomputed | 4 次 | 134 turn | 98.7% | 省 66.5% |
| ZY Full Compact | 4 次 | 140 turn | 98.7% | 省 68.3% |
| ZY Reactive | 6 次 | 99 turn | 98.5% | 省 61.4% |

**融合后预期**：
- **Context Collapse + Precomputed + Cache-Sharing** 三者组合
- Context Collapse 在 85% 时低成本折叠 → 推迟 Full Compact 触发
- 万一需要 Full Compact → Precomputed 零等待 + Cache-Sharing 降成本
- 预期总费用比纯 Claude 策略再省 5-10%

---

## 六、实施路线图

```
Phase 1 (1 周):
  └─ P0: 验证 cache-sharing 在 ZY-Code 的完整性
  └─ P3: 添加 rapid refill 检测（3 行代码）

Phase 2 (2 周):
  └─ P1: 实现 precomputedCompact.ts
  └─ 集成到 autoCompact.ts 触发链
  └─ 添加 PreCompact hook 支持

Phase 3 (1 周):
  └─ P2: 集成 partial compact (up_to) 到 reactive 路径
  └─ 端到端测试：验证 collapse → precomputed → cache-sharing 级联
```

---

## 七、注意事项

1. **Provider 兼容性**：Cache-Sharing 和 Precomputed 依赖 Anthropic Prompt Cache。对于百炼等其他 provider，需要 fallback 到常规压缩路径。
2. **Context Collapse vs Precomputed 的哲学差异**：
   - Collapse 优先保留缓存（前缀不变）
   - Precomputed 优先保留体验（零等待）
   - ZY-Code 的优势在于**两者可以共存**：先用 Collapse 推迟，逼不得已时再用 Precomputed
3. **Session Memory 的独特价值**：在国内 provider（无 Prompt Cache）场景下，SM 的零 LLM 开销优势更为突出。

---

## 八、其他 Agent 的压缩策略调研 & 可借鉴思路

### 8.1 策略总览

| Agent/框架 | 核心思路 | 关键创新 | ZY-Code 可借鉴度 |
|-----------|---------|---------|------------------|
| **Cursor** | Dynamic Context Discovery | 长输出→文件化，按需读取 | ⭐⭐⭐⭐ |
| **Cline** | Focus Chain + Auto Compact | Todo 锚定注意力 + 压缩时保留 | ⭐⭐⭐ |
| **Manus** | KV-Cache First + 文件系统即上下文 | append-only + logit mask | ⭐⭐⭐⭐⭐ |
| **JetBrains Research** | Observation Masking | 删旧 observation 比摘要还好 | ⭐⭐⭐⭐ |
| **Forge** | 序列模式识别 + 选择性压缩 | 只压特定模式，保留用户消息 | ⭐⭐⭐ |
| **LangGraph** | Write/Select/Compress/Isolate | 四类策略框架化 | ⭐⭐⭐ |
| **MemGPT** | 分层内存 (OS 虚拟内存隐喻) | 自动 page-in/out | ⭐⭐⭐⭐ |
| **Google ADK** | Compiled View (编译视图) | 每步计算最小必要上下文 | ⭐⭐⭐⭐ |

---

### 8.2 Cursor: Dynamic Context Discovery（动态上下文发现）

**核心理念**：不要截断，而是将长内容变成**按需可读的文件**。

#### 关键策略

1. **长工具输出 → 写入文件**
   - 常规做法：截断超长 shell/MCP 输出 → 信息丢失
   - Cursor 做法：写入文件 → agent 用 `tail`/`read` 按需读取
   - 效果：减少不必要的 summarization 次数

2. **Chat History 作为文件辅助 Summarization**
   - 压缩后，给 agent 一个指向完整历史文件的引用
   - 如果 agent 发现摘要遗漏了细节 → 搜索历史文件恢复
   - 本质：**有损压缩 + 可选无损回溯**

3. **MCP 工具描述动态加载**
   - 不将所有 MCP 工具描述塞入 prompt
   - 而是同步到文件夹，只给 agent 工具名列表
   - agent 按需 grep/jq 查找工具详情
   - A/B 测试结果：**agent 总 token 减少 46.9%**

4. **终端输出 → 文件系统**
   - 集成终端输出同步到本地文件
   - agent 可以 grep 找到相关输出片段

#### ZY-Code 融合点

```
【可直接借鉴】
├─ 大工具结果写入临时文件，context 中只保留摘要 + 文件路径引用
├─ 压缩后保留 transcript 文件引用（ZY-Code 已有！见 getCompactUserSummaryMessage）
└─ MCP 工具描述按需加载（减少静态 system prompt 膨胀）
```

---

### 8.3 Manus: KV-Cache First 设计哲学（最值得学习）

**核心理念**：KV-Cache 命中率是生产级 Agent 的**唯一最重要指标**。

#### 三大原则

1. **Prompt 前缀稳定**
   - ❌ 在 system prompt 开头放秒级时间戳 → 每次请求缓存全废
   - ✅ 时间信息放 context 末尾或工具结果中
   - Manus 的 input:output token 比约 **100:1**，缓存对成本影响巨大

2. **Context Append-Only（只追加不修改）**
   - 永远不修改已有的 action/observation
   - JSON 序列化要确保 key 顺序确定性（很多语言不保证）
   - 这与 ZY-Code 的 Context Collapse 理念完全一致（前缀不变 → cache 命中）

3. **Mask, Don't Remove（遮蔽，不移除工具）**
   - ❌ 动态增删工具定义 → 使前缀 KV-cache 失效
   - ✅ 工具定义始终不变，通过 **logit masking** 控制可选工具
   - 工具名用统一前缀（`browser_*`, `shell_*`）便于组级控制

#### 文件系统即上下文

```
问题：context window 有限、长 input 贵、性能随长度下降
方案：文件系统作为无限「外部上下文」

├─ Todo.md → 持久化计划（不受 context reset 影响）
├─ 大输出写入文件 → context 只存引用
├─ Agent 可以随时 read/grep 文件恢复信息
└─ 文件天然是 structured、durable、unlimited 的
```

#### ZY-Code 融合点

```
【优先级最高的借鉴】
├─ P0: 审计 system prompt 中的动态内容，确保 cache-breaking 最小化
│   └─ 检查是否有时间戳/随机ID/动态工具列表在前缀中
├─ P1: 大工具结果外化为文件（Cursor 同理）
│   └─ bash 输出 > 10K → 写入 /tmp/.zy-tool-output/{uuid}.txt
│   └─ context 中只保留 "Output written to /tmp/... (42K tokens). Use Read to inspect."
└─ P2: MCP/动态工具用 logit mask 代替动态增删
    └─ 避免 tool 定义变化导致 cache 失效
```

---

### 8.4 JetBrains Research + "The Complexity Trap": Observation Masking

**核心发现**：简单删除旧 observation 的效果 **≥ LLM 摘要**，且成本更低。

#### 研究结论（NeurIPS 2025 DL4Code Workshop）

| 策略 | SWE-bench 解决率 | 额外成本 | 说明 |
|------|-----------------|---------|------|
| Raw Agent（不压缩） | 基线 | 0 | 上下文爆炸后失败 |
| Observation Masking | ≈ LLM摘要 | **0** | 旧 observation → 占位符 |
| LLM Summarization | 基线+少许 | **5-7%** | OpenHands 方案 |

**关键洞察**：
- LLM 摘要会导致 **"trajectory elongation"**（轨迹延长）— agent 在失败路径上继续坚持
- 因为摘要保留了旧的推理链，agent 不愿放弃沉没成本
- 简单遮蔽反而让 agent 更容易 "fresh start" 重新思考

**实验设计**：
```
Observation Masking:
  ├─ 保留: Agent 的 reasoning + action（完整）
  ├─ 遮蔽: 旧 observation（工具结果）→ "[Output omitted for brevity]"
  └─ 窗口: 最近 K 个 observation 保留原样

对比 LLM Summarization:
  ├─ 压缩: 整个 trajectory（reasoning + action + observation）
  └─ 替换: 生成摘要替代原始历史
```

#### ZY-Code 融合点

```
【强烈建议引入的新策略层】

在 Snip 之前增加 "Observation Masking" 层：
├─ 触发条件: tokenCount >= effectiveWindow × 0.7（早于 Snip 的 0.8）
├─ 操作: 
│   ├─ 遍历 messages，找到所有 tool_result 类型
│   ├─ 保留最近 K 个 tool_result 原样（K=8~12）
│   ├─ 更旧的 tool_result → 替换为占位符:
│   │   "[Tool result from {tool_name}: {first_line}... ({N} tokens omitted)]"
│   └─ 保留所有 user messages 和 assistant reasoning 完整
├─ 优势:
│   ├─ 零 LLM 调用成本
│   ├─ 前缀不变 → cache 命中率不受影响（与 Collapse 互补）
│   ├─ 避免"轨迹延长"问题
│   └─ 实现极简（< 50 行代码）
└─ 与现有策略关系: Context Collapse 之前触发，进一步推迟 LLM 压缩
```

---

### 8.5 Cline: Focus Chain（注意力锚定）

**核心理念**：压缩不可怕，可怕的是压缩后 **丢失方向**。

#### 机制

1. **任务开始时生成 todo list**
2. **每 6 条消息重新注入** todo 到 context 中
3. **压缩时 todo 不被压缩** — 作为锚点贯穿整个会话
4. **用户可编辑 todo** → agent 自动适应新计划

#### /newtask 模式

```
当前任务完成 or context 过重时：
├─ 打包: 计划 + 决策 + 相关文件 + 下一步
├─ 开启: 全新 context（干净石板）
└─ 效果: 相当于带着精简 briefing 换一个 agent 继续

比喻：不是「给旧员工清理桌面」，而是「给新员工一份完美的交接文档」
```

#### ZY-Code 融合点

```
【中等优先级】
├─ 方案 A: 在 compact prompt 中注入当前 todo/goal 作为 mandatory retain
│   └─ 确保摘要始终包含「当前目标」「未完成任务」
│   └─ ZY-Code 已有第 7/8/9 章节覆盖，但可强化
├─ 方案 B: 每 N 轮自动 re-inject system prompt 的关键指令
│   └─ 防止 system prompt 在长对话中被"attention dilution"淹没
└─ 方案 C: /newtask 等价 → 基于 Session Memory 的「零成本新会话」
    └─ SM 提取后 → 自动开新 context + 注入 SM 作为 briefing
```

---

### 8.6 Forge: 序列模式识别 + 选择性压缩

**核心理念**：不要全量压缩，只压缩 **特定模式** 的消息序列。

#### 可压缩序列模式

```
[Assistant Message] → [Tool Call] → [Tool Result] → [Assistant Message]

只有这种「工具调用-结果-分析」的完整序列才会被压缩。
用户消息永远保持原样。
```

#### 独特设计

| 特性 | 说明 |
|------|------|
| 不同模型压缩 | 用 Gemini Flash 做压缩（便宜+快） |
| Retention Window | 最近 N 条消息免压缩 |
| Entropy Analysis | 摘要的信息密度检查 |
| 多触发器 | token阈值 / turn阈值 / 消息数阈值 |

#### ZY-Code 融合点

```
【低优先级，但有启发性】
├─ 用便宜模型做压缩（如 Haiku/Flash）→ 进一步降低压缩成本
│   └─ Claude Code 用同模型压缩（贵），可选 cheaper model
└─ Entropy 检查 → 验证摘要质量（避免低质量摘要导致后续误解）
```

---

### 8.7 MemGPT / Google ADK: 分层内存 & 编译视图

**核心理念**：像 OS 管理虚拟内存一样管理 Agent 上下文。

#### MemGPT 分层架构

```
┌─────────────────────┐
│   Main Context      │ ← 「RAM」: 当前工作集
│   (Working Memory)  │
├─────────────────────┤
│   ↕ Auto Page       │ ← 「页表」: 按相关性自动换入换出
├─────────────────────┤
│   External Storage  │ ← 「磁盘」: 向量库/文件/数据库
│   (Archival Memory) │
└─────────────────────┘

当 context 满时：
1. 评估每条消息的「活跃度」和「相关性」
2. 低活跃消息 page-out 到外部存储
3. 需要时通过 retrieval page-in 回来
```

#### Google ADK: Compiled View（编译视图）

```
传统做法: append everything（每步都追加，越来越大）
ADK 做法: compile what's relevant（每步重新计算最小必要上下文）

每一步 agent 看到的不是「完整历史」，而是：
├─ 系统指令（固定）
├─ 当前任务状态（从外部 state 读取）
├─ 最近 K 步的 action/observation（滑动窗口）
└─ 检索到的相关历史片段（RAG）
```

#### ZY-Code 融合点

```
【长期方向 — 架构升级】
├─ Session Memory 已经是 ZY-Code 的 "Archival Memory"
├─ Context Collapse 已经是 "Page-out" 的一种形式
├─ 缺失的是: "选择性 Page-in"（基于当前任务 RAG 回忆相关历史）
└─ 远期愿景:
    ├─ 每次 query 前，不是 append 全部历史
    ├─ 而是 compile: system + recent(K) + retrieve(relevant SM entries)
    └─ 这就是 Context Collapse + Session Memory 的自然终极形态
```

---

### 8.8 核心洞察总结

**三个反直觉发现**：

1. **简单删除 > LLM 摘要**（JetBrains/Complexity Trap）
   - 摘要保留了错误路径的推理链 → agent 沉没成本效应
   - 直接遮蔽 observation → agent 更容易重新开始

2. **文件化 > 截断**（Cursor/Manus）
   - 截断 = 信息丢失
   - 写入文件 = 信息保留 + 按需恢复
   - agent 知道信息在哪 → 需要时自己去找

3. **缓存稳定 > 压缩激进**（Manus）
   - 修改前缀的压缩成本 = 压缩本身 + 后续所有请求重建 cache
   - 保前缀稳定的轻量压缩 > 激进但破坏缓存的深度压缩

---

### 8.9 ZY-Code 融合优先级（综合所有 Agent 调研）

| 优先级 | 策略 | 来源 | 改动量 | 预期收益 |
|--------|------|------|--------|----------|
| **P0** | Observation Masking 层 | JetBrains/SWE-agent | ~50行 | 零成本减 30-50% token |
| **P0** | 大工具结果文件化 | Cursor/Manus | ~100行 | 减少 context 膨胀速度 |
| **P1** | System Prompt 缓存稳定性审计 | Manus | 审计 | 提升 cache 命中率 |
| **P1** | Precomputed Compact | Claude Code | ~300行 | 零等待压缩体验 |
| **P2** | Focus Chain (todo re-injection) | Cline | ~50行 | 压缩后方向不丢失 |
| **P2** | 压缩用便宜模型 | Forge | 配置 | 压缩成本降 70%+ |
| **P3** | Compiled View (选择性历史) | Google ADK/MemGPT | 架构 | 终极方案 |

---

### 8.10 Hermes Agent（Nous Research）: 双层压缩 + 记忆冲刷

**核心理念**：**压缩前先保存记忆，压缩后重建上下文**——不是简单截断，而是一套完整的生命周期管理。

#### 双层架构（故意错开阈值）

```
┌────────────────────────────────────────────────┐
│            Hermes 双层压缩架构                  │
├────────────────────────────────────────────────┤
│                                                │
│  Layer 1: Agent Compressor (50% 窗口)          │
│  ├─ 在 agent loop 内部触发                     │
│  ├─ 使用精确的 API-reported token count        │
│  └─ 4-phase 算法（见下）                       │
│                                                │
│  Layer 2: Gateway Safety Net (85% 窗口)        │
│  ├─ 在 agent 处理消息之前触发                  │
│  ├─ 使用粗略字符估算 token                     │
│  └─ 只负责捕获隔夜/跨 session 膨胀             │
│                                                │
│  ⚠️ 两者阈值必须错开！                         │
│  设为相同值(50%) → 每轮都触发过早压缩          │
│                                                │
└────────────────────────────────────────────────┘
```

#### 4-Phase 压缩算法

```
Phase 1: Prune Old Tool Results (零 LLM 调用)
  └─ 中间段的 tool 结果 > 200 字符 → 替换为占位符
  └─ 类似 ZY-Code 的 Microcompact

Phase 2: Determine Boundaries
  ├─ 保护头部 3 条消息（system + 首轮交互）
  ├─ 保护尾部：从末尾回溯到 20K token 预算耗尽
  ├─ 至少保留 protect_last_n=20 条
  └─ _align_boundary_backward(): 不拆分 tool_call/tool_result 对

Phase 3: Summarize Middle (LLM 调用)
  ├─ 结构化模板保留: 目标、约束、进展、决策、引用、下一步
  ├─ 可用不同模型（默认 Gemini Flash，便宜+快）
  └─ 摘要 max_tokens = min(window × 0.05, 12000)

Phase 4: Reassemble
  ├─ 确保 user/assistant 交替（选择合适 role）
  ├─ 清理孤儿 tool_call/tool_result
  └─ 插入 [CONTEXT COMPACTION] 前缀标记
```

#### 🌟 Pre-Compression Memory Flush（最值得借鉴）

```python
# 压缩前：自动提取记忆
flush_content = (
    "[System: The session is being compressed. "
    "Save anything worth remembering — prioritize user preferences, "
    "corrections, and recurring patterns over task-specific details.]"
)
# → 发送给 LLM + memory_tool → 保存关键信息到持久存储
# → 然后才执行压缩
```

#### Post-Compression 恢复

```
压缩完成后：
├─ 1. 注入 todo snapshot（从独立 TODO store 获取）
├─ 2. 重建 system prompt（memories 可能已变化）
├─ 3. 清除旧 system prompt 缓存
└─ 4. 重置 session 计数器
```

#### Hermes 配置参数

```yaml
compression:
  enabled: true
  threshold: 0.50       # 50% 窗口触发
  target_ratio: 0.20    # 尾部 token 预算 = threshold × 0.20
  protect_last_n: 20    # 最少保留最近 20 条
auxiliary:
  compression:
    model: null          # 压缩模型（null=主模型）
    provider: auto       # 支持切换到更便宜的模型
```

#### ZY-Code 融合点

| 特性 | ZY-Code 现状 | 建议动作 |
|------|------------|----------|
| Pre-compression memory flush | Session Memory 独立运行 | **合并**: SM 提取 + compact 触发联动 |
| Post-compression todo injection | 无 | **新增**: compact 后注入当前 goal/todo |
| 双层阈值错开 | Context Collapse 85% + Auto-compact | 已有，但可优化阈值分布 |
| 不同模型做压缩 | 用主模型 | **考虑**: 用 Haiku/Flash 降低成本 |
| 压缩后重建 system prompt | 不重建 | **考虑**: 避免 stale system prompt |

---

### 8.11 OpenAI Codex CLI: Handoff Summary（交接摘要）

**核心理念**：把压缩视为「**工作交接**」——不是给自己记笔记，而是给下一个接手的人写 briefing。

#### 双路径设计

```
┌──────────────────────────────────────┐
│ provider.is_openai() ?               │
├─── YES ─→ Remote Path                │
│           POST /responses/compact    │
│           返回加密不透明 blob         │
│           服务器内部使用相同 prompt    │
├─── NO ──→ Local Path                 │
│           客户端调用 LLM 生成摘要     │
│           完全可见的 prompt            │
└──────────────────────────────────────┘
```

#### Handoff Prompt（交接 Prompt）

```markdown
# 压缩 Prompt（发送给 LLM）
You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.

# 交接前缀（放在摘要前面）
Another language model started to solve this problem and produced
a summary of its thinking process. You also have access to the state
of the tools that were used by that language model. Use this to build
on the work that has already been done and avoid duplicating work.
```

#### 独特设计决策

| 设计 | 说明 | 与 Claude Code 的差异 |
|------|------|---------------------|
| **摘要作为 user message** | 不是 system/assistant | Claude 用 assistant message |
| **用户消息按内容保留** | 最近的 user 消息保留到 20K token | Claude 保留最近 N 个 round |
| **System context 全量重建** | 压缩后剥离旧 system prompt，重新注入 | Claude 保持原 system |
| **支持自定义压缩 prompt** | `config.compact_prompt` 覆盖 | Claude 不支持自定义 |
| **多次压缩降级警告** | 提示用户精度会下降 | Claude 无警告 |
| **模型切换感知** | 切换到小窗口模型前先压缩 | Claude 无此逻辑 |

#### OpenAI Server-Side Compaction API（2026 新）

```python
# 方式 1: 自动触发（推荐）
response = client.responses.create(
    model="gpt-5.3-codex",
    input=conversation,
    context_management=[{"type": "compaction", "compact_threshold": 200000}],
)
# → 超过阈值时自动压缩，返回加密 compaction item

# 方式 2: 显式调用
compacted = client.responses.compact(
    model="gpt-5.5",
    input=long_input_items_array,
)
# → 返回压缩后的 context window，直接用于下次请求
```

**关键特性**：
- 返回的 compaction item 是加密的，不可人读
- 内含 key state + reasoning，比普通摘要信息更丰富
- 支持 stateless chaining（无需 session）
- ZDR-friendly（`store=false` 时不存储对话）

#### ZY-Code 融合点

```
【强烈建议采纳的】
├─ Handoff 框架：把压缩 prompt 从「给自己看的笔记」改为「给下一个 agent 的交接文档」
│   └─ ZY-Code 的 BASE_COMPACT_PROMPT 已经很好，可增加 handoff framing
├─ User message 保留策略：按语义（所有 user 消息）而非位置（最近 N 轮）
│   └─ 确保用户的所有指令和反馈都不丢失
├─ 压缩后 system prompt 重建：避免 stale 系统指令
│   └─ 特别是 dynamic tools/rules 变化后
└─ 多次压缩降级警告：告诉用户「精度可能下降」
    └─ 提高用户信任度和可预期性
```

---

### 8.12 Pi Agent + OpenClaw: 极简主义 + 虚拟文件系统

**Pi 的核心哲学**：**「不压缩」是最好的压缩**——通过架构设计避免需要压缩。

#### Pi 的反压缩设计

```
Pi 认为压缩是次优解，更好的做法是：
├─ Session Trees（会话树）：可分支、回退、跳转
│   └─ 不怕污染 context → 开新分支实验 → 合并结果
├─ 极简 System Prompt（< 1000 tokens）
│   └─ 减少固定开销 → 留更多空间给对话
├─ 按需加载工具（读 README 而非全量 MCP）
│   └─ 类似 Cursor 的 Dynamic Context Discovery
├─ 状态外化为文件（TODO.md, PLAN.md）
│   └─ context 丢了没关系，文件还在
└─ 新实例代替压缩
    └─ 需要新 context 时 → spawn 新 Pi + 传入精简 briefing
```

#### pi-agentic-compaction 扩展（社区实现）

```
当确实需要压缩时（社区扩展）：
├─ 使用虚拟文件系统存储旧 context 的结构化索引
├─ agent 可以 grep/read 虚拟文件来恢复信息
├─ 本质上 = Cursor 的「写入文件」策略
└─ 与 Pi 的文件优先哲学一致
```

#### OpenClaw（基于 Pi 内核）的压缩策略

```
OpenClaw 在 Pi 基础上添加了完整压缩支持：
├─ Pre-compaction Memory Flush（与 Hermes 相同理念）
│   └─ 压缩前自动提醒 agent 保存重要笔记到 memory 文件
├─ Session Pruning（轻量级，与 Compaction 分离）
│   └─ 只裁剪旧 tool results（不改 transcript）
│   └─ 类似 ZY-Code 的 Microcompact
├─ Successor Transcripts
│   └─ 压缩不重写原文件，而是创建新的 successor 文件
│   └─ 旧文件保留为 archived checkpoint
├─ Identifier Preservation（标识符保护）
│   └─ 压缩时保留 opaque identifiers（文件路径、变量名等）
│   └─ 策略: strict / off / custom
├─ Pluggable Compaction Provider
│   └─ 支持插件注册自定义压缩引擎
│   └─ 内置 LLM 管线作为 fallback
└─ Model Fallback Chain
    └─ 压缩模型失败 → 沿 fallback 链尝试其他模型
```

#### ZY-Code 融合点

```
【Pi/OpenClaw 的可借鉴之处】
├─ P0: Session Trees 思路 → 「压缩时保留分支回退能力」
│   └─ ZY-Code 已有 transcript 文件引用，可增强为 checkpoint
├─ P1: Identifier Preservation
│   └─ 确保压缩不丢失文件路径、函数名等关键标识符
│   └─ 在 compact prompt 中明确要求保留 identifiers
├─ P1: Successor Transcripts（不覆写原文件）
│   └─ 压缩后创建新 context 文件，旧的保留为 checkpoint
│   └─ 支持「时间旅行」回到压缩前状态
├─ P2: Pluggable Compaction Provider
│   └─ 支持用户自定义压缩策略（百炼/OpenAI/本地模型）
└─ P3: 极简 System Prompt 理念
    └─ 审计当前 system prompt 大小，移除不必要的静态内容
    └─ 将低频工具描述改为按需加载
```

---

### 8.13 Factory.ai: 压缩质量评估框架

**核心贡献**：第一个系统性**评估**不同压缩策略信息保留度的框架。

#### 评估结论（2025.12）

| 策略 | 信息保留度 | 说明 |
|------|-----------|------|
| **结构化摘要** | 最高 | 按章节保留 task context |
| OpenAI /responses/compact | 中等 | 服务器加密，不可调 |
| Anthropic SDK 压缩 | 中等 | 通用压缩，不够 task-specific |
| 简单截断 | 最低 | 直接丢信息 |

**关键发现**：
- 结构化摘要（按章节模板）> 通用 LLM 摘要 > 截断
- 最容易丢失的信息：精确值约束、用户偏好、隐式依赖关系
- 压缩质量应该被**量化评估**，而非凭感觉

#### ZY-Code 融合点

```
【中等优先级】
├─ 构建压缩质量评估 pipeline
│   └─ 压缩前后对比: 关键实体保留率、任务可续性评分
│   └─ 用于 A/B 测试不同压缩策略
└─ 结构化摘要已是 ZY-Code 的做法（9 章节），验证其优势
```

---

### 8.14 跨 Agent 策略对比矩阵（完整版）

| 维度 | Claude Code | ZY-Code | Hermes | Codex CLI | Pi/OpenClaw |
|------|------------|---------|--------|-----------|-------------|
| **触发阈值** | window-13K | 同左 + 85% Collapse | 50% + 85% 双层 | 接近窗口限制 | N/A (不压缩) |
| **零 LLM 层** | 0 | 3 (SM+Collapse+Snip) | 1 (tool prune) | 0 | Session Trees |
| **摘要框架** | 9 章节 | 9 章节 | 结构化模板 | Handoff Summary | N/A |
| **压缩前保护** | 无 | Session Memory | Memory Flush | 保留 user messages | Memory Flush |
| **压缩后恢复** | transcript 引用 | transcript 引用 | Todo注入+SP重建 | SP重建+降级警告 | Successor Transcript |
| **压缩模型** | 主模型 | 主模型 | 可选（Flash） | 主模型/API | 可选 |
| **用户消息** | 随摘要消失 | 随摘要消失 | 随摘要消失 | **保留原始** | 随摘要消失 |
| **Cache 优化** | Cache-Sharing | Context Collapse | 无特殊 | 无特殊 | N/A |
| **可配置性** | 低 | 低 | 高（yaml） | 中（env var） | 高（extensions） |
| **评估机制** | 无 | 无 | 无 | 降级警告 | 无 |

---

### 8.15 终极融合建议（综合所有 Agent 调研）

| 优先级 | 策略 | 来源 | 改动量 | 预期收益 |
|--------|------|------|--------|----------|
| **P0** | Observation Masking 层 | JetBrains/SWE-agent | ~50行 | 零成本减 30-50% token |
| **P0** | 大工具结果文件化 | Cursor/Manus/Pi | ~100行 | 减缓 context 膨胀速度 |
| **P0** | Pre-compact Memory Flush | Hermes/OpenClaw | ~80行 | **避免压缩丢失关键信息** |
| **P1** | Handoff Framing | Codex CLI | ~20行 | 提升压缩后续接质量 |
| **P1** | Post-compact Todo/Goal Re-injection | Hermes/Cline | ~50行 | 压缩后方向不丢失 |
| **P1** | User Message Preservation | Codex CLI | ~100行 | 用户指令永不丢失 |
| **P1** | Precomputed Compact | Claude Code | ~300行 | 零等待压缩体验 |
| **P2** | System Prompt 缓存稳定性审计 | Manus | 审计 | 提升 cache 命中率 |
| **P2** | 压缩用便宜模型 | Hermes/Forge | 配置 | 压缩成本降 70%+ |
| **P2** | Successor Transcripts (checkpoint) | OpenClaw | ~150行 | 支持回退到压缩前 |
| **P3** | Compiled View 架构 | Google ADK/MemGPT | 架构 | 终极方案 |
| **P3** | 压缩质量评估 Pipeline | Factory.ai | ~200行 | 量化对比优化 |

---

### 8.16 建议的演进路线（更新版）

```
Phase 0 — 立即可做 (1 周):
  ├─ Observation Masking（70% 阈值，保留最近 10 个 tool_result）
  ├─ 大工具结果外化为文件（bash > 10K, read_file > 20K → 写文件）
  ├─ Pre-compact Memory Flush:
  │   └─ 在 compact 触发前调用 SM extraction 确保关键信息已保存
  └─ 验证 system prompt 中无 cache-breaking 动态内容

Phase 1 — 短期增强 (2-3 周):
  ├─ Compact Prompt 加入 Handoff Framing（Codex 风格）
  ├─ User Message Preservation（压缩时保留所有 user 消息原文）
  ├─ Post-compact Todo/Goal Re-injection
  ├─ Precomputed Compact（后台预计算 + 零等待 swap）
  └─ 压缩后多次降级警告

Phase 2 — 中期优化 (1 月):
  ├─ 用 Haiku/Flash 做压缩（A/B 测试质量）
  ├─ Successor Transcripts（不覆写原文件）
  ├─ Identifier Preservation Policy（保护路径/变量名）
  └─ 构建压缩质量评估 pipeline

Phase 3 — 远期架构 (2 月):
  └─ Compiled View 架构：
      ├─ 每次 query 前 compile minimal context
      ├─ = system + recent(K) + SM_entries(relevant) + collapse_view
      └─ 不再是『压缩旧的』，而是『只选需要的』
```
