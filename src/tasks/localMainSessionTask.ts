/**
 * localMainSessionTask：处理主 session query 的后台运行。
 *
 * 用户在 query 期间连续按两次 Ctrl+B 时，session 会进入“后台”：
 * - The query continues running in the background
 * - The UI clears to a fresh prompt
 * - A notification is sent when the query completes
 *
 * 由于行为相似，此处复用 LocalAgentTask state 结构。
 */

import type { UUID } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { type QueryParams, query } from '../query/index.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../services/task-runtime/diskOutput.js'
import { registerTask, updateTaskState } from '../services/task-runtime/framework.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { SetAppState } from '../tasks/task.js'
import { createTaskStateBase } from '../tasks/task.js'
import type { AgentDefinition, CustomAgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createAbortController } from '../utils/abortController.js'
import { runWithAgentContext, type SubagentContext } from '../services/agent/agentContext.js'
import { emitTaskTerminatedBridge } from '../services/bridge/bridgeEventQueue.js'
import { registerCleanup } from '../services/cleanup/cleanupRegistry.js'
import { logForDebugging } from '../services/infra/debug.js'
import { logError } from '../services/infra/log.js'
import { enqueuePendingNotification } from '../services/input/messageQueueManager.js'
import { getAgentTranscriptPath, recordSidechainTranscript } from '../services/sessionStorage.js'
import type { LocalAgentTaskState } from './local-agent-task/LocalAgentTask.js'

// 主 session task 使用 agentType='main-session' 的 LocalAgentTaskState
export type localMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
}

/**
 * 未指定 agent 时，主 session task 使用的默认 agent 定义。
 */
const DEFAULT_MAIN_SESSION_AGENT: CustomAgentDefinition = {
  agentType: 'main-session',
  whenToUse: 'Main session query',
  source: 'userSettings',
  getSystemPrompt: () => '',
}

/**
 * 为主 session task 生成唯一 ID；使用前缀 's'，与前缀为 'a' 的 agent task 区分。
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  const bytes = randomBytes(8)
  let id = 's'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

/**
 * 注册已转入后台的主 session task，在用户把当前 session query 转入后台时调用。
 *
 * @param description - Description of the task
 * @param setAppState - State setter function
 * @param mainThreadAgentDefinition - Optional agent definition if running with --agent
 * @param existingAbortController - Optional abort controller to reuse (for backgrounding an active query)
 * @returns Object with task ID and abort signal for stopping the background query
 */
export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
): { taskId: string; abortSignal: AbortSignal } {
  const taskId = generateMainSessionTaskId()

  // 将输出关联到按 task 隔离的 transcript 文件，布局与 sub-agent 相同。不要使用
  // getTranscriptPath()，它指向主 session 文件；/clear 后后台 query 若继续写入该文件，
  // 会破坏清空后的对话。隔离路径让此 task 可以继续存活
  // /clear: the symlink re-link in clearConversation handles session ID changes.
  void initTaskOutputAsSymlink(taskId, getAgentTranscriptPath(asAgentId(taskId)))

  // 若提供了现有 abort controller 则继续使用，这对正在执行的 query 转后台尤为重要，
  // 可确保终止 task 时实际 query 也会 abort
  const abortController = existingAbortController ?? createAbortController()

  const unregisterCleanup = registerCleanup(async () => {
    // 进程退出时清理
    setAppState((prev) => {
      const { [taskId]: removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })

  // 使用已提供的 agent 定义，否则使用默认值
  const selectedAgent = mainThreadAgentDefinition ?? DEFAULT_MAIN_SESSION_AGENT

  // 创建 task state；调用发生在用户转入后台时，因此初始即为后台状态
  const taskState: localMainSessionTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent,
    agentType: 'main-session',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // Already backgrounded
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }

  logForDebugging(
    `[localMainSessionTask] Registering task ${taskId} with description: ${description}`,
  )
  registerTask(taskState, setAppState)

  // 检查 state，确认 task 已注册
  setAppState((prev) => {
    const hasTask = taskId in prev.tasks
    logForDebugging(
      `[localMainSessionTask] After registration, task ${taskId} exists in state: ${hasTask}`,
    )
    return prev
  })

  return { taskId, abortSignal: abortController.signal }
}

/**
 * 完成主 session task 并发送通知，在后台 query 结束时调用。
 */
export function completeMainSessionTask(
  taskId: string,
  success: boolean,
  setAppState: SetAppState,
): void {
  let wasBackgrounded = true
  let toolUseId: string | undefined

  updateTaskState<localMainSessionTaskState>(taskId, setAppState, (task) => {
    if (task.status !== 'running') {
      return task
    }

    // 记录 task 是否在后台，用于决定是否通知
    wasBackgrounded = task.isBackgrounded ?? true
    toolUseId = task.toolUseId

    task.unregisterCleanup?.()

    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    }
  })

  void evictTaskOutput(taskId)

  // 仅当 task 仍在后台时发送通知；若已回到前台，用户正直接查看，无需通知
  if (wasBackgrounded) {
    enqueueMainSessionNotification(
      taskId,
      'Background session',
      success ? 'completed' : 'failed',
      setAppState,
      toolUseId,
    )
  } else {
    // 已回到前台：TUI 用户正在查看，因此不发 XML 通知；但 SDK consumer 仍需看到
    // task_started 的收尾事件。设置 notified 以通过 evictTerminalTask/
    // generateTaskAttachments 的淘汰保护；后台路径会在
    // enqueueMainSessionNotification 的检查并设置过程中写入该值。
    updateTaskState(taskId, setAppState, (task) => ({ ...task, notified: true }))
    emitTaskTerminatedBridge(taskId, success ? 'completed' : 'failed', {
      toolUseId,
      summary: 'Background session',
    })
  }
}

/**
 * 将后台 session 完成通知加入队列。
 */
function enqueueMainSessionNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed',
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  // 原子地检查并设置 notified 标志，防止重复通知
  let shouldEnqueue = false
  updateTaskState(taskId, setAppState, (task) => {
    if (task.notified) {
      return task
    }
    shouldEnqueue = true
    return { ...task, notified: true }
  })

  if (!shouldEnqueue) {
    return
  }

  const summary =
    status === 'completed'
      ? `Background session "${description}" completed`
      : `Background session "${description}" failed`

  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>` : ''

  const outputPath = getTaskOutputPath(taskId)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * 将主 session task 切回前台：标记为前台，使输出显示在主视图中；后台 query 继续运行。
 * 返回 task 已累积的消息，找不到 task 时返回 undefined。
 */
export function foregroundMainSessionTask(
  taskId: string,
  setAppState: SetAppState,
): Message[] | undefined {
  let taskMessages: Message[] | undefined

  setAppState((prev) => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'local_agent') {
      return prev
    }

    taskMessages = (task as localMainSessionTaskState).messages

    // 若存在先前的前台 task，将其恢复为后台
    const prevId = prev.foregroundedTaskId
    const prevTask = prevId ? prev.tasks[prevId] : undefined
    const restorePrev = prevId && prevId !== taskId && prevTask?.type === 'local_agent'

    return {
      ...prev,
      foregroundedTaskId: taskId,
      tasks: {
        ...prev.tasks,
        ...(restorePrev && { [prevId]: { ...prevTask, isBackgrounded: true } }),
        [taskId]: { ...task, isBackgrounded: false },
      },
    }
  })

  return taskMessages
}

/**
 * 检查 task 是否为主 session task，而非普通 agent task。
 */
export function isMainSessionTask(task: unknown): task is localMainSessionTaskState {
  if (typeof task !== 'object' || task === null || !('type' in task) || !('agentType' in task)) {
    return false
  }
  return (
    task.type === 'local_agent' && (task as localMainSessionTaskState).agentType === 'main-session'
  )
}

// 展示时保留的最近 activity 数量上限
const MAX_RECENT_ACTIVITIES = 5

type ToolActivity = {
  toolName: string
  input: Record<string, unknown>
}

/**
 * 使用给定消息启动新的后台 session。
 *
 * 使用当前消息启动独立 query() 调用并注册为后台 task；调用方的前台 query 正常继续。
 */
export function startBackgroundSession({
  messages,
  queryParams,
  description,
  setAppState,
  agentDefinition,
}: {
  messages: Message[]
  queryParams: Omit<QueryParams, 'messages'>
  description: string
  setAppState: SetAppState
  agentDefinition?: AgentDefinition
}): string {
  const { taskId, abortSignal } = registerMainSessionTask(description, setAppState, agentDefinition)

  // 将转入后台前的对话保存到 task 的隔离 transcript，使 TaskOutput 能立即显示 context；
  // 后续消息在下方增量写入。
  void recordSidechainTranscript(messages, taskId).catch((err) =>
    logForDebugging(`bg-session initial transcript write failed: ${err}`),
  )

  // 包装在 agent context 中，使 skill 调用限定到此 task 的 agentId
  // (not null). This lets clearInvokedSkills(preservedAgentIds) selectively
  // 让此 task 的 skill 跨 /clear 保留。AsyncLocalStorage 会隔离并发异步链，
  // 因此此包装不会影响前台。
  const agentContext: SubagentContext = {
    agentId: taskId,
    agentType: 'subagent',
    subagentName: 'main-session',
    isBuiltIn: true,
  }

  void runWithAgentContext(agentContext, async () => {
    try {
      const bgMessages: Message[] = [...messages]
      const recentActivities: ToolActivity[] = []
      let toolCount = 0
      let tokenCount = 0
      let lastRecordedUuid: UUID | null = (messages.at(-1)?.uuid as UUID | undefined) ?? null

      for await (const event of query({
        messages: bgMessages,
        ...queryParams,
      })) {
        if (abortSignal.aborted) {
          // 流中途 abort 时不会执行 completeMainSessionTask。
          // chat:killAgents 路径已标记 notified 并发出事件，stopTask 路径则没有。
          let alreadyNotified = false
          updateTaskState(taskId, setAppState, (task) => {
            alreadyNotified = task.notified === true
            return alreadyNotified ? task : { ...task, notified: true }
          })
          if (!alreadyNotified) {
            emitTaskTerminatedBridge(taskId, 'stopped', {
              summary: description,
            })
          }
          return
        }

        if (event.type !== 'user' && event.type !== 'assistant' && event.type !== 'system') {
          continue
        }

        bgMessages.push(event)

        // 按消息写入，与 runAgent.ts 的模式一致；这样既能提供实时 TaskOutput 进度，
        // 也能确保 transcript 文件始终最新，即使
        // /clear re-links the symlink mid-run.
        void recordSidechainTranscript([event], taskId, lastRecordedUuid).catch((err) =>
          logForDebugging(`bg-session transcript write failed: ${err}`),
        )
        lastRecordedUuid = event.uuid as UUID

        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              tokenCount += roughTokenCountEstimation(block.text)
            } else if (block.type === 'tool_call') {
              toolCount++
              const activity: ToolActivity = {
                toolName: block.name,
                input: block.input as Record<string, unknown>,
              }
              recentActivities.push(activity)
              if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
                recentActivities.shift()
              }
            }
          }
        }

        setAppState((prev) => {
          const task = prev.tasks[taskId]
          if (!task || task.type !== 'local_agent') {
            return prev
          }
          const prevProgress = task.progress
          if (
            prevProgress?.tokenCount === tokenCount &&
            prevProgress.toolUseCount === toolCount &&
            task.messages === bgMessages
          ) {
            return prev
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [taskId]: {
                ...task,
                progress: {
                  tokenCount,
                  toolUseCount: toolCount,
                  recentActivities:
                    prevProgress?.toolUseCount === toolCount
                      ? prevProgress.recentActivities
                      : [...recentActivities],
                },
                messages: bgMessages,
              },
            },
          }
        })
      }

      completeMainSessionTask(taskId, true, setAppState)
    } catch (error) {
      logError(error)
      completeMainSessionTask(taskId, false, setAppState)
    }
  })

  return taskId
}
