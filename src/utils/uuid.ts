import { randomBytes, type UUID } from 'node:crypto'
import type { AgentId, SessionId } from 'src/types/ids.js'

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate uuid
 * @param maybeUUID The value to be checked if it is a uuid
 * @returns string as UUID or null if it is not valid
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  // UUID format: 8-4-4-4-12 hex digits
  if (typeof maybeUuid !== 'string') {
    return null
  }

  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * Generate a new agent ID with prefix for consistency with task IDs.
 * Format: a{label-}{16 hex chars}
 * Example: aa3f2c1b4d5e6f7a8, acompact-a3f2c1b4d5e6f7a8
 */
export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  return (label ? `a${label}-${suffix}` : `a${suffix}`) as AgentId
}

// ---------------------------------------------------------------------------
// 时间可排序的 Session ID
//
// 格式: YYYYMMDD-HHmm-cccc-rrrr-rrrrrrrrrrrr  (8-4-4-4-12，段结构与 UUID v4 一致)
//   - YYYYMMDD: 日期（人类可读）
//   - HHmm:     小时+分钟（人类可读）
//   - cccc:     同一分钟内单调递增的十六进制计数器（每分钟从随机值开始）
//   - rrrr / rrrrrrrrrrrr: 随机十六进制（共64位随机）
//
// 字典序排序 = 时间顺序。同时兼容旧的纯 UUID 格式。
// ---------------------------------------------------------------------------

let lastMinuteKey = ''
let sequence = 0

/**
 * 生成时间可排序的会话 ID。
 *
 * 同一分钟内通过单调计数器保证严格递增，防止在高速创建时出现反序。
 * 计数器每分钟从随机值开始，避免泄露会话创建密度。
 */
export function createSessionId(): SessionId {
  const now = new Date()
  const y = now.getFullYear().toString()
  const mo = (now.getMonth() + 1).toString().padStart(2, '0')
  const d = now.getDate().toString().padStart(2, '0')
  const h = now.getHours().toString().padStart(2, '0')
  const mi = now.getMinutes().toString().padStart(2, '0')
  const minuteKey = `${y}${mo}${d}${h}${mi}`

  // 新分钟：计数器从随机值开始
  if (minuteKey !== lastMinuteKey) {
    const seed = randomBytes(2)
    sequence = seed.readUInt16BE(0)
    lastMinuteKey = minuteKey
  } else {
    sequence = (sequence + 1) & 0xffff
  }

  const dateStr = `${y}${mo}${d}`
  const timeStr = `${h}${mi}`
  const seqStr = sequence.toString(16).padStart(4, '0')
  const rand = randomBytes(8).toString('hex')

  return `${dateStr}-${timeStr}-${seqStr}-${rand.slice(0, 4)}-${rand.slice(4)}` as SessionId
}

/**
 * 验证会话 ID。同时接受：
 * - 新格式: YYYYMMDD-HHmm-cccc-rrrr-rrrrrrrrrrrr（8-4-4-4-12）
 * - 旧格式: UUID v4（8-4-4-4-12）
 *
 * 两种格式的段结构相同，统一用同一正则匹配。
 */
export function validateSessionId(maybeId: unknown): SessionId | null {
  if (typeof maybeId !== 'string') return null
  return uuidRegex.test(maybeId) ? (maybeId as SessionId) : null
}
