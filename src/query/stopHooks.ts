import { feature } from 'bun:bundle'
import { tSync } from '../i18n/index.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { isExtractModeActive } from '../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../tool.js'
import type { HookProgress } from '../types/hooks/index.js'
import type {
  AssistantMessage,
  Message,
  RequestStartEvent,
  StopHookInfo,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../types/message.js'
import {
  createAttachmentMessage,
  type HookAttachment,
} from '../services/attachments/attachments.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import type { REPLHookContext } from '../services/hooks/postSamplingHooks.js'
import {
  executeStopHooks,
  executeTaskCompletedHooks,
  executeTeammateIdleHooks,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTeammateIdleHookMessage,
} from '../services/hooks.js'
import {
  createStopHookSummaryMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
} from '../services/messages/./constructors.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import { getTaskListId, listTasks } from '../utils/tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../utils/teammate.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const extractMemoriesModule = feature('MEMORY')
  ? (require('../services/extract-memories/extractMemories.js') as typeof import('../services/extract-memories/extractMemories.js'))
  : null
const jobClassifierModule = feature('TEMPLATES')
  ? (require('../services/jobs/classifier.js') as typeof import('../services/jobs/classifier.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import type { QuerySource } from '../constants/querySource.js'
import { executeAutoDream } from '../services/auto-dream/autoDream.js'
import { executePromptSuggestion } from '../services/prompt-suggestion/promptSuggestion.js'
import { isBareMode, isEnvDefinedFalsy } from '../utils/envUtils.js'
import { createCacheSafeParams, saveCacheSafeParams } from '../utils/forkedAgent.js'

type StopHookResult = {
  blockingErrors: Message[]
  preventContinuation: boolean
}

function isHookAttachment(attachment: { type: string }): attachment is HookAttachment {
  return 'hookEvent' in attachment
}

// stop hook 连续 block 熔断在 query.ts 的查询循环里实现（State.stopHookBlockingCount
// + getStopHookBlockCap()）：那里才是真正会死循环的路径——stop hook exit 2 返回
// blockingErrors（preventContinuation:false），循环 continue 重试。preventContinuation
// 路径本就 return 结束 turn，不会循环，无需在此计数。

export async function* handleStopHooks(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
  stopHookActive?: boolean,
): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  StopHookResult
> {
  const hookStartTime = Date.now()

  const stopHookContext: REPLHookContext = {
    messages: [...messagesForQuery, ...assistantMessages],
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }
  // 仅主会话查询保存参数，子代理不得覆盖。
  // 在 prompt-suggestion 门控之外：REPL /btw 和 SDK side_question 都读此快照。
  if (querySource === 'repl_main_thread' || querySource === 'sdk') {
    saveCacheSafeParams(createCacheSafeParams(stopHookContext))
  }

  // 模板任务分类：作为调度任务运行时，每轮结束后分类状态。
  // 限定 repl_main_thread 以防后台 fork（extract-memories/auto-dream）污染时间线。
  // 等待分类器完成以确保 state.json 在轮次返回前写入。
  if (
    feature('TEMPLATES') &&
    process.env.CLAUDE_JOB_DIR &&
    querySource.startsWith('repl_main_thread') &&
    !toolUseContext.agentId
  ) {
    // 完整轮次历史 — assistantMessages 每次 queryLoop 迭代重置，
    // 早期迭代的工具调用需要 messagesForQuery 才能出现在摘要中。
    const turnAssistantMessages = stopHookContext.messages.filter(
      (m): m is AssistantMessage => m.type === 'assistant',
    )
    const p = jobClassifierModule!
      .classifyAndWriteState(process.env.CLAUDE_JOB_DIR, turnAssistantMessages)
      .catch((err) => {
        logForDebugging(`[job] classifier error: ${errorMessage(err)}`, {
          level: 'error',
        })
      })
    await Promise.race([
      p,
      // eslint-disable-next-line no-restricted-syntax -- sleep() has no .unref(); timer must not block exit
      new Promise<void>((r) => setTimeout(r, 60_000).unref()),
    ])
  }
  // --bare 模式跳过后台记账（prompt suggestion、memory extraction、auto-dream）。
  if (!isBareMode()) {
    if (!isEnvDefinedFalsy(process.env.ZY_CODE_ENABLE_PROMPT_SUGGESTION)) {
      void executePromptSuggestion(stopHookContext)
    }
    if (feature('EXTRACT_MEMORIES') && !toolUseContext.agentId && isExtractModeActive()) {
      // 发射即忘。-p/SDK 模式下 print.ts 在 gracefulShutdownSync 前 drain。
      void extractMemoriesModule!.executeExtractMemories(
        stopHookContext,
        toolUseContext.appendSystemMessage,
      )
    }
    if (!toolUseContext.agentId) {
      void executeAutoDream(stopHookContext, toolUseContext.appendSystemMessage)
    }
  }

  // chicago MCP：轮次结束时自动取消隐藏 + 释放锁。
  // 仅主线程 — CU 锁是进程级模块变量，子代理释放会导致主线程清理失效。
  if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
    try {
      const { cleanupComputerUseAfterTurn } = await import('../services/computer-use/cleanup.js')
      await cleanupComputerUseAfterTurn(toolUseContext)
    } catch {
      // 清理失败静默忽略，非关键路径
    }
  }

  try {
    const blockingErrors = []
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode

    const generator = executeStopHooks(
      permissionMode,
      toolUseContext.abortController.signal,
      undefined,
      stopHookActive ?? false,
      toolUseContext.agentId,
      toolUseContext,
      [...messagesForQuery, ...assistantMessages],
      toolUseContext.agentType,
    )

    // 消费所有 progress 消息并收集 blocking error
    let stopHookToolUseID = ''
    let hookCount = 0
    let preventedContinuation = false
    let stopReason = ''
    let hasOutput = false
    const hookErrors: string[] = []
    const hookInfos: StopHookInfo[] = []

    for await (const result of generator) {
      // terminalSequence 已在 executeEngine 统一校验并写 stdout（含白名单），此处不再处理。
      if (result.message) {
        yield result.message
        if (result.message.type === 'progress' && result.message.toolUseID) {
          stopHookToolUseID = result.message.toolUseID
          hookCount++
          const progressData = result.message.data as HookProgress
          if (progressData.command) {
            hookInfos.push({
              hookName: progressData.hookName,
              status: 'running',
              command: progressData.command,
            })
          }
        }
        if (result.message.type === 'attachment' && isHookAttachment(result.message.attachment)) {
          const { attachment } = result.message
          if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
            if (attachment.type === 'hook_non_blocking_error') {
              hookErrors.push(attachment.stderr || `Exit code ${attachment.exitCode}`)
              hasOutput = true
            } else if (attachment.type === 'hook_error_during_execution') {
              hookErrors.push(attachment.content)
              hasOutput = true
            } else if (attachment.type === 'hook_success') {
              if (attachment.stdout?.trim() || attachment.stderr?.trim()) {
                hasOutput = true
              }
            }
            if ('durationMs' in attachment && 'command' in attachment) {
              const info = hookInfos.find(
                (i) => i.command === attachment.command && i.durationMs === undefined,
              )
              if (info) {
                info.durationMs = attachment.durationMs
              }
            }
          }
        }
      }
      if (result.blockingError) {
        const userMessage = createUserMessage({
          content: [{ type: 'text' as const, text: getStopHookMessage(result.blockingError) }],
          isMeta: true, // 对 UI 隐藏（在 summary message 中展示）
        })
        blockingErrors.push(userMessage)
        yield userMessage
        hasOutput = true
        hookErrors.push(result.blockingError.blockingError)
      }
      // hook 请求阻止继续
      if (result.preventContinuation) {
        preventedContinuation = true
        stopReason = result.stopReason || 'Stop hook prevented continuation'
        // 生成 attachment 记录阻止继续（结构化数据）
        yield createAttachmentMessage({
          type: 'hook_stopped_continuation',
          message: stopReason,
          hookName: 'Stop',
          toolUseID: stopHookToolUseID,
          hookEvent: 'Stop',
        })
      }

      // hook 执行期间被中断
      if (toolUseContext.abortController.signal.aborted) {
        logEvent('zy_pre_stop_hooks_cancelled', {
          queryChainId: toolUseContext.queryTracking
            ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,

          queryDepth: toolUseContext.queryTracking?.depth,
        })
        yield createUserInterruptionMessage({
          toolUse: false,
        })
        return { blockingErrors: [], preventContinuation: true }
      }
    }

    // hook 执行后生成摘要系统消息
    if (hookCount > 0) {
      yield createStopHookSummaryMessage(
        hookCount,
        hookInfos,
        hookErrors,
        preventedContinuation,
        stopReason,
        hasOutput,
        'suggestion',
        stopHookToolUseID,
      )

      // 发送错误通知（在 verbose/transcript 模式通过 ctrl+o 查看）
      if (hookErrors.length > 0) {
        const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
        toolUseContext.addNotification?.({
          key: 'stop-hook-error',
          text: tSync('notification.stopHookError', { shortcut: expandShortcut }),
          priority: 'immediate',
        })
      }
    }

    if (preventedContinuation) {
      return { blockingErrors: [], preventContinuation: true }
    }

    // 收集 stop hook 的 blocking error
    if (blockingErrors.length > 0) {
      return { blockingErrors, preventContinuation: false }
    }

    // Stop hook 通过后，若为 teammate 则执行 TaskCompleted 和 TeammateIdle hook
    if (isTeammate()) {
      const teammateName = getAgentName() ?? ''
      const teamName = getTeamName() ?? ''
      const teammateBlockingErrors: Message[] = []
      let teammatePreventedContinuation = false
      let teammateStopReason: string | undefined
      // 每个 hook executor 生成独立的 toolUseID，从 progress 消息中捕获。
      let teammateHookToolUseID = ''

      // 为该 teammate 拥有的进行中任务执行 TaskCompleted hook
      const taskListId = getTaskListId()
      const tasks = await listTasks(taskListId)
      const inProgressTasks = tasks.filter(
        (t) => t.status === 'in_progress' && t.owner === teammateName,
      )

      for (const task of inProgressTasks) {
        const taskCompletedGenerator = executeTaskCompletedHooks(
          task.id,
          task.subject,
          task.description,
          teammateName,
          teamName,
          permissionMode,
          toolUseContext.abortController.signal,
          undefined,
          toolUseContext,
        )

        for await (const result of taskCompletedGenerator) {
          if (result.message) {
            if (result.message.type === 'progress' && result.message.toolUseID) {
              teammateHookToolUseID = result.message.toolUseID
            }
            yield result.message
          }
          if (result.blockingError) {
            const userMessage = createUserMessage({
              content: [
                { type: 'text' as const, text: getTaskCompletedHookMessage(result.blockingError) },
              ],
              isMeta: true,
            })
            teammateBlockingErrors.push(userMessage)
            yield userMessage
          }
          // 与 Stop hook 行为一致：支持 preventContinuation/stopReason
          if (result.preventContinuation) {
            teammatePreventedContinuation = true
            teammateStopReason = result.stopReason || 'TaskCompleted hook prevented continuation'
            yield createAttachmentMessage({
              type: 'hook_stopped_continuation',
              message: teammateStopReason,
              hookName: 'TaskCompleted',
              toolUseID: teammateHookToolUseID,
              hookEvent: 'TaskCompleted',
            })
          }
          if (toolUseContext.abortController.signal.aborted) {
            return { blockingErrors: [], preventContinuation: true }
          }
        }
      }

      // 执行 TeammateIdle hook
      const teammateIdleGenerator = executeTeammateIdleHooks(
        teammateName,
        teamName,
        permissionMode,
        toolUseContext.abortController.signal,
      )

      for await (const result of teammateIdleGenerator) {
        if (result.message) {
          if (result.message.type === 'progress' && result.message.toolUseID) {
            teammateHookToolUseID = result.message.toolUseID
          }
          yield result.message
        }
        if (result.blockingError) {
          const userMessage = createUserMessage({
            content: [
              { type: 'text' as const, text: getTeammateIdleHookMessage(result.blockingError) },
            ],
            isMeta: true,
          })
          teammateBlockingErrors.push(userMessage)
          yield userMessage
        }
        // 与 Stop hook 行为一致：支持 preventContinuation/stopReason
        if (result.preventContinuation) {
          teammatePreventedContinuation = true
          teammateStopReason = result.stopReason || 'TeammateIdle hook prevented continuation'
          yield createAttachmentMessage({
            type: 'hook_stopped_continuation',
            message: teammateStopReason,
            hookName: 'TeammateIdle',
            toolUseID: teammateHookToolUseID,
            hookEvent: 'TeammateIdle',
          })
        }
        if (toolUseContext.abortController.signal.aborted) {
          return { blockingErrors: [], preventContinuation: true }
        }
      }

      if (teammatePreventedContinuation) {
        return { blockingErrors: [], preventContinuation: true }
      }

      if (teammateBlockingErrors.length > 0) {
        return {
          blockingErrors: teammateBlockingErrors,
          preventContinuation: false,
        }
      }
    }

    return { blockingErrors: [], preventContinuation: false }
  } catch (error) {
    const durationMs = Date.now() - hookStartTime
    logEvent('zy_stop_hook_error', {
      duration: durationMs,

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
    })
    // 产出系统消息供用户调试 hook（对模型不可见）。
    yield createSystemMessage(`Stop hook failed: ${errorMessage(error)}`, 'warning')
    return { blockingErrors: [], preventContinuation: false }
  }
}
