import { randomUUID } from 'node:crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from '../../services/api/llmOrchestrator.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import { createUserMessage, extractTextContent } from '../messages.js'
import { getDefaultCompactModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from './hookHelpers.js'

/**
 * 使用 LLM 执行基于 prompt 的 hook
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // 使用提供的 toolUseID，如果没有则生成新的
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  try {
    // 将 $ARGUMENTS 替换为 JSON 输入
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(`Hooks: Processing prompt hook with prompt: ${processedPrompt}`)

    // 直接创建用户消息 - 无需使用 processUserInput，
    // 否则会触发 UserPromptSubmit hooks 导致无限递归
    const userMessage = createUserMessage({ content: processedPrompt })

    // 如果提供了会话历史，则将其前置
    const messagesToQuery =
      messages && messages.length > 0 ? [...messages, userMessage] : [userMessage]

    logForDebugging(`Hooks: Querying model with ${messagesToQuery.length} messages`)

    // 使用 Haiku 模型进行查询
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // 组合信号：当 hook 信号或超时任一触发时中止
    const { signal: combinedSignal, cleanup: cleanupSignal } = createCombinedAbortSignal(signal, {
      timeoutMs: hookTimeoutMs,
    })

    try {
      const response = await queryModelWithoutStreaming({
        messages: messagesToQuery,
        systemPrompt: asSystemPrompt([
          `You are evaluating a hook in ZY Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`,
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools: toolUseContext.options.tools,
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model: hook.model ?? getDefaultCompactModel(),
          toolChoice: undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt' as any,
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      })

      cleanupSignal()

      // 从响应中提取文本内容
      const msgContent = Array.isArray(response.message.content) ? response.message.content : []
      const content = extractTextContent(msgContent)

      // 更新响应长度以供加载动画显示
      toolUseContext.setResponseLength((length) => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(`Hooks: error parsing response as JSON: ${fullResponse}`)
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }) as any,
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }) as any,
        }
      }

      // 条件未满足
      if (!parsed.data.ok) {
        logForDebugging(`Hooks: Prompt hook condition was not met: ${parsed.data.reason}`)
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Prompt hook condition was not met: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          preventContinuation: true,
          stopReason: parsed.data.reason,
        }
      }

      // 条件已满足
      logForDebugging(`Hooks: Prompt hook condition was met`)
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }) as any,
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }) as any,
    }
  }
}
