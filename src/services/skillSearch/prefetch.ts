/**
 * 技能预取 — 在对话上下文初始化时预加载相关技能
 *
 * 启动时触发技能发现，将匹配的技能附加到会话上下文。
 * 远程市场暂未搭建，仅限本地技能。
 */

import type { Message } from '../../types/message.js'
import { searchLocalSkills } from './localSearch.js'

export function startSkillDiscoveryPrefetch(
  _messages: readonly Message[],
  _isInitial: boolean,
): void {
  // 预热技能索引（首次调用 searchLocalSkills 会触发 buildIndex）
  // 在后台执行，不阻塞主流程
  setImmediate(() => {
    try {
      searchLocalSkills('', 0) // 触发索引构建
    } catch {
      // 静默失败
    }
  })
}

export async function getTurnZeroSkillDiscovery(
  input: string | undefined,
  _context: unknown,
): Promise<unknown[]> {
  if (!input || input.trim().length === 0) return []
  try {
    const results = searchLocalSkills(input, 5)
    return results.map((r) => ({
      type: 'skill',
      name: r.name,
      description: r.description,
      path: r.path,
    }))
  } catch {
    return []
  }
}
