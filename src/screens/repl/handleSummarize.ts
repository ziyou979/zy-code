// MessageSelector 的 onSummarize 纯函数抽取。
// 抽自 screens/REPL.tsx 5087-5203 的 116 行内联 async callback。
//
// 流程：
// 1. 投影 compact 边界后的消息，定位目标 message 的 index
// 2. 构建 toolUseContext + systemPrompt
// 3. partialCompactConversation 执行局部摘要
// 4. 组装 postCompact 消息数组，fullscreen 保留回滚历史
// 5. 清 proactive context-blocked 标志 + regenerate conversationId
// 6. 'from' 方向时把原消息文本回填到输入框
// 7. 显示"已摘要"通知

import { feature } from 'bun:bundle'
import { proactiveModule } from '../../cli/lazyModules.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import type { Notification } from '../../context/notifications.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { partialCompactConversation } from '../../services/compact/compact.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type {
  Message as MessageType,
  PartialCompactDirection,
  UserMessage,
} from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import {
  createSystemMessage,
  getMessagesAfterCompactBoundary,
  textForResubmit,
} from '../../services/messages/index.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'

export type HandleSummarizeParams = {
  message: UserMessage
  feedback?: string
  direction?: PartialCompactDirection
  messages: MessageType[]
  createAbortController: () => AbortController
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  mainLoopModel: string
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  regenerateConversationId: () => void
  setInputValue: (value: string) => void
  setInputMode: (v: PromptInputMode) => void
  addNotification: (n: Notification) => void
}

export async function handleSummarize({
  message,
  feedback,
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  direction = 'from' as any,
  messages,
  createAbortController,
  getToolUseContext,
  mainLoopModel,
  setMessages,
  regenerateConversationId,
  setInputValue,
  setInputMode,
  addNotification,
}: HandleSummarizeParams): Promise<void> {
  const compactMessages = getMessagesAfterCompactBoundary(messages)
  const messageIndex = compactMessages.indexOf(message)
  if (messageIndex === -1) {
    setMessages((prev) => [
      ...prev,
      createSystemMessage(
        'That message is no longer in the active context (pre-compact). Choose a more recent message.',
        'warn',
      ),
    ])
    return
  }

  const newAbortController = createAbortController()
  const context = getToolUseContext(compactMessages, [], newAbortController, mainLoopModel)
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    Array.from((appState.toolPermissionContext as any).additionalWorkingDirectories.keys()),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()])
  const result = await partialCompactConversation(
    compactMessages,
    messageIndex,
    context,
    {
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext: context,
      forkContextMessages: compactMessages,
    },
    feedback,
    direction,
  )

  const kept = result.messagesToKeep ?? []
  const ordered =
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    (direction as any) === 'up_to'
      ? [...result.summaryMessages, ...kept]
      : [...kept, ...result.summaryMessages]
  const postCompact = [
    result.boundaryMarker,
    ...ordered,
    ...result.attachments,
    ...result.hookResults,
  ]

  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  if (isFullscreenEnvEnabled() && (direction as any) === 'from') {
    setMessages((old) => {
      const rawIdx = old.findIndex((m) => m.uuid === message.uuid)
      return [...old.slice(0, rawIdx === -1 ? 0 : rawIdx), ...postCompact]
    })
  } else {
    setMessages(postCompact)
  }

  if (feature('PROACTIVE') || feature('KAIROS')) {
    proactiveModule?.setContextBlocked(false)
  }
  regenerateConversationId()
  runPostCompactCleanup(context.options.querySource)

  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  if ((direction as any) === 'from') {
    const r = textForResubmit(message)
    if (r) {
      setInputValue(r.text)
      setInputMode(r.mode)
    }
  }

  const historyShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  addNotification({
    key: 'summarize-ctrl-o-hint',
    text: `Conversation summarized (${historyShortcut} for history)`,
    priority: 'medium',
    timeoutMs: 8000,
  })
}
