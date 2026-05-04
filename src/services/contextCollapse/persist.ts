/**
 * 上下文折叠的持久化与恢复逻辑。
 *
 * - restoreFromEntries: 从 session transcript 恢复折叠状态（session 恢复时调用）
 * - persistContextCollapse: 批量持久化入口（预留，实际持久化在 index.ts 中通过
 *   recordContextCollapseCommit / recordContextCollapseSnapshot 完成）
 */

import type { ContextCollapseCommitEntry, ContextCollapseSnapshotEntry } from '../../types/logs.js'

/** 与 index.ts 共享的类型定义（持久化层的最小版本） */
export type ContextCollapseEntry = {
  id: string
  content: string
}

export type ContextCollapseSnapshot = {
  entries: ContextCollapseEntry[]
}

/**
 * 从 session transcript entries 恢复折叠状态。
 * 在 session 加载时由 sessionRestore.ts 调用。
 *
 * @param entries - commit entries，按时间顺序排列
 * @param snapshot - 最新快照（staged + spawn state）
 */
export async function restoreFromEntries(
  entries: ContextCollapseCommitEntry[],
  snapshot: ContextCollapseSnapshotEntry | undefined,
): Promise<void> {
  // 动态导入 index.ts 以访问模块级状态（避免循环依赖）
  const indexModule = await import('./index.js')

  // 重置状态
  ;indexModule.initContextCollapse()

  if (entries.length > 0) {
    // 回放 commits：entry 的字段与 index.ts 的 CommittedCollapse 一致
    for (const entry of entries) {
      ;indexModule._addCommit({
        collapseId: entry.collapseId,
        summaryUuid: entry.summaryUuid,
        summaryContent: entry.summaryContent,
        summary: entry.summary,
        firstArchivedUuid: entry.firstArchivedUuid,
        lastArchivedUuid: entry.lastArchivedUuid,
      })
    }

    // 从最大 collapseId 恢复计数器
    const maxId = entries.reduce((max, e) => Math.max(max, parseInt(e.collapseId, 10) || 0), 0)
    ;indexModule._reseedIdCounter(maxId + 1)
  }

  // 恢复 staged 队列和 spawn 状态
  if (snapshot?.staged && snapshot.staged.length > 0) {
    for (const s of snapshot.staged) {
      ;indexModule._addStaged({
        startUuid: s.startUuid,
        endUuid: s.endUuid,
        summary: s.summary,
        stagedAt: s.stagedAt,
      })
    }
  }
}

/**
 * 预留的批量持久化入口。
 * 当前持久化已在 index.ts 中各操作点直接调用 sessionStorage API。
 */
export function persistContextCollapse(_data: unknown): void {
  // 预留接口，后续可在此集中管理持久化逻辑
}
