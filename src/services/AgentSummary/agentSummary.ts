/**
 * 协调器模式下子代理的定期后台摘要。
 *
 * 每约 30 秒使用 runForkedAgent() 分叉子代理的对话，
 * 生成 1-2 句进度摘要。摘要存储在 AgentProgress 上用于 UI 显示。
 *
 * 缓存共享：与父代理使用相同的 CacheSafeParams 以共享提示缓存。
 * 工具保留在请求中以匹配缓存键，但通过 canUseTool 回调拒绝。
 */

import type { TaskContext } from '../../Task.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

const SUMMARY_INTERVAL_MS = 30_000

function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : ''

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

export function startAgentSummarization(
  taskId: string,
  agentId: AgentId,
  cacheSafeParams: CacheSafeParams,
  setAppState: TaskContext['setAppState'],
): { stop: () => void } {
  // 从闭包中删除 forkContextMessages — runSummary 每次
  // 从 getAgentTranscript() 重新构建它。没有这个，原始的 fork 消息
  // （从 AgentTool.tsx 传递）会在计时器的生命周期内被固定。
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  let summaryAbortController: AbortController | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let previousSummary: string | null = null

  async function runSummary(): Promise<void> {
    if (stopped) return

    logForDebugging(`[AgentSummary] Timer fired for agent ${agentId}`)

    try {
      // Read current messages from transcript
      const transcript = await getAgentTranscript(agentId)
      if (!transcript || transcript.messages.length < 3) {
        // 上下文不足 — finally 块将安排下次尝试
        logForDebugging(
          `[AgentSummary] Skipping summary for ${taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        )
        return
      }

      // 过滤为干净的消息状态
      const cleanMessages = filterIncompleteToolCalls(transcript.messages)

      // 使用当前消息构建分叉参数
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      }

      logForDebugging(
        `[AgentSummary] Forking for summary, ${cleanMessages.length} messages in context`,
      )

      // 为此摘要创建 abort controller
      summaryAbortController = new AbortController()

      // 通过回调拒绝工具，而不是传递 tools:[] — 那样会破坏缓存
      const canUseTool = async () => ({
        behavior: 'deny' as const,
        message: 'No tools needed for summary',
        decisionReason: { type: 'other' as const, reason: 'summary only' },
      })

      // 不要在这里设置 maxOutputTokens。分叉通过发送相同的缓存键参数
      // （system、tools、model、messages 前缀、thinking config）来 piggyback
      // 主线程的提示缓存。设置 maxOutputTokens 会钳制 budget_tokens，
      // 创建 thinking config 不匹配，从而无效化缓存。
      //
      // ContentReplacementState 默认在 createSubagentContext 中从
      // forkParams.toolUseContext（onCacheSafeParams 时捕获的子代理 LIVE 状态）
      // 克隆。不需要显式覆盖。
      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool,
        querySource: 'agent_summary' as any,
        forkLabel: 'agent_summary',
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,
      })

      if (stopped) return

      // 从结果中提取摘要文本
      for (const msg of result.messages) {
        if (msg.type !== 'assistant') continue
        // 跳过 API 错误消息
        if (msg.isApiErrorMessage) {
          logForDebugging(
            `[AgentSummary] Skipping API error message for ${taskId}`,
          )
          continue
        }
        const textBlock = msg.message.content.find(b => b.type === 'text')
        if (textBlock?.type === 'text' && textBlock.text.trim()) {
          const summaryText = textBlock.text.trim()
          logForDebugging(
            `[AgentSummary] Summary result for ${taskId}: ${summaryText}`,
          )
          previousSummary = summaryText
          updateAgentSummary(taskId, summaryText, setAppState)
          break
        }
      }
    } catch (e) {
      if (!stopped && e instanceof Error) {
        logError(e)
      }
    } finally {
      summaryAbortController = null
      // 完成时（而非启动时）重置计时器，防止摘要重叠
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS)
  }

  function stop(): void {
    logForDebugging(`[AgentSummary] Stopping summarization for ${taskId}`)
    stopped = true
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  // 启动第一个计时器
  scheduleNext()

  return { stop }
}
