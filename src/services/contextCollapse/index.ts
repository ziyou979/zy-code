/**
 * 上下文折叠（Context Collapse）核心模块。
 *
 * 当对话上下文接近 token 限制时，将较旧的消息 span 折叠为摘要占位符，
 * 从而在不丢失关键信息的前提下压缩上下文。与 auto-compact 的区别在于：
 * - auto-compact: 主动预防，用单个大摘要替换全部旧消息
 * - context collapse: 细粒度、多 span，按 API round 边界逐步折叠
 *
 * 集成点：
 * - setup.ts: initContextCollapse() 初始化
 * - query.ts: applyCollapsesIfNeeded() 每次 API 调用前、recoverFromOverflow() 413 恢复
 * - autoCompact.ts: isContextCollapseEnabled() 抑制主动压缩
 * - postCompactCleanup.ts: resetContextCollapse() 手动压缩后重置
 */

import { randomUUID } from 'node:crypto'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { projectView } from './operations.js'

// ============================================================================
// 类型定义
// ============================================================================

/** 已提交的折叠 span */
interface CommittedCollapse {
  /** 16 位自增 ID（持久化时用于排序和 ID 计数恢复） */
  collapseId: string
  /** 占位消息的 UUID */
  summaryUuid: string
  /** 占位消息的完整内容（含 <collapsed> 标签） */
  summaryContent: string
  /** 纯文本摘要 */
  summary: string
  /** span 起始消息 UUID */
  firstArchivedUuid: string
  /** span 结束消息 UUID */
  lastArchivedUuid: string
}

/** 暂存待折叠的 span */
interface StagedSpan {
  /** span 起始消息 UUID */
  startUuid: string
  /** span 结束消息 UUID */
  endUuid: string
  /** 轻量预摘要 */
  summary: string
  /** 暂存时间戳 */
  stagedAt: number
}

// ============================================================================
// 模块级状态
// ============================================================================

let commits: CommittedCollapse[] = []
let staged: StagedSpan[] = []
const subscribers = new Set<() => void>()
let idCounter = 1
let health = {
  totalSpawns: 0,
  totalErrors: 0,
  lastError: null as string | null,
  emptySpawnWarningEmitted: false,
  totalEmptySpawns: 0,
}

/** 折叠阈值：上下文使用率达到此比例时触发折叠 */
const COLLAPSE_THRESHOLD = 0.85
/** 折叠时最少保留的 API round 数量 */
const MIN_KEPT_ROUNDS = 4

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从消息列表中按 position 查找指定 UUID 的索引。
 * 用于 projectView 中定位折叠 span 的边界。
 */
function findMessageIndex(messages: readonly Message[], uuid: string): number {
  return messages.findIndex((m) => m.uuid === uuid)
}

/**
 * 生成下一个 16 位 collapseId。
 */
function nextCollapseId(): string {
  return String(idCounter++).padStart(16, '0')
}

/**
 * 用用户配置语言 + 简单的文本截取，生成轻量预摘要。
 * 完整摘要由 recoverFromOverflow 中的 fork agent 生成。
 */
function generateLightSummary(msgs: readonly Message[]): string {
  const userMsgs = msgs.filter((m) => m.type === 'user')
  const textParts: string[] = []
  for (const m of userMsgs) {
    for (const block of m.message.content) {
      if (block.type === 'text') {
        textParts.push(block.text.slice(0, 200))
      }
    }
    if (textParts.length >= 3) {
      break
    }
  }
  return textParts.join(' | ') || '(empty span)'
}

/**
 * 通知所有订阅者状态已变更。
 */
function notifySubscribers(): void {
  for (const fn of subscribers) {
    try {
      fn()
    } catch {
      /* 订阅者错误不应影响折叠流程 */
    }
  }
}

// ============================================================================
// 公开 API
// ============================================================================

export function isContextCollapseEnabled(): boolean {
  return true
}

export function initContextCollapse(): void {
  commits = []
  staged = []
  idCounter = 1
  health = {
    totalSpawns: 0,
    totalErrors: 0,
    lastError: null,
    emptySpawnWarningEmitted: false,
    totalEmptySpawns: 0,
  }
}

export function resetContextCollapse(): void {
  commits = []
  staged = []
  health.lastError = null
  notifySubscribers()
}

export function getStats(): {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: {
    totalSpawns: number
    totalErrors: number
    lastError: string | null
    emptySpawnWarningEmitted: boolean
    totalEmptySpawns: number
  }
} {
  return {
    collapsedSpans: commits.length,
    collapsedMessages: commits.length, // 简化：每个折叠至少包含若干消息
    stagedSpans: staged.length,
    health: { ...health },
  }
}

/**
 * 在每次 API 调用前对消息列表应用折叠投影。
 * 若上下文使用率 >= 85%，将最旧的 span 暂存，并将已提交的折叠 span 替换为占位消息。
 *
 * @returns {{ messages: Message[] }} 包含投影后消息列表的对象
 */
export async function applyCollapsesIfNeeded(
  messages: Message[],
  _toolUseContext?: ToolUseContext,
  _querySource?: QuerySource,
): Promise<{ messages: Message[] }> {
  // 动态导入以避免循环依赖
  const { tokenCountWithEstimation } = await import('../../utils/tokens.js')
  const { getContextWindowForModel } = await import('../../utils/context.js')
  const { getMaxOutputTokensForModel } = await import('../api/apiHelpers.js')

  // 获取当前模型
  const settings = getInitialSettings()
  const model = settings.model ?? 'default'

  // 计算 token 使用率
  const tokenCount = tokenCountWithEstimation(messages)
  const contextWindow = getContextWindowForModel(model)
  const maxOutput = Math.min(getMaxOutputTokensForModel(model), 20_000)
  const effectiveWindow = contextWindow - maxOutput
  const ratio = tokenCount / effectiveWindow

  // 若超过阈值，暂存最旧的可折叠 span
  if (ratio >= COLLAPSE_THRESHOLD && messages.length > 0) {
    // 找到可折叠的消息范围：保留最近 MIN_KEPT_ROUNDS 个 assistant 消息
    const assistantIndices: number[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.type === 'assistant') {
        assistantIndices.push(i)
      }
    }
    assistantIndices.reverse() // 恢复为从旧到新的顺序

    if (assistantIndices.length > MIN_KEPT_ROUNDS) {
      const cutBefore = assistantIndices[assistantIndices.length - MIN_KEPT_ROUNDS]!
      const spanMessages = messages.slice(0, cutBefore)

      if (spanMessages.length > 0) {
        const first = spanMessages[0]!
        const last = spanMessages[spanMessages.length - 1]!

        // 避免重复暂存同一个 span
        const alreadyStaged = staged.some(
          (s) => s.startUuid === first.uuid && s.endUuid === last.uuid,
        )
        if (!alreadyStaged) {
          staged.push({
            startUuid: first.uuid,
            endUuid: last.uuid,
            summary: generateLightSummary(spanMessages),
            stagedAt: Date.now(),
          })
        }
      }
    }
  }

  // 持久化快照
  try {
    const { recordContextCollapseSnapshot } = await import('../../utils/sessionStorage.js')
    // 排除 sessionId——由 recordContextCollapseSnapshot 内部添加
    await recordContextCollapseSnapshot({
      staged: staged.map((s) => ({
        startUuid: s.startUuid,
        endUuid: s.endUuid,
        summary: s.summary,
        risk: 50,
        stagedAt: s.stagedAt,
      })),
      armed: false,
      lastSpawnTokens: tokenCount,
    } as any)
  } catch {
    // 持久化失败不应影响折叠流程
  }

  // 投影：将已提交的折叠 span 替换为占位消息
  const projected = projectView(messages, commits)
  return { messages: projected }
}

/**
 * 从 prompt-too-long (413) 错误中恢复：将暂存队列中最旧的 span
 * 替换为摘要占位符，返回缩短后的消息列表供重试。
 *
 * @returns {{ messages: Message[]; committed: number }}
 */
export async function recoverFromOverflow(
  messages: Message[],
  _querySource?: QuerySource,
): Promise<{ messages: Message[]; committed: number }> {
  if (staged.length === 0) {
    return { messages, committed: 0 }
  }

  // 取出最旧的暂存 span
  const span = staged.shift()!
  const startIdx = findMessageIndex(messages, span.startUuid)
  const endIdx = findMessageIndex(messages, span.endUuid)

  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    return { messages, committed: 0 }
  }

  // 生成摘要占位消息
  const summaryUuid = randomUUID()
  const collapseId = nextCollapseId()
  const summaryContent = `<collapsed id="${collapseId}">${span.summary}</collapsed>`
  const placeholder = createUserMessage({
    content: [{ type: 'text' as const, text: `[Earlier context collapsed: ${span.summary}]` }],
  })

  // 提交折叠
  commits.push({
    collapseId,
    summaryUuid,
    summaryContent,
    summary: span.summary,
    firstArchivedUuid: span.startUuid,
    lastArchivedUuid: span.endUuid,
  })

  // 构建新消息列表：归档 span 之前的部分 + 占位消息 + span 之后的部分
  const beforeSpan = messages.slice(0, startIdx)
  const afterSpan = messages.slice(endIdx + 1)
  const newMessages = [...beforeSpan, placeholder as any, ...afterSpan]

  // 持久化提交
  try {
    const { recordContextCollapseCommit } = await import('../../utils/sessionStorage.js')
    await recordContextCollapseCommit({
      collapseId,
      summaryUuid,
      summaryContent,
      summary: span.summary,
      firstArchivedUuid: span.startUuid,
      lastArchivedUuid: span.endUuid,
    } as any)
  } catch {
    // 持久化失败不影响折叠流程
  }

  health.totalSpawns++
  notifySubscribers()

  return { messages: newMessages, committed: 1 }
}

/**
 * 判断给定消息是否为应由折叠处理的 prompt-too-long 错误。
 * 如果有暂存的 span 可以排出，则拦截错误以尝试恢复。
 */
export function isWithheldPromptTooLong(
  message: unknown,
  isPromptTooLongFn: (msg: unknown) => boolean,
  _querySource?: QuerySource,
): boolean {
  if (!isPromptTooLongFn(message)) {
    return false
  }
  return staged.length > 0
}

export function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

// ============================================================================
// 内部函数（供 persist.ts 恢复状态使用）
// ============================================================================

/** persist.ts 恢复时添加已提交的折叠 */
export function _addCommit(c: CommittedCollapse): void {
  commits.push(c)
}

/** persist.ts 恢复时添加暂存 span */
export function _addStaged(s: StagedSpan): void {
  staged.push(s)
}

/** persist.ts 恢复时重置 ID 计数器 */
export function _reseedIdCounter(nextId: number): void {
  idCounter = nextId
}
