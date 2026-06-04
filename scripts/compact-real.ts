#!/usr/bin/env bun
/**
 * 真实压缩策略对比演示
 *
 * 使用方式：
 *   bun run scripts/compact-real.ts <conversation.json|conversation.jsonl>
 *
 * 支持的输入格式：
 * 1. 简化 JSON: [{role: "user"|"assistant", content: "..."}]
 * 2. JSONL transcript: 每行一个 {role, message: {content: [...]}} 对象
 * 3. ZY-Code session JSONL: 每行 {type: "user"|"assistant", message: {content: ...}}
 *
 * 关键区别：本脚本直接 import 项目中的 groupMessagesByApiRound，
 * 使用与生产代码完全相同的分组算法，而非模拟。
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// ════════════════════════════════════════════════════════════════════════════
// 直接 import 项目中真实的分组算法（零外部依赖）
// ════════════════════════════════════════════════════════════════════════════
import { groupMessagesByApiRound } from '../src/services/compact/grouping.js'

// ════════════════════════════════════════════════════════════════════════════
// 内部 Message 类型（与项目 types/message.ts 兼容的最小子集）
// ════════════════════════════════════════════════════════════════════════════

interface InternalMessage {
  uuid: string
  timestamp: string
  type: 'user' | 'assistant' | 'system'
  message: {
    id?: string
    role: string
    content: string | ContentBlock[]
  }
  isMeta?: boolean
  subtype?: string
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
  input?: unknown
  content?: string | ContentBlock[]
  thinking?: string
  data?: string
}

// ════════════════════════════════════════════════════════════════════════════
// Token 估算（与 src/services/tokenEstimation.ts 完全一致的算法）
// ════════════════════════════════════════════════════════════════════════════

/** 粗略估算: content.length / bytesPerToken。与 roughTokenCountEstimation 一致 */
function roughTokenCount(text: string, bytesPerToken = 4): number {
  return Math.round(text.length / bytesPerToken)
}

/** 检测文本语言并返回对应的 bytes-per-token (与 getBytesPerTokenForLanguage 一致) */
function detectBpt(text: string): number {
  const sample = text.slice(0, 5000)
  const chineseChars = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  const ratio = chineseChars / Math.max(1, sample.length)
  if (ratio > 0.2) return 1.5 // 中文为主
  if (ratio > 0.05) return 2.5 // 中英混合
  return 4 // 英文为主
}

/** 计算单条消息的 token 数 — 与 roughTokenCountEstimationForMessage 一致 */
function messageTokens(msg: InternalMessage, bpt: number): number {
  const content = msg.message.content
  if (typeof content === 'string') {
    return roughTokenCount(content, bpt)
  }
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) {
      total += blockTokens(block, bpt)
    }
    return total
  }
  return 0
}

function blockTokens(block: ContentBlock, bpt: number): number {
  if (block.type === 'text' && block.text) {
    return roughTokenCount(block.text, bpt)
  }
  if (block.type === 'tool_call') {
    return roughTokenCount((block.name ?? '') + JSON.stringify(block.input ?? {}), bpt)
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return roughTokenCount(block.content, bpt)
    if (Array.isArray(block.content)) {
      let total = 0
      for (const sub of block.content) total += blockTokens(sub, bpt)
      return total
    }
    return 0
  }
  if (block.type === 'thinking' && block.thinking) {
    return roughTokenCount(block.thinking, bpt)
  }
  if (block.type === 'image' || block.type === 'document') {
    return 2000 // 固定估计值，与项目一致
  }
  // 兜底：序列化
  return roughTokenCount(JSON.stringify(block), bpt)
}

/** 计算消息列表的总 token 数 */
function totalTokensForMessages(messages: InternalMessage[], bpt: number): number {
  let total = 0
  for (const msg of messages) {
    total += messageTokens(msg, bpt)
  }
  return total
}

// ════════════════════════════════════════════════════════════════════════════
// 输入文件解析
// ════════════════════════════════════════════════════════════════════════════

interface SimpleMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function parseInputFile(filePath: string): InternalMessage[] {
  const raw = readFileSync(filePath, 'utf-8').trim()

  // 尝试 JSON 数组格式
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw) as SimpleMessage[]
    return parsed.map((m, i) => simpleToInternal(m, i))
  }

  // JSONL 格式：每行一个 JSON 对象
  const lines = raw.split('\n').filter((l) => l.trim())
  const messages: InternalMessage[] = []

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const msg = transcriptToInternal(obj)
      if (msg) messages.push(msg)
    } catch {
      // 跳过无法解析的行
    }
  }

  return messages
}

function simpleToInternal(msg: SimpleMessage, index: number): InternalMessage {
  return {
    uuid: randomUUID(),
    timestamp: new Date(Date.now() + index * 60000).toISOString(),
    type: msg.role === 'system' ? 'system' : msg.role,
    message: {
      id: msg.role === 'assistant' ? `msg_${index}` : undefined,
      role: msg.role,
      content: msg.content,
    },
  }
}

// biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
function transcriptToInternal(obj: any): InternalMessage | null {
  // ZY-Code session transcript 格式
  if (obj.type === 'user' || obj.type === 'assistant') {
    return {
      uuid: obj.uuid ?? randomUUID(),
      timestamp: obj.timestamp ?? new Date().toISOString(),
      type: obj.type,
      message: {
        id: obj.message?.id ?? (obj.type === 'assistant' ? `msg_${obj.uuid}` : undefined),
        role: obj.type === 'assistant' ? 'assistant' : 'user',
        content: obj.message?.content ?? '',
      },
      isMeta: obj.isMeta,
    }
  }

  // 简化格式 {role, message: {content}}
  if (obj.role && obj.message?.content !== undefined) {
    return {
      uuid: obj.uuid ?? randomUUID(),
      timestamp: obj.timestamp ?? new Date().toISOString(),
      type: obj.role === 'assistant' ? 'assistant' : 'user',
      message: {
        id: obj.message?.id,
        role: obj.role,
        content: obj.message.content,
      },
    }
  }

  return null
}

// ════════════════════════════════════════════════════════════════════════════
// 策略 2: Context Collapse — 与 collapseContext + applyCollapsesIfNeeded 一致
// ════════════════════════════════════════════════════════════════════════════

const COLLAPSE_THRESHOLD = 0.85
const MIN_KEPT_ROUNDS = 4

function realContextCollapse(
  messages: InternalMessage[],
  effectiveWindow: number,
  bpt: number,
): {
  result: InternalMessage[]
  tokensFreed: number
  triggered: boolean
  collapsedCount: number
  summary: string
} {
  const tokenCount = totalTokensForMessages(messages, bpt)
  const ratio = tokenCount / effectiveWindow

  if (ratio < COLLAPSE_THRESHOLD) {
    return { result: messages, tokensFreed: 0, triggered: false, collapsedCount: 0, summary: '' }
  }

  // 与 applyCollapsesIfNeeded 完全一致：找 assistant 索引，保留最近 N 个
  const assistantIndices: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type === 'assistant') {
      assistantIndices.push(i)
    }
  }
  assistantIndices.reverse()

  if (assistantIndices.length <= MIN_KEPT_ROUNDS) {
    return { result: messages, tokensFreed: 0, triggered: false, collapsedCount: 0, summary: '' }
  }

  const cutBefore = assistantIndices[assistantIndices.length - MIN_KEPT_ROUNDS]!
  const toArchive = messages.slice(0, cutBefore)
  const keep = messages.slice(cutBefore)

  // 生成轻量摘要 — 与 generateLightSummary 一致
  const userTexts: string[] = []
  for (const m of toArchive) {
    if (m.type === 'user') {
      const content =
        typeof m.message.content === 'string'
          ? m.message.content
          : (m.message.content as ContentBlock[])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('')
      userTexts.push(content.slice(0, 200))
      if (userTexts.length >= 3) break
    }
  }
  const summary = userTexts.join(' | ') || '(empty span)'

  // 插入占位消息 — 与 projectView 逻辑一致
  const placeholder: InternalMessage = {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'user',
    message: {
      role: 'user',
      content: `<collapsed id="0000000000000001">${summary}</collapsed>`,
    },
  }

  const result = [placeholder, ...keep]
  const afterTokens = totalTokensForMessages(result, bpt)
  return {
    result,
    tokensFreed: tokenCount - afterTokens,
    triggered: true,
    collapsedCount: toArchive.length,
    summary,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 策略 3: Reactive Compact（模拟 LLM 摘要 — 用真实分组）
// ════════════════════════════════════════════════════════════════════════════

function realReactiveCompact(
  messages: InternalMessage[],
  effectiveWindow: number,
  bpt: number,
): {
  result: InternalMessage[]
  tokensFreed: number
  triggered: boolean
  summaryTokens: number
  keptGroups: number
  totalGroups: number
} {
  const tokenCount = totalTokensForMessages(messages, bpt)
  const compactThreshold = effectiveWindow - 13_000 // A0_ 函数: effectiveWindow - 13K

  if (tokenCount < compactThreshold) {
    return {
      result: messages,
      tokensFreed: 0,
      triggered: false,
      summaryTokens: 0,
      keptGroups: 0,
      totalGroups: 0,
    }
  }

  // 用真实 groupMessagesByApiRound 分组
  // biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
  const groups = groupMessagesByApiRound(messages as any) as unknown as InternalMessage[][]

  if (groups.length < 2) {
    return {
      result: messages,
      tokensFreed: 0,
      triggered: false,
      summaryTokens: 0,
      keptGroups: groups.length,
      totalGroups: groups.length,
    }
  }

  // 反应式压缩保留最近约 1/3 的 groups（至少 2 个）
  const keepCount = Math.max(2, Math.ceil(groups.length / 3))
  const keptGroups = groups.slice(-keepCount)
  const summarizedGroups = groups.slice(0, -keepCount)
  const summarizedMsgs = summarizedGroups.flat()

  // 模拟 LLM 摘要：生成结构化摘要（实际需要 LLM 调用）
  // 这里用确定性方法模拟摘要结果的大小
  const summarizedTokens = totalTokensForMessages(summarizedMsgs, bpt)
  // 假设 LLM 摘要压缩率为 70%（即摘要约为原文 30%）
  const SUMMARY_COMPRESSION_RATIO = 0.3
  const summaryTokens = Math.floor(summarizedTokens * SUMMARY_COMPRESSION_RATIO)

  const summaryMsg: InternalMessage = {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'user',
    message: {
      role: 'user',
      content: `[LLM Summary of ${summarizedMsgs.length} messages, ~${summaryTokens} tokens]`,
    },
  }

  const result = [summaryMsg, ...keptGroups.flat()]
  const afterTokens = summaryTokens + totalTokensForMessages(keptGroups.flat(), bpt)
  return {
    result,
    tokensFreed: tokenCount - afterTokens,
    triggered: true,
    summaryTokens,
    keptGroups: keepCount,
    totalGroups: groups.length,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Prompt Cache 影响分析（基于真实对话 token 分布）
// ════════════════════════════════════════════════════════════════════════════

function analyzeCacheImpact(messages: InternalMessage[], bpt: number) {
  // biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
  const groups = groupMessagesByApiRound(messages as any) as unknown as InternalMessage[][]

  // 计算每个 group 的 token 增量
  const groupTokens = groups.map((g) => totalTokensForMessages(g, bpt))
  const totalTokens = groupTokens.reduce((a, b) => a + b, 0)

  console.log(`\n  ╭───────────────────────────────────────────────╮`)
  console.log(`  │  Prompt Cache 命中率分析（基于真实对话分布）   │`)
  console.log(`  ╰───────────────────────────────────────────────╯`)
  console.log(`\n  对话 token 总量: ${totalTokens.toLocaleString()}`)
  console.log(`  API round 数: ${groups.length}`)
  console.log(`  每 round 平均 token: ${Math.round(totalTokens / groups.length).toLocaleString()}`)

  // 逐 turn 模拟 cache 命中情况
  const INPUT_PRICE = 3.0
  const CACHE_READ_PRICE = 0.3

  interface Strategy {
    name: string
    totalCost: number
    turns: number
    cacheHits: number
    cacheMisses: number
  }

  function simulateStrategy(
    name: string,
    compactFn: (cumTokens: number, turn: number) => { reset: boolean; newTokens: number } | null,
  ): Strategy {
    let cumTokens = 0
    let cachedPrefix = 0
    let totalCost = 0
    let totalHits = 0
    let totalMisses = 0

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!
      const compact = compactFn(cumTokens, i)

      if (compact) {
        if (compact.reset) {
          // 全量重置（full compact / precomputed swap）
          cumTokens = compact.newTokens
          cachedPrefix = 0
        } else {
          // 折叠（前缀不变）
          cumTokens = compact.newTokens
          cachedPrefix = Math.min(cachedPrefix, cumTokens)
        }
      }

      const hit = Math.min(cachedPrefix, cumTokens)
      const miss = Math.max(0, cumTokens - cachedPrefix)
      totalCost += (hit * CACHE_READ_PRICE + miss * INPUT_PRICE) / 1_000_000
      totalHits += hit
      totalMisses += miss
      cachedPrefix = cumTokens
    }

    return {
      name,
      totalCost,
      turns: groups.length,
      cacheHits: totalHits,
      cacheMisses: totalMisses,
    }
  }

  const EFFECTIVE_WINDOW = 180_000
  const COMPACT_THRESHOLD = EFFECTIVE_WINDOW - 13_000 // 167K
  const COLLAPSE_THRESHOLD_TOKEN = Math.floor(EFFECTIVE_WINDOW * 0.85) // 153K
  const PRECOMPUTE_THRESHOLD = Math.floor(EFFECTIVE_WINDOW * 0.8) // 144K

  const results: Strategy[] = [
    simulateStrategy('无压缩 (baseline)', () => null),
    simulateStrategy('ZY Context Collapse', (cum, _turn) => {
      if (cum >= COLLAPSE_THRESHOLD_TOKEN) {
        return { reset: false, newTokens: Math.floor(cum * 0.6) }
      }
      return null
    }),
    simulateStrategy('ZY Full Compact', (cum, _turn) => {
      if (cum >= COMPACT_THRESHOLD) {
        return { reset: true, newTokens: Math.floor(cum * 0.25) }
      }
      return null
    }),
    simulateStrategy('Claude Precomputed', (cum, _turn) => {
      if (cum >= COMPACT_THRESHOLD) {
        return { reset: true, newTokens: Math.floor(cum * 0.3) }
      }
      return null
    }),
  ]

  console.log(
    `\n  ${'策略'.padEnd(24)} ${'总费用'.padStart(10)} ${'缓存命中率'.padStart(10)} ${'vs baseline'.padStart(12)}`,
  )
  console.log(`  ${'─'.repeat(60)}`)
  const baselineCost = results[0]!.totalCost
  for (const r of results) {
    const hitRate = (r.cacheHits / Math.max(1, r.cacheHits + r.cacheMisses)) * 100
    const saving = (((baselineCost - r.totalCost) / baselineCost) * 100).toFixed(1)
    console.log(
      `  ${r.name.padEnd(24)} $${r.totalCost.toFixed(4).padStart(9)} ${hitRate.toFixed(1).padStart(8)}% ${saving.padStart(10)}%`,
    )
  }

  // 如果真实对话不够长触发压缩，说明
  if (totalTokens < PRECOMPUTE_THRESHOLD) {
    console.log(
      `\n  ⚠️  当前对话 token (${totalTokens.toLocaleString()}) < 压缩阈值 (${PRECOMPUTE_THRESHOLD.toLocaleString()})`,
    )
    console.log(`      上述缓存分析基于假设对话会增长到阈值。`)
    console.log(`      如需看到真实触发效果，请提供更长的对话记录。`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 逐 Turn 渐进模拟 — 还原真实会话中多次触发压缩的过程
// ════════════════════════════════════════════════════════════════════════════

interface CompactionEvent {
  turn: number
  strategy: string
  preTokens: number
  postTokens: number
  freed: number
  freedPct: number
  cumTurns: number
}

function simulateProgressiveCompaction(messages: InternalMessage[], bpt: number) {
  // biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
  const groups = groupMessagesByApiRound(messages as any) as unknown as InternalMessage[][]
  const groupTokens = groups.map((g) => totalTokensForMessages(g, bpt))

  const EFFECTIVE_WINDOW = 180_000
  const COMPACT_THRESHOLD = EFFECTIVE_WINDOW - 13_000 // 167K (Claude A0_)
  const COLLAPSE_THRESHOLD_TOK = Math.floor(EFFECTIVE_WINDOW * 0.85) // 153K
  const PRECOMPUTE_THRESHOLD = Math.floor(EFFECTIVE_WINDOW * 0.8) // 144K
  const SUMMARY_RATIO = 0.3 // LLM 摘要压缩率

  console.log(`\n  ╭───────────────────────────────────────────────────────────────╮`)
  console.log(`  │  逐 Turn 渐进模拟 — 还原真实会话中多次触发压缩的过程       │`)
  console.log(`  ╰───────────────────────────────────────────────────────────────╯`)
  console.log(
    `\n  参数: effectiveWindow=${EFFECTIVE_WINDOW.toLocaleString()}, compact阈值=${COMPACT_THRESHOLD.toLocaleString()}`,
  )
  console.log(
    `        collapse阈值=${COLLAPSE_THRESHOLD_TOK.toLocaleString()}, precompute阈值=${PRECOMPUTE_THRESHOLD.toLocaleString()}`,
  )
  console.log(`        共 ${groups.length} 个 API round\n`)

  // ── 策略 A: ZY-Code Context Collapse (85% 折叠, 保留最近4组原样) ──
  function simZyCollapse() {
    const events: CompactionEvent[] = []
    let cumTokens = 0
    let contextGroups: { tokens: number; index: number }[] = []

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!
      contextGroups.push({ tokens: groupTokens[i]!, index: i })

      if (cumTokens >= COLLAPSE_THRESHOLD_TOK && contextGroups.length > MIN_KEPT_ROUNDS) {
        const preTokens = cumTokens
        // 保留最近 4 个 group，折叠前面的为一行占位
        const keepCount = MIN_KEPT_ROUNDS
        const keptGroups = contextGroups.slice(-keepCount)
        const archivedGroups = contextGroups.slice(0, -keepCount)
        const archivedTokens = archivedGroups.reduce((s, g) => s + g.tokens, 0)
        // 折叠后: 1行摘要(~50 tok) + 保留的 groups
        const summaryTokens = 50
        cumTokens = summaryTokens + keptGroups.reduce((s, g) => s + g.tokens, 0)
        // 重建 contextGroups
        contextGroups = [{ tokens: summaryTokens, index: -1 }, ...keptGroups]

        events.push({
          turn: i + 1,
          strategy: 'Context Collapse',
          preTokens,
          postTokens: cumTokens,
          freed: preTokens - cumTokens,
          freedPct: ((preTokens - cumTokens) / preTokens) * 100,
          cumTurns: i + 1,
        })
      }
    }
    return events
  }

  // ── 策略 B: ZY-Code Reactive Compact (167K 触发, LLM摘要旧组保留近期) ──
  function simZyReactive() {
    const events: CompactionEvent[] = []
    let cumTokens = 0
    let contextGroups: { tokens: number; index: number }[] = []

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!
      contextGroups.push({ tokens: groupTokens[i]!, index: i })

      if (cumTokens >= COMPACT_THRESHOLD && contextGroups.length > 2) {
        const preTokens = cumTokens
        // 保留最近 1/3 group，摘要前面的
        const keepCount = Math.max(2, Math.ceil(contextGroups.length / 3))
        const keptGroups = contextGroups.slice(-keepCount)
        const summarizedGroups = contextGroups.slice(0, -keepCount)
        const summarizedTokens = summarizedGroups.reduce((s, g) => s + g.tokens, 0)
        const summaryTokens = Math.floor(summarizedTokens * SUMMARY_RATIO)
        cumTokens = summaryTokens + keptGroups.reduce((s, g) => s + g.tokens, 0)
        contextGroups = [{ tokens: summaryTokens, index: -1 }, ...keptGroups]

        events.push({
          turn: i + 1,
          strategy: 'Reactive Compact',
          preTokens,
          postTokens: cumTokens,
          freed: preTokens - cumTokens,
          freedPct: ((preTokens - cumTokens) / preTokens) * 100,
          cumTurns: i + 1,
        })
      }
    }
    return events
  }

  // ── 策略 B-v2: ZY V2 Reactive Compact + Rapid Refill Breaker ──
  // 与 simZyReactive 同等触发/释放比例；额外维护 lastCompactTurn / consecutiveRapidRefills。
  // 压缩后 ≤ 3 轮内又达阈值 = rapid；连续 ≥ 3 次 rapid → 熔断（本次跳过 compact，
  // 计数器清零；用户需要 /clear 或拆分大文件）。对齐 CC 二进制 $x8=hD6=3。
  function simZyV2Reactive() {
    const events: CompactionEvent[] = []
    let cumTokens = 0
    let contextGroups: { tokens: number; index: number }[] = []
    let lastCompactTurn = -Infinity
    let consecutiveRapidRefills = 0
    const RAPID_TURNS = 3
    const MAX_RAPID = 3

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!
      contextGroups.push({ tokens: groupTokens[i]!, index: i })

      if (cumTokens >= COMPACT_THRESHOLD && contextGroups.length > 2) {
        const turnsSinceLast = i - lastCompactTurn
        const isRapid = turnsSinceLast <= RAPID_TURNS && Number.isFinite(lastCompactTurn)

        if (isRapid) {
          consecutiveRapidRefills += 1
          if (consecutiveRapidRefills >= MAX_RAPID) {
            // 熔断：跳过本次压缩，记录事件（freed=0）。重置计数器。
            events.push({
              turn: i + 1,
              strategy: 'Rapid Refill Breaker',
              preTokens: cumTokens,
              postTokens: cumTokens,
              freed: 0,
              freedPct: 0,
              cumTurns: i + 1,
            })
            consecutiveRapidRefills = 0
            continue
          }
        } else {
          consecutiveRapidRefills = 0
        }

        // 正常 reactive compact 路径（与 simZyReactive 同）
        const preTokens = cumTokens
        const keepCount = Math.max(2, Math.ceil(contextGroups.length / 3))
        const keptGroups = contextGroups.slice(-keepCount)
        const summarizedGroups = contextGroups.slice(0, -keepCount)
        const summarizedTokens = summarizedGroups.reduce((s, g) => s + g.tokens, 0)
        const summaryTokens = Math.floor(summarizedTokens * SUMMARY_RATIO)
        cumTokens = summaryTokens + keptGroups.reduce((s, g) => s + g.tokens, 0)
        contextGroups = [{ tokens: summaryTokens, index: -1 }, ...keptGroups]
        lastCompactTurn = i

        events.push({
          turn: i + 1,
          strategy: isRapid ? 'V2 Reactive (rapid)' : 'V2 Reactive',
          preTokens,
          postTokens: cumTokens,
          freed: preTokens - cumTokens,
          freedPct: ((preTokens - cumTokens) / preTokens) * 100,
          cumTurns: i + 1,
        })
      }
    }
    return events
  }

  // ── 策略 C: Claude Precomputed (80% arm, 167K swap, 30%保留) ──
  function simClaudePrecomputed() {
    const events: CompactionEvent[] = []
    let cumTokens = 0
    let precomputeArmed = false
    let precomputeArmedAt = -1

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!

      // 80% 时后台 arm
      if (!precomputeArmed && cumTokens >= PRECOMPUTE_THRESHOLD) {
        precomputeArmed = true
        precomputeArmedAt = i
      }

      // 167K 时 swap
      if (cumTokens >= COMPACT_THRESHOLD) {
        const preTokens = cumTokens
        const isPrecomputeReady = precomputeArmed && i - precomputeArmedAt >= 2
        cumTokens = Math.floor(cumTokens * 0.3)
        precomputeArmed = false
        precomputeArmedAt = -1

        events.push({
          turn: i + 1,
          strategy: isPrecomputeReady ? 'Precomputed Swap' : 'Reactive Fallback',
          preTokens,
          postTokens: cumTokens,
          freed: preTokens - cumTokens,
          freedPct: ((preTokens - cumTokens) / preTokens) * 100,
          cumTurns: i + 1,
        })
      }
    }
    return events
  }

  // ── 策略 D: ZY Full Compact (167K 触发, 全量摘要到25%) ──
  function simFullCompact() {
    const events: CompactionEvent[] = []
    let cumTokens = 0

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!

      if (cumTokens >= COMPACT_THRESHOLD) {
        const preTokens = cumTokens
        cumTokens = Math.floor(cumTokens * 0.25)

        events.push({
          turn: i + 1,
          strategy: 'Full Compact',
          preTokens,
          postTokens: cumTokens,
          freed: preTokens - cumTokens,
          freedPct: ((preTokens - cumTokens) / preTokens) * 100,
          cumTurns: i + 1,
        })
      }
    }
    return events
  }

  const strategies = [
    { name: 'ZY Context Collapse', fn: simZyCollapse, emoji: '🟢' },
    { name: 'ZY Reactive Compact (v1)', fn: simZyReactive, emoji: '🟡' },
    { name: 'ZY Reactive Compact (v2)', fn: simZyV2Reactive, emoji: '🟣' },
    { name: 'Claude Precomputed', fn: simClaudePrecomputed, emoji: '🔵' },
    { name: 'ZY Full Compact', fn: simFullCompact, emoji: '🟠' },
  ]

  // ── 打印每种策略的触发时间线 ──
  for (const { name, fn, emoji } of strategies) {
    const events = fn()
    console.log(`  ${emoji} ${name} — 共触发 ${events.length} 次`)
    console.log(`  ${'─'.repeat(72)}`)
    console.log(
      `  ${'#'.padStart(3)} ${'Turn'.padStart(5)} ${'压缩前'.padStart(9)} ${'压缩后'.padStart(9)} ${'释放'.padStart(9)} ${'释放%'.padStart(7)} ${'类型'.padStart(20)}`,
    )

    for (let j = 0; j < events.length; j++) {
      const e = events[j]!
      console.log(
        `  ${String(j + 1).padStart(3)} ${String(e.turn).padStart(5)} ${e.preTokens.toLocaleString().padStart(9)} ${e.postTokens.toLocaleString().padStart(9)} ${e.freed.toLocaleString().padStart(9)} ${e.freedPct.toFixed(0).padStart(5)}% ${e.strategy.padStart(20)}`,
      )
    }

    // 汇总
    const totalFreed = events.reduce((s, e) => s + e.freed, 0)
    const avgInterval =
      events.length > 1
        ? Math.round((events[events.length - 1]!.turn - events[0]!.turn) / (events.length - 1))
        : groups.length
    console.log(`  ${'─'.repeat(72)}`)
    console.log(
      `  总释放: ${totalFreed.toLocaleString()} tok | 平均间隔: 每 ${avgInterval} turn 触发一次\n`,
    )
  }

  // ── Cache 命中对比（含多次压缩） ──
  console.log(`  ╭───────────────────────────────────────────────────────────────╮`)
  console.log(`  │  考虑多次压缩后的 Prompt Cache 成本对比                       │`)
  console.log(`  ╰───────────────────────────────────────────────────────────────╯`)

  const INPUT_PRICE = 3.0
  const CACHE_READ_PRICE = 0.3

  interface CacheResult {
    name: string
    totalCost: number
    totalHit: number
    totalMiss: number
    compactions: number
  }

  function simCacheCost(
    name: string,
    compactFn: (
      cum: number,
      contextLen: number,
      turn: number,
    ) => { reset: boolean; newTokens: number } | null,
  ): CacheResult {
    let cumTokens = 0
    let cachedPrefix = 0
    let totalCost = 0
    let totalHit = 0
    let totalMiss = 0
    let compactions = 0
    let contextLen = 0

    for (let i = 0; i < groups.length; i++) {
      cumTokens += groupTokens[i]!
      contextLen++

      const compact = compactFn(cumTokens, contextLen, i)
      if (compact) {
        compactions++
        if (compact.reset) {
          cumTokens = compact.newTokens
          cachedPrefix = 0
          contextLen = 1 // summary counts as 1
        } else {
          cumTokens = compact.newTokens
          cachedPrefix = Math.min(cachedPrefix, cumTokens)
          contextLen = MIN_KEPT_ROUNDS + 1
        }
      }

      const hit = Math.min(cachedPrefix, cumTokens)
      const miss = Math.max(0, cumTokens - cachedPrefix)
      totalCost += (hit * CACHE_READ_PRICE + miss * INPUT_PRICE) / 1_000_000
      totalHit += hit
      totalMiss += miss
      cachedPrefix = cumTokens
    }

    return { name, totalCost, totalHit, totalMiss, compactions }
  }

  const cacheResults: CacheResult[] = [
    simCacheCost('无压缩 (baseline)', () => null),
    simCacheCost('ZY Context Collapse', (cum, ctxLen) => {
      if (cum >= COLLAPSE_THRESHOLD_TOK && ctxLen > MIN_KEPT_ROUNDS) {
        return { reset: false, newTokens: Math.floor(cum * 0.4) } // 保留前缀, 总量降到40%
      }
      return null
    }),
    simCacheCost('ZY Reactive Compact', (cum, ctxLen) => {
      if (cum >= COMPACT_THRESHOLD && ctxLen > 2) {
        return { reset: true, newTokens: Math.floor(cum * 0.45) } // 摘要+保留近期
      }
      return null
    }),
    simCacheCost('Claude Precomputed', (cum) => {
      if (cum >= COMPACT_THRESHOLD) {
        return { reset: true, newTokens: Math.floor(cum * 0.3) }
      }
      return null
    }),
    simCacheCost('ZY Full Compact', (cum) => {
      if (cum >= COMPACT_THRESHOLD) {
        return { reset: true, newTokens: Math.floor(cum * 0.25) }
      }
      return null
    }),
  ]

  console.log(
    `\n  ${'策略'.padEnd(24)} ${'总费用'.padStart(10)} ${'命中率'.padStart(8)} ${'压缩次数'.padStart(8)} ${'vs base'.padStart(9)}`,
  )
  console.log(`  ${'─'.repeat(65)}`)
  const baseCost = cacheResults[0]!.totalCost
  for (const r of cacheResults) {
    const hitRate = (r.totalHit / Math.max(1, r.totalHit + r.totalMiss)) * 100
    const saving = (((baseCost - r.totalCost) / baseCost) * 100).toFixed(1)
    console.log(
      `  ${r.name.padEnd(24)} $${r.totalCost.toFixed(4).padStart(9)} ${hitRate.toFixed(1).padStart(6)}% ${String(r.compactions).padStart(8)} ${saving.padStart(7)}%`,
    )
  }

  console.log(`\n  💡 结论:`)
  const collapseResult = cacheResults[1]!
  const precomputedResult = cacheResults[3]!
  const collapseHitRate =
    (collapseResult.totalHit / Math.max(1, collapseResult.totalHit + collapseResult.totalMiss)) *
    100
  const precomputedHitRate =
    (precomputedResult.totalHit /
      Math.max(1, precomputedResult.totalHit + precomputedResult.totalMiss)) *
    100
  console.log(
    `     • Context Collapse 缓存命中 ${collapseHitRate.toFixed(1)}% — 因为折叠不破坏前缀`,
  )
  console.log(
    `     • Claude Precomputed 缓存命中 ${precomputedHitRate.toFixed(1)}% — swap 后前缀重建需全价`,
  )
  console.log(`     • 压缩次数越多 → 每次 reset 都有一轮 cache miss → 累积差异显著`)
  console.log(
    `     • 对于你这种 ${groups.length} 轮超长会话，压缩会触发 ${cacheResults[3]!.compactions}+ 次\n`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 输出格式化
// ════════════════════════════════════════════════════════════════════════════

function printSection(title: string) {
  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  ${title}`)
  console.log(`${'━'.repeat(80)}`)
}

// ════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2)

  if (!args[0]) {
    console.log(`用法: bun run scripts/compact-real.ts <conversation.json|conversation.jsonl>`)
    console.log(``)
    console.log(`支持的格式:`)
    console.log(`  1. JSON 数组: [{role: "user"|"assistant", content: "..."}]`)
    console.log(`  2. JSONL (每行一条): {type: "user"|"assistant", message: {content: ...}}`)
    console.log(`  3. ZY-Code session JSONL 完整 transcript`)
    console.log(``)
    console.log(`你可以从 ~/.zy/projects/*/sessions/ 中找到真实 transcript 文件`)
    process.exit(0)
  }

  console.log(`\n  📂 加载对话文件: ${args[0]}`)
  const messages = parseInputFile(args[0])

  if (messages.length === 0) {
    console.error(`  ❌ 未能解析出有效消息`)
    process.exit(1)
  }

  // 检测语言确定 BPT
  const allText = messages
    .map((m) =>
      typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content),
    )
    .join('')
  const bpt = detectBpt(allText)
  const totalToks = totalTokensForMessages(messages, bpt)

  // 用真实 groupMessagesByApiRound 分组
  // biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
  const groups = groupMessagesByApiRound(messages as any) as unknown as InternalMessage[][]

  printSection('📊 对话概览')
  console.log(`  消息总数: ${messages.length}`)
  console.log(`  用户消息: ${messages.filter((m) => m.type === 'user').length}`)
  console.log(`  助手消息: ${messages.filter((m) => m.type === 'assistant').length}`)
  console.log(`  API round 数（真实 groupMessagesByApiRound）: ${groups.length}`)
  console.log(`  检测语言 BPT: ${bpt} (${bpt === 1.5 ? '中文' : bpt === 4 ? '英文' : '混合'})`)
  console.log(`  估算总 token: ${totalToks.toLocaleString()}`)

  // 每个 group 的 token 分布
  const groupToks = groups.map((g) => totalTokensForMessages(g, bpt))
  console.log(`\n  各 round token 分布:`)
  console.log(`    最小: ${Math.min(...groupToks).toLocaleString()}`)
  console.log(`    最大: ${Math.max(...groupToks).toLocaleString()}`)
  console.log(
    `    中位: ${groupToks.sort((a, b) => a - b)[Math.floor(groupToks.length / 2)]!.toLocaleString()}`,
  )
  console.log(`    平均: ${Math.round(totalToks / groups.length).toLocaleString()}`)

  // 模拟使用 200K 模型
  const CONTEXT_WINDOW = 200_000
  const MAX_OUTPUT = 16_000
  const EFFECTIVE_WINDOW = CONTEXT_WINDOW - MAX_OUTPUT // 184K

  printSection('🔬 压缩策略执行结果（使用真实算法）')
  console.log(`  模型: 200K context, effectiveWindow=${EFFECTIVE_WINDOW.toLocaleString()}`)
  console.log(`  当前占用率: ${((totalToks / EFFECTIVE_WINDOW) * 100).toFixed(1)}%`)

  // ─── Context Collapse ───
  console.log(`\n  ┌── Context Collapse ──────────────────────────────────────┐`)
  console.log(
    `  │ 阈值: ${COLLAPSE_THRESHOLD * 100}% (${Math.floor(EFFECTIVE_WINDOW * COLLAPSE_THRESHOLD).toLocaleString()} tok)`,
  )
  const collapseResult = realContextCollapse(messages, EFFECTIVE_WINDOW, bpt)
  if (collapseResult.triggered) {
    const afterToks = totalTokensForMessages(collapseResult.result, bpt)
    console.log(`  │ ✅ 触发! 折叠 ${collapseResult.collapsedCount} 条消息`)
    console.log(
      `  │ 压缩前: ${totalToks.toLocaleString()} tok → 压缩后: ${afterToks.toLocaleString()} tok`,
    )
    console.log(
      `  │ 释放: ${collapseResult.tokensFreed.toLocaleString()} tok (${((collapseResult.tokensFreed / totalToks) * 100).toFixed(1)}%)`,
    )
    console.log(`  │ 摘要: "${collapseResult.summary.slice(0, 80)}..."`)
    console.log(`  │ 保留消息: ${collapseResult.result.length}/${messages.length}`)
  } else {
    console.log(
      `  │ ⏸ 未触发 (当前 ${((totalToks / EFFECTIVE_WINDOW) * 100).toFixed(1)}% < ${COLLAPSE_THRESHOLD * 100}%)`,
    )
    const needed = Math.floor(EFFECTIVE_WINDOW * COLLAPSE_THRESHOLD) - totalToks
    if (needed > 0) {
      console.log(`  │ 还需 ${needed.toLocaleString()} tok 才会触发`)
    } else {
      console.log(`  │ 但 assistant round 不足 ${MIN_KEPT_ROUNDS + 1} 个，无法折叠`)
    }
  }
  console.log(`  └────────────────────────────────────────────────────────────┘`)

  // ─── Reactive Compact ───
  console.log(`\n  ┌── Reactive Compact ─────────────────────────────────────┐`)
  const compactThreshold = EFFECTIVE_WINDOW - 13_000
  console.log(`  │ 阈值: effectiveWindow - 13K = ${compactThreshold.toLocaleString()} tok`)
  const reactiveResult = realReactiveCompact(messages, EFFECTIVE_WINDOW, bpt)
  if (reactiveResult.triggered) {
    console.log(
      `  │ ✅ 触发! groups=${reactiveResult.totalGroups} → 保留 ${reactiveResult.keptGroups}, 摘要 ${reactiveResult.totalGroups - reactiveResult.keptGroups}`,
    )
    console.log(
      `  │ 压缩前: ${totalToks.toLocaleString()} tok → 释放: ${reactiveResult.tokensFreed.toLocaleString()} tok`,
    )
    console.log(
      `  │ 摘要 token (30% 压缩率): ~${reactiveResult.summaryTokens.toLocaleString()} tok`,
    )
    console.log(`  │ ⚠️  实际需要 LLM 调用生成摘要（此处为估算）`)
  } else {
    console.log(
      `  │ ⏸ 未触发 (当前 ${totalToks.toLocaleString()} < ${compactThreshold.toLocaleString()})`,
    )
    console.log(`  │ 还需 ${(compactThreshold - totalToks).toLocaleString()} tok 才会触发`)
  }
  console.log(`  └────────────────────────────────────────────────────────────┘`)

  // ─── 强制执行对比（无论是否触发阈值）───
  printSection('🔧 强制执行对比（忽略阈值，展示算法效果）')

  const forceCollapse = (() => {
    const assistantIndices: number[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.type === 'assistant') assistantIndices.push(i)
    }
    assistantIndices.reverse()
    if (assistantIndices.length <= MIN_KEPT_ROUNDS) return null
    const cutBefore = assistantIndices[assistantIndices.length - MIN_KEPT_ROUNDS]!
    const kept = messages.slice(cutBefore)
    const archived = messages.slice(0, cutBefore)
    return {
      kept,
      archived,
      keptTokens: totalTokensForMessages(kept, bpt),
      archivedTokens: totalTokensForMessages(archived, bpt),
    }
  })()

  console.log(
    `\n  ${'策略'.padEnd(22)} ${'保留消息'.padStart(10)} ${'保留 token'.padStart(12)} ${'释放 token'.padStart(12)} ${'释放%'.padStart(8)}`,
  )
  console.log(`  ${'─'.repeat(68)}`)

  if (forceCollapse) {
    console.log(
      `  ${'Collapse (保留最近4轮)'.padEnd(22)} ${String(forceCollapse.kept.length).padStart(10)} ${forceCollapse.keptTokens.toLocaleString().padStart(12)} ${forceCollapse.archivedTokens.toLocaleString().padStart(12)} ${((forceCollapse.archivedTokens / totalToks) * 100).toFixed(1).padStart(7)}%`,
    )
  } else {
    console.log(`  ${'Collapse'.padEnd(22)} assistant 轮次 ≤ ${MIN_KEPT_ROUNDS}，无法执行`)
  }

  // Reactive 强制执行
  const forceReactive = (() => {
    // biome-ignore lint/suspicious/noExplicitAny: 脚本工具类型处理
    const g = groupMessagesByApiRound(messages as any) as unknown as InternalMessage[][]
    if (g.length < 2) return null
    const keepCount = Math.max(2, Math.ceil(g.length / 3))
    const keptGroups = g.slice(-keepCount)
    const summarizedGroups = g.slice(0, -keepCount)
    const keptMsgs = keptGroups.flat()
    const summarizedMsgs = summarizedGroups.flat()
    const keptToks = totalTokensForMessages(keptMsgs, bpt)
    const summarizedToks = totalTokensForMessages(summarizedMsgs, bpt)
    const summaryToks = Math.floor(summarizedToks * 0.3)
    return { keptMsgs, keptToks, summarizedToks, summaryToks, keepCount, totalGroups: g.length }
  })()

  if (forceReactive) {
    const afterToks = forceReactive.keptToks + forceReactive.summaryToks
    const freed = totalToks - afterToks
    console.log(
      `  ${'Reactive (LLM 摘要旧组)'.padEnd(22)} ${String(forceReactive.keptMsgs.length).padStart(10)} ${afterToks.toLocaleString().padStart(12)} ${freed.toLocaleString().padStart(12)} ${((freed / totalToks) * 100).toFixed(1).padStart(7)}%`,
    )
    console.log(
      `  ${'  └ 摘要估算'.padEnd(22)} ${forceReactive.totalGroups - forceReactive.keepCount} groups → ~${forceReactive.summaryToks.toLocaleString()} tok (30% 压缩率)`,
    )
  }

  // ─── 渐进模拟（核心新增） ───
  printSection('⏱️  逐 Turn 渐进模拟 — 多次压缩触发时间线')
  simulateProgressiveCompaction(messages, bpt)

  // ─── 分组详情 ───
  printSection('📋 API Round 分组详情（groupMessagesByApiRound 输出）')
  const maxShow = Math.min(groups.length, 20)
  for (let i = 0; i < maxShow; i++) {
    const g = groups[i]!
    const toks = totalTokensForMessages(g, bpt)
    const firstMsg = g[0]!
    const preview =
      typeof firstMsg.message.content === 'string'
        ? firstMsg.message.content.slice(0, 60)
        : '[content blocks]'
    console.log(
      `  Round ${String(i + 1).padStart(2)}: ${String(g.length).padStart(2)} msgs, ${toks.toLocaleString().padStart(7)} tok | ${firstMsg.type}:${preview.replace(/\n/g, ' ')}...`,
    )
  }
  if (groups.length > maxShow) {
    console.log(`  ... 还有 ${groups.length - maxShow} 个 round 未显示`)
  }

  console.log(`\n${'━'.repeat(80)}`)
  console.log(`  ✅ 完成。所有分组使用项目真实 groupMessagesByApiRound 算法。`)
  console.log(`${'━'.repeat(80)}\n`)
}

main()
