import { tSync } from '../../i18n/index.js'
import type { ContentBlock, ToolResultBlock } from '../../types/llm.js'
import { LLMError } from '../../types/llm.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import {
  getLocalModelInputModalities,
  type ModelInputModality,
} from '../settings/localModelCapabilities.js'

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function collectBlockModalities(block: ContentBlock, modalities: Set<ModelInputModality>): void {
  if (block.type === 'image' || block.type === 'document') {
    modalities.add(block.type)
    return
  }
  if (!isToolResult(block) || !Array.isArray(block.content)) {
    return
  }
  for (const nested of block.content) {
    if (nested.type === 'image') {
      modalities.add('image')
    }
  }
}

/** 收集请求历史中实际出现的非文本输入模态，包括工具结果内嵌图片。 */
export function getMessageMediaInputModalities(
  messages: (UserMessage | AssistantMessage)[],
): ModelInputModality[] {
  const modalities = new Set<ModelInputModality>()
  for (const message of messages) {
    const content = message.message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      collectBlockModalities(block, modalities)
    }
  }
  return [...modalities]
}

function formatModality(modality: ModelInputModality): string {
  return tSync(`modelInput.modality.${modality}`)
}

/**
 * 在请求发出前校验模型输入能力。
 * 未声明 input 时不拦截，避免升级后把既有模型误判成纯文本模型。
 */
export function assertModelAcceptsMessageInput(
  model: string,
  messages: (UserMessage | AssistantMessage)[],
): void {
  const supported = getLocalModelInputModalities(model)
  assertMessageInputModalities(model, messages, supported)
}

/** 使用已解析的能力声明校验输入，便于编排层复用和无全局状态测试。 */
export function assertMessageInputModalities(
  model: string,
  messages: (UserMessage | AssistantMessage)[],
  supported: readonly ModelInputModality[] | undefined,
): void {
  if (!supported) {
    return
  }

  const unsupported = getMessageMediaInputModalities(messages).filter(
    (modality) => !supported.includes(modality),
  )
  if (unsupported.length === 0) {
    return
  }

  throw new LLMError(
    tSync('modelInput.unsupported', {
      model,
      unsupported: unsupported.map(formatModality).join(', '),
      supported: supported.map(formatModality).join(', '),
    }),
    400,
  )
}
