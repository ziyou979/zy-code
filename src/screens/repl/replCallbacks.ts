/**
 * replCallbacks.ts — 从 REPL.tsx 提取的回调函数。
 *
 * 所有函数接收 context/params 对象代替 React 闭包捕获。
 * REPL.tsx 保留 thin useCallback 包装器。
 */

import { feature } from 'bun:bundle'
import { spawnSync } from 'node:child_process'
import { Text } from '../../ink.js'
import * as React from 'react'
import type { ReplStoreInstance, ToolJSXState } from '../../state/ReplStore.js'
import type { AppState } from '../../state/AppState.js'
import type { Message as MessageType, UserMessage } from '../../types/message.js'
import { toUUID } from '../../types/ids.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ImageBlock } from '../../types/llm.js'
import type { PastedContent } from '../../utils/config.js'
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js'
import type { ProcessUserInputContext } from '../../services/processUserInput/processUserInput.js'
import type { EffortValue } from '../../utils/effort.js'
import type { Command } from '../../commands.js'
import type { QueryGuard } from '../../utils/QueryGuard.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
  appendMessageToLocalAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { injectUserMessageToTeammate } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { resumeAgentBackground } from '../../tools/AgentTool/resumeAgent.js'
import { createUserMessage } from '../../utils/messages.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logEvent } from '../../services/analytics/index.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import { textForResubmit } from '../../utils/messages.js'
import { handlePromptSubmit } from '../../utils/handlePromptSubmit.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import { createAbortController } from '../../utils/abortController.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { getMemoryFiles } from '../../utils/agentsMd.js'
import { setClipboard } from '../../ink/termio/osc.js'
import {
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from '../../components/MessageSelector.js'
import { fileHistoryHasAnyChanges } from '../../utils/fileHistory.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import type { Notification } from '../../context/notifications.js'
import type { MessageActionCaps } from '../../components/messageActions.js'

// ── onAgentSubmit ──

export interface OnAgentSubmitParams {
  setAppState: (updater: (prev: AppState) => AppState) => void
  setInputValue: (v: string) => void
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  canUseTool: CanUseToolFn
  mainLoopModel: string
  addNotification: (n: Notification) => void
  replStore: ReplStoreInstance
}

export async function onAgentSubmitImpl(
  params: OnAgentSubmitParams,
  input: string,
  task: InProcessTeammateTaskState | LocalAgentTaskState,
  helpers: PromptInputHelpers,
): Promise<void> {
  if (isLocalAgentTask(task)) {
    appendMessageToLocalAgent(
      task.id,
      createUserMessage({
        content: [{ type: 'text' as const, text: input }],
      }),
      params.setAppState,
    )
    if (task.status === 'running') {
      queuePendingMessage(task.id, input, params.setAppState)
    } else {
      void resumeAgentBackground({
        agentId: task.id,
        prompt: input,
        toolUseContext: params.getToolUseContext(
          params.replStore.getState().messages,
          [],
          new AbortController(),
          params.mainLoopModel,
        ),
        canUseTool: params.canUseTool,
      }).catch((err) => {
        logForDebugging(`resumeAgentBackground failed: ${errorMessage(err)}`)
        params.addNotification({
          key: `resume-agent-failed-${task.id}`,
          jsx: React.createElement(
            Text,
            { color: 'error' },
            'Failed to resume agent: ',
            errorMessage(err),
          ),
          priority: 'low',
        })
      })
    }
  } else {
    injectUserMessageToTeammate(task.id, input, params.setAppState)
  }
  params.setInputValue('')
  helpers.setCursorOffset(0)
  helpers.clearBuffer()
}

// ── rewindConversationTo ──

export interface RewindConversationParams {
  replStore: ReplStoreInstance
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setAppState: (updater: (prev: AppState) => AppState) => void
  regenerateConversationId: () => void
}

export function rewindConversationToImpl(params: RewindConversationParams, message: UserMessage): void {
  const prev = params.replStore.getState().messages
  const messageIndex = prev.lastIndexOf(message)
  if (messageIndex === -1) {
    return
  }
  logEvent('zy_conversation_rewind', {
    preRewindMessageCount: prev.length,
    postRewindMessageCount: messageIndex,
    messagesRemoved: prev.length - messageIndex,
    rewindToMessageIndex: messageIndex,
  })
  params.setMessages(prev.slice(0, messageIndex))
  // Careful, this has to happen after setMessages
  params.regenerateConversationId()
  // Reset cached microcompact state so stale pinned cache edits
  // don't reference tool_use_ids from truncated messages
  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    // 回退截断 REPL 数组。归档跨度超过回退点的提交
    // 无法再投影（projectView 静默跳过它们），但暂存队列和 ID
    // 映射引用过时的 uuid。最安全简单的重置：丢弃所有内容。
    // ctx-agent 将在下次超过阈值时重新暂存
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js')
    ).resetContextCollapse()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从回退到的消息恢复状态
  params.setAppState((prev) => ({
    ...prev,
    // 从消息恢复权限模式
    toolPermissionContext:
      message.permissionMode && prev.toolPermissionContext.mode !== message.permissionMode
        ? {
            ...prev.toolPermissionContext,
            mode: message.permissionMode,
          }
        : prev.toolPermissionContext,
    // 清除来自之前对话状态的过时提示建议
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
  }))
}

// ── restoreMessageSync ──

export interface RestoreMessageSyncParams {
  rewindConversationTo: (message: UserMessage) => void
  setInputValue: (v: string) => void
  setInputMode: (mode: PromptInputMode) => void
  setPastedContents: (v: Record<number, PastedContent>) => void
}

export function restoreMessageSyncImpl(params: RestoreMessageSyncParams, message: UserMessage): void {
  params.rewindConversationTo(message)
  const r = textForResubmit(message)
  if (r) {
    params.setInputValue(r.text)
    params.setInputMode(r.mode)
  }

  // 恢复粘贴的图片
  if (
    Array.isArray(message.message.content) &&
    message.message.content.some((block) => block.type === 'image')
  ) {
    const imageBlocks: Array<ImageBlock> = message.message.content.filter(
      (block) => block.type === 'image',
    )
    if (imageBlocks.length > 0) {
      const newPastedContents: Record<number, PastedContent> = {}
      imageBlocks.forEach((block, index) => {
        const id = message.imagePasteIds?.[index] ?? index + 1
        newPastedContents[id] = {
          id,
          type: 'image',
          content: block.data,
          mediaType: block.mimeType,
        }
      })
      params.setPastedContents(newPastedContents)
    }
  }
}

// ── handleExit ──

export interface HandleExitParams {
  setIsExiting: (v: boolean) => void
  setExitFlow: (v: React.ReactNode) => void
}

export async function handleExitImpl(
  params: HandleExitParams,
  ExitFlow: React.FC<{ showWorktree: boolean; onDone: () => void; onCancel: () => void }>,
): Promise<void> {
  params.setIsExiting(true)
  // 在后台会话中，始终 detach 而非 kill —— 即使 worktree 活动
  if (feature('BG_SESSIONS') && isBgSession()) {
    spawnSync('tmux', ['detach-client'], {
      stdio: 'ignore',
    })
    params.setIsExiting(false)
    return
  }
  const showWorktree = getCurrentWorktreeSession() !== null
  if (showWorktree) {
    params.setExitFlow(
      React.createElement(ExitFlow, {
        showWorktree: true,
        onDone: () => {},
        onCancel: () => {
          params.setExitFlow(null)
          params.setIsExiting(false)
        },
      }),
    )
    return
  }
  const { default: exitCmd } = await import('../../commands/exit/index.js')
  const exitMod = await exitCmd.load()
  const exitFlowResult = await exitMod.call(() => {})
  params.setExitFlow(exitFlowResult)
  if (exitFlowResult === null) {
    params.setIsExiting(false)
  }
}

// ── executeQueuedInput ──

import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'

export interface ExecuteQueuedInputParams {
  queryGuard: QueryGuard
  commands: Command[]
  setToolJSX: (v: (ToolJSXState & { clearLocalJSX?: boolean }) | null) => void
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  messages: MessageType[]
  mainLoopModel: string
  ideSelection: IDESelection | null
  setUserInputOnProcessing: (v: string | undefined) => void
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModelParam: string,
    onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
    input?: string,
    effort?: EffortValue,
  ) => Promise<void>
  setAppState: SetAppState
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>
  canUseTool: CanUseToolFn
  addNotification: (n: Notification) => void
  setMessages: (updater: (prev: MessageType[]) => MessageType[]) => void
}

export async function executeQueuedInputImpl(
  params: ExecuteQueuedInputParams,
  queuedCommands: QueuedCommand[],
): Promise<void> {
  await handlePromptSubmit({
    helpers: {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    },
    queryGuard: params.queryGuard,
    commands: params.commands,
    onInputChange: () => {},
    setPastedContents: () => {},
    setToolJSX: params.setToolJSX,
    getToolUseContext: params.getToolUseContext,
    messages: params.messages,
    mainLoopModel: params.mainLoopModel,
    ideSelection: params.ideSelection,
    setUserInputOnProcessing: params.setUserInputOnProcessing,
    setAbortController: params.setAbortController,
    onQuery: params.onQuery,
    setAppState: params.setAppState,
    querySource: getQuerySourceForREPL(),
    onBeforeQuery: params.onBeforeQuery,
    canUseTool: params.canUseTool,
    addNotification: params.addNotification,
    setMessages: params.setMessages,
    queuedCommands,
  })
}

// ── handleIncomingPrompt ──

export interface HandleIncomingPromptParams {
  queryGuard: QueryGuard
  setAbortController: React.Dispatch<React.SetStateAction<AbortController | null>>
  onQuery: (
    newMessages: MessageType[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModelParam: string,
  ) => Promise<void>
  mainLoopModel: string
}

export function handleIncomingPromptImpl(
  params: HandleIncomingPromptParams,
  content: string,
  options?: { isMeta?: boolean },
): boolean {
  if (params.queryGuard.isActive) {
    return false
  }

  // 延迟到用户排队命令 —— 用户输入始终优先于
  // 系统消息（teammate 消息、任务列表项等）
  if (getCommandQueue().some((cmd) => cmd.mode === 'prompt' || cmd.mode === 'bash')) {
    return false
  }
  const newAbortController = createAbortController()
  params.setAbortController(newAbortController)

  // 创建包含格式化内容的用户消息（包含 XML 包装器）
  const userMessage = createUserMessage({
    content: [{ type: 'text' as const, text: content }],
    isMeta: options?.isMeta ? true : undefined,
  })
  void params.onQuery([userMessage], newAbortController, true, [], params.mainLoopModel)
  return true
}

// ── onInit ──

export interface OnInitParams {
  reverify: () => void
  replStore: ReplStoreInstance
}

export async function onInitImpl(params: OnInitParams): Promise<void> {
  // 始终在启动时验证 API key
  void params.reverify()

  // 启动时用 AGENTS.md 文件填充 readFileState
  const memoryFiles = await getMemoryFiles()
  if (memoryFiles.length > 0) {
    const fileList = memoryFiles
      .map(
        (f) =>
          `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`,
      )
      .join('\n')
    logForDebugging(`Loaded ${memoryFiles.length} AGENTS.md/rules files:\n${fileList}`)
  } else {
    logForDebugging('No AGENTS.md/rules files found')
  }
  for (const file of memoryFiles) {
    params.replStore.mutable.readFileState.set(file.path, {
      content: file.contentDiffersFromDisk ? (file.rawContent ?? file.content) : file.content,
      timestamp: Date.now(),
      offset: undefined,
      limit: undefined,
      isPartialView: file.contentDiffersFromDisk,
    })
  }
}

// ── buildMessageActionCaps ──

export interface BuildMessageActionCapsParams {
  messages: MessageType[]
  addNotification: (n: Notification) => void
  fileHistory: FileHistoryState
  onCancel: () => void
  handleRestoreMessage: (message: UserMessage) => Promise<void>
  setMessageSelectorPreselect: (m: UserMessage | undefined) => void
  setIsMessageSelectorVisible: (v: boolean) => void
}

export function buildMessageActionCaps(params: BuildMessageActionCapsParams): MessageActionCaps {
  // 24 字符前缀：deriveUUID 保留前 24 位
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24)
    return params.messages.findIndex((m) => m.uuid.slice(0, 24) === prefix)
  }
  return {
    copy: (text) =>
      void setClipboard(text).then((raw) => {
        if (raw) {
          process.stdout.write(raw)
        }
        params.addNotification({
          key: 'selection-copied',
          text: 'copied',
          color: 'success',
          priority: 'immediate',
          timeoutMs: 2000,
        })
      }),
    edit: async (msg) => {
      const rawIdx = findRawIndex(msg.uuid)
      const raw = rawIdx >= 0 ? params.messages[rawIdx] : undefined
      if (!raw || !selectableUserMessagesFilter(raw)) {
        return
      }
      const noFileChanges = !(await fileHistoryHasAnyChanges(params.fileHistory, toUUID(raw.uuid)))
      const onlySynthetic = messagesAfterAreOnlySynthetic(params.messages, rawIdx)
      if (noFileChanges && onlySynthetic) {
        params.onCancel()
        void params.handleRestoreMessage(raw)
      } else {
        params.setMessageSelectorPreselect(raw)
        params.setIsMessageSelectorVisible(true)
      }
    },
  }
}
