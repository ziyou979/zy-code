// resume / teleport / remote 会话分派。
// 对应原 root.ts 约 2947-3413 行的 else if 分支，处理：
// --from-pr PR 过滤、按自定义标题搜索会话、--remote 远程会话创建、
// --teleport 远程传送、普通 resume 会话恢复、交互式会话选择器。

import { resolve } from 'node:path'
import chalk from 'chalk'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  setOriginalCwd,
  switchSession,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { setIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { setTeleportedSessionInfo } from 'src/bootstrap/runtime/runtimeContext.js'
import { filterCommandsForRemoteMode } from '../../commands/index.js'
import { getRemoteSessionUrl } from '../../constants/product.js'
import type { StatsStore } from '../../context/stats.js'
import {
  launchResumeChooser,
  launchTeleportRepoMismatchDialog,
  launchTeleportResumeWrapper,
} from '../../cli/dialogLaunchers.js'
import type { Root } from '../../ink/index.js'
import { exitWithError } from '../../cli/interactiveHelpers.js'
import { createRemoteSessionConfig } from '../../remote/remoteSessionManager.js'
import type { DownloadResult } from '../../services/api/filesApi.js'
import { isPolicyAllowed, waitForPolicyLimitsToLoad } from '../../services/policy-limits/index.js'
import { fetchSession, prepareApiRequest } from '../../services/teleport/api.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../../tools/AgentTool/loadAgentsDir.js'
import type { Command } from '../../commands/types.js'
import { asSessionId } from '../../types/ids.js'
import type { LogOption } from '../../types/logs.js'
import type { Message as MessageType } from '../../types/message.js'
import { count } from '../../utils/array.js'
import { loadConversationForResume } from '../../utils/conversationRecovery.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { errorMessage, isENOENT, TeleportOperationError, toError } from '../../utils/errors.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { getWorktreePaths } from '../../services/worktree/getWorktreePaths.js'
import { getBranch } from '../../utils/git.js'
import { filterExistingPaths, getKnownPathsForRepo } from '../../services/github/githubRepoPathMapping.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { logError } from '../../utils/log.js'
import { createSystemMessage, createUserMessage } from '../../services/messages/./constructors.js'
import { setCwd } from '../../services/shell/shell.js'
import { type ProcessedResume, processResumedConversation } from '../../utils/sessionRestore.js'
import {
  getSessionIdFromLog,
  loadTranscriptFromFile,
  searchSessionsByCustomTitle,
} from '../../services/sessionStorage.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  validateGitState,
  validateSessionRepository,
} from '../../services/teleport/teleport.js'
import { teleportToRemoteWithErrorHandling } from '../../components/TeleportController.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { validateUuid } from '../../utils/uuid.js'
import { maybeActivateBrief } from '../activate/brief.js'
import { maybeActivateProactive } from '../activate/proactive.js'
import { launchRemoteSessionRepl } from './remoteSession.js'
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
  teleport: string | true | null
  remote: string | null
  commands: Command[]
  debug: boolean
  debugToStderr: boolean
  ide: boolean
  disableSlashCommands: boolean
  thinkingConfig: ThinkingConfig
  fileDownloadPromise: Promise<DownloadResult[]> | undefined
}

/**
 * 分派 resume / teleport / remote 会话恢复流程。
 *
 * 对应原 root.ts 中 `else if (options.resume || options.fromPr || teleport || remote !== null)` 分支。
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
    teleport,
    remote,
    commands,
    debug,
    debugToStderr,
    ide,
    disableSlashCommands,
    thinkingConfig,
    fileDownloadPromise,
  } = params

  // mainThreadAgentDefinition 在分支内部可能被 restoredAgentDef 覆盖
  let mainThreadAgentDefinition = params.mainThreadAgentDefinition

  // 处理恢复流程 —— 从文件（仅限 ant）、会话 ID 或交互式选择器恢复

  // 恢复前清除过时缓存，确保文件/技能发现为最新
  const { clearSessionCaches } = await import('../../commands/clear/caches.js')
  clearSessionCaches()
  let messages: MessageType[] | null = null
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

  // --remote 和 --teleport 都创建/恢复 ZY Code Web (ZYR) 会话。
  // Remote Control (--rc) 是独立的功能，门控在 initReplBridge.ts 中。
  if (remote !== null || teleport) {
    await waitForPolicyLimitsToLoad()
    if (!isPolicyAllowed('allow_remote_sessions')) {
      return await exitWithError(
        root,
        "Error: Remote sessions are disabled by your organization's policy.",
        () => gracefulShutdown(1),
      )
    }
  }
  if (remote !== null) {
    // 创建远程会话（可选带初始提示）
    const hasInitialPrompt = remote.length > 0

    // 检查是否启用了 TUI 模式 —— 描述仅在 TUI 模式下是可选的
    const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('zy_remote_backend', false)
    if (!isRemoteTuiEnabled && !hasInitialPrompt) {
      return await exitWithError(
        root,
        'Error: --remote requires a description.\nUsage: zycode --remote "your task description"',
        () => gracefulShutdown(1),
      )
    }
    logEvent('zy_remote_create_session', {
      has_initial_prompt: String(
        hasInitialPrompt,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 传递当前分支以便 CCR 在正确的修订版克隆仓库
    const currentBranch = await getBranch()
    const createdSession = await teleportToRemoteWithErrorHandling(
      root,
      hasInitialPrompt ? remote : null,
      new AbortController().signal,
      currentBranch || undefined,
    )
    if (!createdSession) {
      logEvent('zy_remote_create_session_error', {
        error:
          'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return await exitWithError(root, 'Error: Unable to create remote session', () =>
        gracefulShutdown(1),
      )
    }
    logEvent('zy_remote_create_session_success', {
      session_id: createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 通过功能门检查是否启用了新的远程 TUI 模式
    if (!isRemoteTuiEnabled) {
      // 原始行为：打印会话信息并退出
      process.stdout.write(`Created remote session: ${createdSession.title}\n`)
      process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`)
      process.stdout.write(`Resume with: zycode --teleport ${createdSession.id}\n`)
      await gracefulShutdown(0)
      process.exit(0)
    }

    // 新行为：启动带 CCR 引擎的本地 TUI
    // 标记我们处于远程模式以进行命令可见性
    setIsRemoteMode(true)
    switchSession(asSessionId(createdSession.id))

    // 获取远程会话的 OAuth 凭证
    let apiCreds: {
      accessToken: string
      orgUUID: string
    }
    try {
      apiCreds = await prepareApiRequest()
    } catch (error) {
      logError(toError(error))
      return await exitWithError(
        root,
        `Error: ${errorMessage(error) || 'Failed to authenticate'}`,
        () => gracefulShutdown(1),
      )
    }

    // 为 REPL 创建远程会话配置
    const { getZyAIOAuthTokens: getTokensForRemote } = await import('../../services/auth/auth.js')
    const getAccessTokenForRemote = (): string =>
      getTokensForRemote()?.accessToken ?? apiCreds.accessToken
    const remoteSessionConfig = createRemoteSessionConfig(
      createdSession.id,
      getAccessTokenForRemote,
      apiCreds.orgUUID,
      hasInitialPrompt,
    )

    // 将远程会话信息作为初始系统消息添加
    const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`
    const remoteInfoMessage = createSystemMessage(
      `/remote-control is active. Code in CLI or at ${remoteSessionUrl}`,
      'info',
    )

    // 如果提供了提示，从提示创建初始用户消息（CCR 回显它但我们忽略）
    const initialUserMessage = hasInitialPrompt
      ? createUserMessage({
          content: [{ type: 'text' as const, text: remote ?? '' }],
        })
      : null

    // 在应用状态中设置远程会话 URL 用于底部指示器
    const remoteInitialState = {
      ...initialState,
      remoteSessionUrl,
    }

    // 预过滤命令以仅包含远程安全的命令。
    // CCR 的初始化响应可能进一步细化列表（通过 REPL 中的 handleRemoteInit）。
    const remoteCommands = filterCommandsForRemoteMode(commands)
    await launchRemoteSessionRepl({
      root,
      appProps: { getFpsMetrics, stats, initialState: remoteInitialState },
      renderAndRun,
      config: {
        debug: debug || debugToStderr,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        thinkingConfig,
      },
      remoteCommands,
      initialMessages: initialUserMessage
        ? [remoteInfoMessage, initialUserMessage]
        : [remoteInfoMessage],
      remoteSessionConfig,
    })
    return
  } else if (teleport) {
    if (teleport === true || teleport === '') {
      // 交互模式：显示任务选择器并处理恢复
      logEvent('zy_teleport_interactive_mode', {})
      logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...')
      const teleportResult = await launchTeleportResumeWrapper(root)
      if (!teleportResult) {
        // 用户取消或发生错误
        await gracefulShutdown(0)
        process.exit(0)
      }
      const { branchError } = await checkOutTeleportedSessionBranch(teleportResult.branch)
      messages = processMessagesForTeleportResume(teleportResult.log, branchError)
    } else if (typeof teleport === 'string') {
      logEvent('zy_teleport_resume_session', {
        mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      try {
        // 首先，在检查 git 状态之前获取会话并验证仓库
        const sessionData = await fetchSession(teleport)
        const repoValidation = await validateSessionRepository(sessionData)

        // 处理仓库不匹配或不在仓库中的情况
        if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
          const sessionRepo = repoValidation.sessionRepo
          if (sessionRepo) {
            // 检查已知路径
            const knownPaths = getKnownPathsForRepo(sessionRepo)
            const existingPaths = await filterExistingPaths(knownPaths)
            if (existingPaths.length > 0) {
              // 显示目录切换对话框
              const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                targetRepo: sessionRepo,
                initialPaths: existingPaths,
              })
              if (selectedPath) {
                // 切换到选定的目录
                process.chdir(selectedPath)
                setCwd(selectedPath)
                setOriginalCwd(selectedPath)
              } else {
                // 用户取消
                await gracefulShutdown(0)
              }
            } else {
              // 没有已知路径 —— 显示原始错误
              throw new TeleportOperationError(
                `You must run zycode --teleport ${teleport} from a checkout of ${sessionRepo}.`,
                chalk.red(
                  `You must run zycode --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`,
                ),
              )
            }
          }
        } else if (repoValidation.status === 'error') {
          throw new TeleportOperationError(
            repoValidation.errorMessage || 'Failed to validate session',
            chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`),
          )
        }
        await validateGitState()

        // 使用进度 UI 进行 teleport
        const { teleportWithProgress } = await import('../../components/TeleportProgress.js')
        const result = await teleportWithProgress(root, teleport)
        // 跟踪 teleported 会话用于可靠性日志
        setTeleportedSessionInfo({
          sessionId: teleport,
        })
        messages = result.messages
      } catch (error) {
        if (error instanceof TeleportOperationError) {
          process.stderr.write(`${error.formattedMessage}\n`)
        } else {
          logError(error)
          process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`))
        }
        await gracefulShutdown(1)
      }
    }
  }
  if (isInternalBuild()) {
    if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
      // 检查 ccshare URL（如 https://go/ccshare/boris-20260311-211036）
      const {
        // @ts-expect-error
        parseCcshareId,
        // @ts-expect-error
        loadCcshare,
      } = await import('../../utils/ccshareResume.js')
      const ccshareId = parseCcshareId(options.resume)
      if (ccshareId) {
        try {
          const resumeStart = performance.now()
          const logOption = await loadCcshare(ccshareId)
          const result = await loadConversationForResume(logOption, undefined)
          if (result) {
            processedResume = await processResumedConversation(
              result,
              {
                forkSession: true,
                transcriptPath: result.fullPath,
              },
              resumeContext,
            )
            if (processedResume.restoredAgentDef) {
              mainThreadAgentDefinition = processedResume.restoredAgentDef
            }
            logEvent('zy_session_resumed', {
              entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: true,
              resume_duration_ms: Math.round(performance.now() - resumeStart),
            })
          } else {
            logEvent('zy_session_resumed', {
              entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false,
            })
          }
        } catch (error) {
          logEvent('zy_session_resumed', {
            entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false,
          })
          logError(error)
          await exitWithError(root, `Unable to resume from ccshare: ${errorMessage(error)}`, () =>
            gracefulShutdown(1),
          )
        }
      } else {
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

  // 在渲染 REPL 之前等待文件下载（文件必须可用）
  if (fileDownloadPromise) {
    try {
      const results = await fileDownloadPromise
      const failedCount = count(results, (r) => !r.success)
      if (failedCount > 0) {
        process.stderr.write(
          chalk.yellow(`Warning: ${failedCount}/${results.length} file(s) failed to download.\n`),
        )
      }
    } catch (error) {
      return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`)
    }
  }

  // 如果我们有处理过的恢复或 teleport 消息，渲染 REPL
  const resumeData =
    processedResume ??
    (Array.isArray(messages)
      ? {
          messages,
          fileHistorySnapshots: undefined,
          agentName: undefined,
          agentColor: undefined as AgentColorName | undefined,
          restoredAgentDef: mainThreadAgentDefinition,
          initialState,
          contentReplacements: undefined,
        }
      : undefined)
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
