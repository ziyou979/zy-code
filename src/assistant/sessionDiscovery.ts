/**
 * 会话发现 — 枚举可恢复的 assistant mode 会话。
 *
 * 从 ~/.zy/sessions/ 目录和 sessionHistory API 获取
 * 可恢复的会话列表。
 */

import { mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { getZyConfigHomeDir } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'

export type AssistantSession = { id: string; name: string; timestamp?: string }

/**
 * 发现所有可恢复的 assistant 会话。
 * 当前从本地 sessions 目录读取；后续可扩展为远程 API 查询。
 */
export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  const sessions: AssistantSession[] = []
  const sessionsDir = join(getZyConfigHomeDir(), 'sessions')

  try {
    mkdirSync(sessionsDir, { recursive: true })
    const entries = readdirSync(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        sessions.push({
          id: entry.name,
          name: entry.name,
        })
      }
    }
  } catch (err) {
    logForDebugging(`discoverAssistantSessions error: ${err}`)
  }

  // 按名称倒序（最新的在前）
  sessions.sort((a, b) => b.name.localeCompare(a.name))
  return sessions.slice(0, 20) // 最多返回 20 个
}
