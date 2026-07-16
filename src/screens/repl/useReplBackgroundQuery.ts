// Ctrl+B 后台会话启动逻辑。
// 抽自 screens/REPL.tsx 2110-2195。
//
// 流程：
// 1. abort 前台查询（'background' reason）
// 2. 从命令队列取出 task-notification 通知
// 3. 构建 toolUseContext + systemPrompt + userContext + systemContext
// 4. 把 notification messages 去重（避免查询循环已 yield 的重复）
// 5. startBackgroundSession 启动后台会话
//
// 返回 useCallback（deps 同原 REPL）。
// 仅暴露给 useSessionBackgrounding 的 onBackgroundQuery 入参。

import type React from 'react'
import { useCallback } from 'react'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../services/context/context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ProcessUserInputContext } from '../../services/process-user-input/processUserInput.js'
import type { ReplStoreInstance } from '../../state/replStore.js'
import type { ToolPermissionContext } from '../../tool.js'
import { startBackgroundSession } from '../../tasks/localMainSessionTask.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message as MessageType } from '../../types/message.js'
import {
  createAttachmentMessage,
  getQueuedCommandAttachments,
} from '../../services/attachments/attachments.js'
import { removeByFilter } from '../../utils/messageQueueManager.js'
import { getQuerySourceForREPL } from '../../services/analytics/querySource.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'

export type UseReplBackgroundQueryParams = {
  abortController: AbortController | null
  mainLoopModel: string
  toolPermissionContext: ToolPermissionContext
  mainThreadAgentDefinition: AgentDefinition | undefined
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  canUseTool: CanUseToolFn
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  setAppState: React.Dispatch<React.SetStateAction<any>>
  terminalTitle: string
  replStore: ReplStoreInstance
}

export function useReplBackgroundQuery({
  abortController,
  mainLoopModel,
  toolPermissionContext,
  mainThreadAgentDefinition,
  getToolUseContext,
  customSystemPrompt,
  appendSystemPrompt,
  canUseTool,
  setAppState,
  terminalTitle,
  replStore,
}: UseReplBackgroundQueryParams): () => void {
  return useCallback(() => {
    abortController?.abort('background')
    const removedNotifications = removeByFilter((cmd) => cmd.mode === 'task-notification')
    void (async () => {
      const toolUseContext = getToolUseContext(
        replStore.getState().messages,
        [],
        new AbortController(),
        mainLoopModel,
      )
      const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
        getSystemPrompt(
          toolUseContext.options.tools,
          mainLoopModel,
          Array.from(toolPermissionContext.additionalWorkingDirectories.keys()),
          toolUseContext.options.mcpClients,
        ),
        getUserContext(),
        getSystemContext(),
      ])
      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      })
      toolUseContext.renderedSystemPrompt = systemPrompt
      const notificationAttachments = await getQueuedCommandAttachments(removedNotifications).catch(
        () => [],
      )
      const notificationMessages = notificationAttachments.map(createAttachmentMessage)

      const currentMessages = replStore.getState().messages
      const existingPrompts = new Set<string>()
      for (const m of currentMessages) {
        if (m.type !== 'attachment') {
          continue
        }
        const att = m.attachment as { type?: string; commandMode?: string; prompt?: unknown }
        if (
          att.type === 'queued_command' &&
          att.commandMode === 'task-notification' &&
          typeof att.prompt === 'string'
        ) {
          existingPrompts.add(att.prompt)
        }
      }
      const uniqueNotifications = notificationMessages.filter((m) => {
        const att = m.attachment as { type?: string; prompt?: unknown }
        return (
          att.type === 'queued_command' &&
          (typeof att.prompt !== 'string' || !existingPrompts.has(att.prompt))
        )
      })
      startBackgroundSession({
        messages: [...currentMessages, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL(),
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition,
      })
    })()
  }, [
    abortController,
    mainLoopModel,
    toolPermissionContext,
    mainThreadAgentDefinition,
    getToolUseContext,
    customSystemPrompt,
    appendSystemPrompt,
    canUseTool,
    setAppState,
    terminalTitle,
    replStore,
  ])
}
