import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getUserContext } from '../../context.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage.js'
import { clearBetaTracingState } from '../../utils/telemetry/betaSessionTracing.js'
import { resetGetMemoryFilesCache } from '../../utils/zymd.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * 在压缩后运行缓存和跟踪状态的清理。
 * 在自动压缩和手动 /compact 后调用此函数，以释放
 * 被压缩无效化的跟踪结构所持有的内存。
 *
 * 注意：我们有意不在此处清除已调用技能的内容。
 * 技能内容必须在多次压缩之间保持存活，以便
 * createSkillAttachmentIfNeeded() 可以在后续压缩附件中包含完整技能文本。
 *
 * querySource：传递压缩查询的源，以便我们可以跳过
 * 会破坏主线程模块级状态的重置。子代理（agent:*）
 * 在同一进程中运行并共享模块级状态
 * （context-collapse 存储、getMemoryFiles 一次性钩子标志、
 * getUserContext 缓存）；当子代理压缩时重置这些会
 * 损坏主线程的状态。所有压缩调用者都应传递 querySource —
 * undefined 仅对真正的主线程专用调用者安全（/compact、/clear）。
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // 子代理（agent:*）在同一进程中运行并与主线程共享模块级
  // 状态。仅为主线程压缩重置主线程模块级状态
  // （context-collapse、memory 文件缓存）。
  // 使用与 isMainThread 相同的 startsWith 模式（index.ts:188）。
  const isMainThreadCompact =
    querySource === undefined || querySource.startsWith('repl_main_thread') || querySource === 'sdk'

  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext 是包装 getzyMds() → getMemoryFiles() 的 memoized 外层。
    // 如果只清除内层的 getMemoryFiles 缓存，下次点击会命中
    // getUserContext 缓存而永远不会到达 getMemoryFiles()，因此已武装的
    // InstructionsLoaded 钩子永远不会触发。
    // 手动 /compact 已在其调用站点显式清除此项；
    // 自动压缩和响应式压缩没有 — 这集中了清除，使所有压缩路径行为一致。
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then((m) => (m as any).sweepFileContentCache())
  }
  clearSessionMessagesCache()
}
