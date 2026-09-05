// resume 会话分派。
// 处理 --from-pr PR 过滤、按自定义标题搜索会话、普通 resume 会话恢复和交互式选择器。

import { resolve } from 'node:path'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getOriginalCwd } from 'src/bootstrap/runtime/runtimeContext.js'
import type { StatsStore } from '../../context/stats.js'
import { launchResumeChooser } from '../../cli/DialogLaunchers.js'
import type { Root } from '../../ink/index.js'
import { exitWithError } from '../../cli/InteractiveHelpers.js'
import type { AppState } from '../../state/AppStateStore.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../../tools/AgentTool/loadAgentsDir.js'
import type { LogOption } from '../../types/logs.js'
import { count } from '../../utils/array.js'
import { loadConversationForResume } from '../../services/session-storage/conversationRecovery.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { getWorktreePaths } from '../../services/worktree/getWorktreePaths.js'
import { gracefulShutdown } from '../../bootstrap/lifecycle/gracefulShutdown.js'
import { logError } from '../../services/infra/log.js'
import {
  type ProcessedResume,
  processResumedConversation,
} from '../../services/session-storage/sessionRestore.js'
import {
  getSessionIdFromLog,
  loadTranscriptFromFile,
  searchSessionsByCustomTitle,
} from '../../services/sessionStorage.js'
import type { ThinkingConfig } from '../../services/messages/thinking.js'
import { validateUuid } from '../../utils/uuid.js'
import { maybeActivateBrief } from '../activate/brief.js'
import { maybeActivateProactive } from '../activate/proactive.js'
import { launchResumedSessionRepl } from './resumedSession.js'
import type { RenderAndRun, RootActionOptions, SessionConfig } from './types.js'
// processResumedConversation 第三参数的上下文类型。
// CoordinatorModeApi 在 sessionRestore.ts 中是私有类型，这里用结构兼容。
type CoordinatorModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

/** resume / teleport / remote 分派所需的全部参数。 */
export interface ResumeDispatchParams {
  root: Root
  renderAndRun: RenderAndRun
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
  initialState: AppState
  options: RootActionOptions
  sessionConfig: SessionConfig
  /** processResumedConversation 需要的共享上下文 */
  resumeContext: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  }
  mainThreadAgentDefinition: AgentDefinition | undefined
  thinkingConfig: ThinkingConfig
}

/**
 * 分派本地 resume 会话恢复流程。
 */
export async function dispatchResumeMode(params: ResumeDispatchParams): Promise<void> {
  const {
    root,
    renderAndRun,
    getFpsMetrics,
    stats,
    initialState,
    options,
    sessionConfig,
    resumeContext,
    thinkingConfig,
  } = params

  // mainThreadAgentDefinition 在分支内部可能被 restoredAgentDef 覆盖
  let mainThreadAgentDefinition = params.mainThreadAgentDefinition

  // 处理恢复流程 —— 从文件（仅限 ant）、会话 ID 或交互式选择器恢复

  // 恢复前清除过时缓存，确保文件/技能发现为最新
  const { clearSessionCaches } = await import('../../commands/clear/caches.js')
  clearSessionCaches()
  let processedResume: ProcessedResume | undefined
  let maybeSessionId = validateUuid(options.resume)
  let searchTerm: string | undefined
  // 按自定义标题找到时存储完整的 LogOption（用于跨 worktree 恢复）
  let matchedLog: LogOption | null = null
  // --from-pr 标志的 PR 过滤
  let filterByPr: boolean | number | string | undefined

  // 处理 --from-pr 标志
  if (options.fromPr) {
    if (options.fromPr === true) {
      // 显示所有关联 PR 的会话
      filterByPr = true
    } else if (typeof options.fromPr === 'string') {
      // 可能是 PR 编号或 URL
      filterByPr = options.fromPr
    }
  }

  // 如果恢复值不是 UUID，首先尝试按自定义标题精确匹配
  if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
    const trimmedValue = options.resume.trim()
    if (trimmedValue) {
      const matches = await searchSessionsByCustomTitle(trimmedValue, {
        exact: true,
      })
      if (matches.length === 1) {
        // 精确匹配找到 —— 存储完整的 LogOption 用于跨 worktree 恢复
        matchedLog = matches[0]!
        maybeSessionId = getSessionIdFromLog(matchedLog) ?? null
      } else {
        // 无匹配或多个匹配 —— 用作选择器的搜索词
        searchTerm = trimmedValue
      }
    }
  }

  if (isInternalBuild()) {
    if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
      // 检查 ccshare URL（如 https://go/ccshare/boris-20260311-211036）
      // ccshareResume 已移除（导出从未实际定义）
      {
        const resolvedPath = resolve(options.resume)
        try {
          const resumeStart = performance.now()
          let logOption
          try {
            // 尝试作为转录文件加载；ENOENT 回退到会话 ID 处理
            logOption = await loadTranscriptFromFile(resolvedPath)
          } catch (error) {
            if (!isENOENT(error)) {
              throw error
            }
            // ENOENT：不是文件路径 — 回退到会话 ID 处理
          }
          if (logOption) {
            const result = await loadConversationForResume(logOption, undefined /* sourceFile */)
            if (result) {
              processedResume = await processResumedConversation(
                result,
                {
                  forkSession: !!options.forkSession,
                  transcriptPath: result.fullPath,
                },
                resumeContext,
              )
              if (processedResume.restoredAgentDef) {
                mainThreadAgentDefinition = processedResume.restoredAgentDef
              }
              logEvent('zy_session_resumed', {
                entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: true,
                resume_duration_ms: Math.round(performance.now() - resumeStart),
              })
            } else {
              logEvent('zy_session_resumed', {
                entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false,
              })
            }
          }
        } catch (error) {
          logEvent('zy_session_resumed', {
            entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false,
          })
          logError(error)
          await exitWithError(root, `Unable to load transcript from file: ${options.resume}`, () =>
            gracefulShutdown(1),
          )
        }
      }
    }
  }

  // 如果未作为文件加载，尝试作为会话 ID
  if (maybeSessionId) {
    // 按 ID 恢复特定会话
    const sessionId = maybeSessionId
    try {
      const resumeStart = performance.now()
      // 如果可用使用 matchedLog（用于按自定义标题跨 worktree 恢复）
      // 否则回退到 sessionId 字符串（用于直接 UUID 恢复）
      const result = await loadConversationForResume(matchedLog ?? sessionId, undefined)
      if (!result) {
        logEvent('zy_session_resumed', {
          entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: false,
        })
        return await exitWithError(root, `No conversation found with session ID: ${sessionId}`)
      }
      const fullPath = matchedLog?.fullPath ?? result.fullPath
      processedResume = await processResumedConversation(
        result,
        {
          forkSession: !!options.forkSession,
          sessionIdOverride: sessionId,
          transcriptPath: fullPath,
        },
        resumeContext,
      )
      if (processedResume.restoredAgentDef) {
        mainThreadAgentDefinition = processedResume.restoredAgentDef
      }
      logEvent('zy_session_resumed', {
        entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart),
      })
    } catch (error) {
      logEvent('zy_session_resumed', {
        entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false,
      })
      logError(error)
      await exitWithError(root, `Failed to resume session ${sessionId}`)
    }
  }

  // 如果成功恢复了会话，渲染 REPL。
  const resumeData = processedResume
  if (resumeData) {
    maybeActivateProactive(options)
    maybeActivateBrief(options)
    await launchResumedSessionRepl({
      root,
      appProps: { getFpsMetrics, stats, initialState: resumeData.initialState },
      renderAndRun,
      sessionConfig,
      resumed: resumeData,
      fallbackAgentDefinition: mainThreadAgentDefinition,
    })
  } else {
    // 显示交互式选择器（包括同仓库 worktrees）
    // ResumeConversation 内部加载日志以确保选择后正确 GC
    await launchResumeChooser(
      root,
      {
        getFpsMetrics,
        stats,
        initialState,
      },
      getWorktreePaths(getOriginalCwd()),
      {
        ...sessionConfig,
        initialSearchQuery: searchTerm,
        forkSession: options.forkSession,
        filterByPr,
      },
    )
  }
}
