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

import { useCallback } from 'react'
import type React from 'react'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { ProcessUserInputContext } from '../../services/processUserInput/processUserInput.js'
import { startBackgroundSession } from '../../tasks/LocalMainSessionTask.js'
import type { Message as MessageType } from '../../types/message.js'
import { createAttachmentMessage, getQueuedCommandAttachments } from '../../utils/attachments.js'
import { removeByFilter } from '../../utils/messageQueueManager.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ToolPermissionContext } from '../../Tool.js'

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
  canUseTool: (...args: any[]) => Promise<unknown>
  setAppState: React.Dispatch<React.SetStateAction<any>>
  terminalTitle: string
  messagesRef: React.RefObject<MessageType[]>
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
  messagesRef,
}: UseReplBackgroundQueryParams): () => void {
  return useCallback(() => {
    abortController?.abort('background')
    const removedNotifications = removeByFilter((cmd) => cmd.mode === 'task-notification')
    void (async () => {
      const toolUseContext = getToolUseContext(
        messagesRef.current,
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

      // 去重：查询循环可能已把同一通知 yield 到 messagesRef
      const existingPrompts = new Set<string>()
      for (const m of messagesRef.current) {
        if (
          m.type === 'attachment' &&
          (m.attachment as any).type === 'queued_command' &&
          (m.attachment as any).commandMode === 'task-notification' &&
          typeof (m.attachment as any).prompt === 'string'
        ) {
          existingPrompts.add((m.attachment as any).prompt)
        }
      }
      const uniqueNotifications = notificationMessages.filter(
        (m) =>
          (m.attachment as any).type === 'queued_command' &&
          (typeof (m.attachment as any).prompt !== 'string' ||
            !existingPrompts.has((m.attachment as any).prompt)),
      )
      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool: canUseTool as any,
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
    messagesRef,
  ])
}
