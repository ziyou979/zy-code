/**
 * 会话转录持久化模块
 *
 * 提供会话转录的持久化存储，支持：
 * - 按条目写入转录（JSONL 格式）
 * - 加载完整转录
 * - 日期变更时刷新转录
 * - 写入转录片段（供压缩流程使用）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { getSessionId } from '../../bootstrap/state.js'

function getTranscriptDir(): string {
  const dir = join(getZyConfigHomeDir(), 'transcripts')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getTranscriptPath(): string {
  return join(getTranscriptDir(), `${getSessionId()}.jsonl`)
}

export function getSessionTranscriptPath(): string | null {
  try {
    return getTranscriptPath()
  } catch {
    return null
  }
}

export function saveTranscriptEntry(entry: unknown): void {
  try {
    const line = JSON.stringify(entry) + '\n'
    appendFileSync(getTranscriptPath(), line, 'utf-8')
  } catch {
    // 持久化失败不阻塞主流程
  }
}

export function loadTranscriptEntries(): unknown[] {
  try {
    const path = getTranscriptPath()
    if (!existsSync(path)) return []
    const content = readFileSync(path, 'utf-8')
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function clearTranscript(): void {
  try {
    const path = getTranscriptPath()
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // 清除失败不阻塞
  }
}

/**
 * 日期变更时刷新转录：清空旧转录，写入新日期标记。
 * 由 attachments.ts 在检测到日期变更时调用。
 */
export function flushOnDateChange(_messages: unknown[], currentDate: string): void {
  try {
    clearTranscript()
    saveTranscriptEntry({
      type: 'date_change',
      date: currentDate,
      timestamp: new Date().toISOString(),
    })
  } catch {
    // 非关键操作
  }
}

/**
 * 写入转录片段供压缩流程使用。
 * 由 compact.ts 在压缩完成后调用，持久化压缩结果。
 */
export function writeSessionTranscriptSegment(messages: unknown[]): void {
  try {
    const segment = {
      type: 'segment',
      timestamp: new Date().toISOString(),
      messageCount: messages.length,
      messages: messages.map((m) => {
        const msg = m as Record<string, unknown>
        return {
          type: msg.type,
          role: (msg as { message?: { role?: string } }).message?.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }
      }),
    }
    saveTranscriptEntry(segment)
  } catch {
    // 非关键操作
  }
}
