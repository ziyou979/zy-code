import { feature } from 'bun:bundle'
import type { UUID } from 'node:crypto'
import { join } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/runtime/runtimeContext.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { getProjectDir } from './paths.js'

/**
 * 类型守卫：检查 entry 是否为 transcript 消息。
 * transcript 消息包括 user / assistant / attachment / system。
 *
 * 重要：这是判定什么构成 transcript 消息的唯一权威来源。
 * loadTranscriptFile() 用它决定哪些消息加载到对话链。
 *
 * progress 消息不是 transcript 消息 — 它们是临时 UI 状态，
 * 不应持久化到 JSONL 或参与 parentUuid 链。包含它们会导致链分叉，
 * 真实对话消息在恢复时成为孤儿（参见 #14373, #23537）。
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

/**
 * 参与 parentUuid 链的 entry。在写入路径（insertMessageChain、useLogMessages）中
 * 用于分配 parentUuid 时跳过 progress。旧 transcript 中已在链里的 progress
 * 由 loadTranscriptFile 中的 progressBridge 重写处理。
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

export type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * PR #24099 之前写入的 transcript 中的 progress entry。它们不再属于
 * Entry 类型联合，但仍以含 uuid 和 parentUuid 字段的形式存在于磁盘上。
 * loadTranscriptFile 会在它们之间桥接链。
 */
export function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * 高频工具进度 tick（Sleep 为 1次/秒，Bash 为每 chunk 一次）。
 * 仅用于 UI：不发送到 API，工具完成后不渲染。REPL.tsx 用它来
 * 原地替换而非追加，loadTranscriptFile 用它来跳过旧 transcript 中的遗留 entry。
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  ...(feature('PROACTIVE') || feature('KAIROS') ? (['sleep_progress'] as const) : []),
])

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}
