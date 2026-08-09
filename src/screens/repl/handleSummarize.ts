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
import { getSystemContext, getUserContext } from '../../services/context/context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import {
  partialCompactConversation,
  stripStaleUsageFromMessages,
} from '../../services/compact/compact.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type {
  Message as MessageType,
  PartialCompactDirection,
  UserMessage,
} from '../../types/message.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { createSystemMessage } from '../../services/messages/./constructors.js'
import { textForResubmit } from '../../services/messages/./predicates.js'
import { getHotContextMessages } from '../../services/messages/projections.js'
import { buildEffectiveSystemPrompt } from '../../services/messages/systemPrompt.js'

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
  direction = 'from',
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
  const compactMessages = getHotContextMessages(messages)
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
    Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()),
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

  const kept = stripStaleUsageFromMessages(result.messagesToKeep ?? [])
  const ordered =
    direction === 'up_to'
      ? [...result.summaryMessages, ...kept]
      : [...kept, ...result.summaryMessages]
  const postCompact = [
    result.boundaryMarker,
    ...ordered,
    ...result.attachments,
    ...result.hookResults,
  ]

  // 冷热分离：始终保留冷历史供 UI/resume 上翻（与 fullscreen 对齐）。
  // 非 fullscreen 不再整表替换为仅 hot——resume 时原生 scrollback 为空。
  if (direction === 'from') {
    // pivot 之前保留；pivot 起用热上下文替换
    setMessages((old) => {
      const rawIdx = old.findIndex((m) => m.uuid === message.uuid)
      const cold = old.slice(0, rawIdx === -1 ? 0 : rawIdx)
      const coldDeduped = cold.filter((m) => !postCompact.some((n) => n.uuid === m.uuid))
      return [...coldDeduped, ...postCompact]
    })
  } else {
    // up_to 等：展示层保留未纳入 hot 的更早消息
    setMessages((old) => {
      const cold = old.filter((m) => !postCompact.some((n) => n.uuid === m.uuid))
      return [...cold, ...postCompact]
    })
  }

  if (feature('PROACTIVE') || feature('KAIROS')) {
    proactiveModule?.setContextBlocked(false)
  }
  regenerateConversationId()
  runPostCompactCleanup(context.options.querySource)

  if (direction === 'from') {
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
