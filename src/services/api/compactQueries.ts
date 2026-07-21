// @ts-nocheck

import { getDefaultCompactModel } from '../model/model.js'
import { getEmptyToolPermissionContext } from '../../tools/tool.js'
import type { JSONOutputFormat } from '../../types/llm.js'
import type { AssistantMessage } from '../../types/message.js'
import { createUserMessage } from '../messages/constructors.js'
import { asSystemPrompt, type SystemPrompt } from '../api/systemPromptType.js'
import { withVCR } from '../vcr.js'
import { type Options, queryModelWithoutStreaming } from './llmOrchestrator.js'

type CompactModelOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/**
 * 使用 compact 能力层级的模型进行非流式查询。
 * 适用于轻量级任务：标题生成、摘要、日期解析等。
 */
export async function queryCompactModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: JSONOutputFormat
  signal: AbortSignal
  options: CompactModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map((text) => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getDefaultCompactModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // compact 模型不使用流式，所以这里是安全的
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 ZY Code 基础设施查询特定模型。
 * 这会经过完整的查询流水线，包括正确的认证、
 * beta 功能和请求头 — 与直接 API 调用不同。
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: JSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map((text) => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}
