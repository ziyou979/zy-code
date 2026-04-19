import type { Anthropic } from '@anthropic-ai/sdk'
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
// 动态导入的最小值，用于计数令牌的 Bedrock 调用
// 延迟约 ~279KB 的 AWS SDK 代码，直到实际需要 Bedrock 调用
import type { CountTokensCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { getAPIProvider, isOpenAIFormatProvider, isNativeOpenAIProvider } from 'src/utils/model/providers.js'
import { openAICreateMessage } from './api/openaiQuery.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { getVertexRegionForModel, isEnvTruthy } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getSmallFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAPIMetadata, getExtraBodyParams } from './api/zy.js'
import { getLLMClient } from './api/client.js'
import { withTokenCountVCR } from './vcr.js'

// 启用思考时的令牌计数最小值
// API 约束：max_tokens 必须大于 thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * 检查消息是否包含思考块
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 在发送进行令牌计数之前，从消息中剥离 tool search 专用字段。
 * 这会从 tool_use 块中移除 'caller'，从 tool_result 内容中移除 'tool_reference'。
 * 这些字段仅在使用 tool search beta 时有效，否则会导致错误。
 *
 * 注意：我们使用 'as unknown as' 转换，因为 SDK 类型不包含 tool search beta 字段，
 * 但在启用 tool search 时，这些字段可能在运行时从 API 响应中存在。
 */
function stripToolSearchFieldsFromMessages(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // 从 tool_use 块中剥离 'caller'（助手消息）
      if (block.type === 'tool_use') {
        // 解构以排除 'caller' 等额外字段
        const toolUse =
          block as Anthropic.Beta.Messages.BetaToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // 从 tool_result 内容中剥离 tool_reference 块（用户消息）
      if (block.type === 'tool_result') {
        const toolResult =
          block as Anthropic.Beta.Messages.BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // 空内容的特殊情况 — API 不接受空消息
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

export async function countMessagesTokensWithAPI(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = hasThinkingBlocks(messages)

      if (getAPIProvider() === 'bedrock') {
        // @anthropic-sdk/bedrock-sdk doesn't support countTokens currently
        return countTokensWithBedrock({
          model: normalizeModelStringForAPI(model),
          messages,
          tools,
          betas,
          containsThinking,
        })
      }

      const anthropic = await getLLMClient({
        maxRetries: 1,
        model,
        source: 'count_tokens',
      })

      const apiProvider = getAPIProvider()
      const useOpenAIFormat = isOpenAIFormatProvider(apiProvider)
      const filteredBetas =
        apiProvider === 'vertex'
          ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : useOpenAIFormat
            ? [] // OpenAI 兼容格式不支持 betas
            : betas

      // OpenAI 兼容格式不支持 beta API，使用标准 API
      const countTokensFn = useOpenAIFormat
        ? anthropic.messages.countTokens.bind(anthropic.messages)
        : anthropic.beta.messages.countTokens.bind(anthropic.beta.messages)

      const response = await countTokensFn({
        model: normalizeModelStringForAPI(model),
        messages:
          // When we pass tools and no messages, we need to pass a dummy message
          // to get an accurate tool token count.
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(filteredBetas.length > 0 && { betas: filteredBetas }),
        // OpenAI 兼容格式不支持 thinking 参数
        ...(!useOpenAIFormat && containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        // Vertex 客户端抛出异常
        // Bedrock 客户端成功返回 { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * 返回给定文件扩展名的估计字节/令牌比率。
 * 密集的 JSON 有许多单字符令牌（`{`、`}`、`:`、`,`、`"`）
 * 这使得实际比率更接近 2 而不是默认的 4。
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * 类似于 {@link roughTokenCountEstimation}，但在已知文件类型时使用更准确的
 * 字节/令牌比率。
 *
 * 这在基于 API 的令牌计数不可用时很重要（例如在
 * Bedrock 上），我们回退到粗略估计 — 低估可能会让
 * 过大的工具结果溜进对话中。
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * 通过提取和分析其文本内容来估计 Message 对象的令牌计数。
 * 这比 getTokenUsage 对可能已被压缩的消息提供更可靠的估计。
 * 使用 Haiku 进行令牌计数（Haiku 4.5 支持思考块），除了：
 * - Vertex 全局区域：使用 Sonnet（Haiku 不可用）
 * - 带思考块的 Bedrock：使用 Sonnet（Haiku 3.5 不支持思考）
 */
export async function countTokensViaHaikuFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  // 检查消息是否包含思考块
  const containsThinking = hasThinkingBlocks(messages)

  // 如果我们在 Vertex 上并且使用全局区域，始终使用 Sonnet，因为 Haiku 在那里不可用。
  const isVertexGlobalEndpoint =
    isEnvTruthy(process.env.ZY_CODE_USE_VERTEX) &&
    getVertexRegionForModel(getSmallFastModel()) === 'global'
  // 如果我们在带思考块的 Bedrock 上，使用 Sonnet，因为 Haiku 3.5 不支持思考
  const isBedrockWithThinking =
    isEnvTruthy(process.env.ZY_CODE_USE_BEDROCK) && containsThinking
  // 如果我们在带思考块的 Vertex 上，使用 Sonnet，因为 Haiku 3.5 不支持思考
  const isVertexWithThinking =
    isEnvTruthy(process.env.ZY_CODE_USE_VERTEX) && containsThinking
  // 否则始终使用 Haiku — Haiku 4.5 支持思考块。
  // 警告：如果你将此更改为非 Haiku 模型，此请求将在直接 API 中失败，除非它使用 getCLISyspromptPrefix。
  // 注意：我们不需要 Sonnet 来处理 tool_reference 块，因为我们通过
  // stripToolSearchFieldsFromMessages() 在发送之前剥离它们。
  // 使用 getSmallFastModel() 以尊重 ANTHROPIC_SMALL_FAST_MODEL 环境变量，供具有全局推理配置文件的 Bedrock 用户使用
  // （参见 issue #10883）。
  const model =
    isVertexGlobalEndpoint || isBedrockWithThinking || isVertexWithThinking
      ? getDefaultSonnetModel()
      : getSmallFastModel()
  const anthropic = await getLLMClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })

  // 在发送之前剥离 tool search 专用字段（caller、tool_reference）
  // 这些字段仅在带有 tool search beta 头时有效
  const normalizedMessages = stripToolSearchFieldsFromMessages(messages)

  const messagesToSend: MessageParam[] =
    normalizedMessages.length > 0
      ? (normalizedMessages as MessageParam[])
      : [{ role: 'user', content: 'count' }]

  const betas = getModelBetas(model)
  const apiProvider = getAPIProvider()
  const useOpenAIFormat = isOpenAIFormatProvider(apiProvider)

  // OpenAI 专用路径
  if (isNativeOpenAIProvider(apiProvider)) {
    const response = await openAICreateMessage({
      model: normalizeModelStringForAPI(model),
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      messages: messagesToSend,
      tools: tools.length > 0 ? tools as any : undefined,
      signal: undefined,
    })
    const usage = response.usage
    const inputTokens = usage?.input_tokens ?? 0
    return inputTokens
  }

  // 为 Vertex 过滤 betas — 某些 betas（如 web-search）在某些
  // Vertex 端点上会导致 400 错误。参见 issue #10789。
  const filteredBetas =
    apiProvider === 'vertex'
      ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
      : useOpenAIFormat
        ? [] // OpenAI 兼容格式不支持 betas
        : betas

  // OpenAI 兼容格式不支持 beta API，使用标准 API
  const createMessageFn = useOpenAIFormat
    ? anthropic.messages.create.bind(anthropic.messages)
    : anthropic.beta.messages.create.bind(anthropic.beta.messages)

  // biome-ignore lint/plugin: 令牌计数需要 sideQuery 不支持的专用参数（thinking、betas）
  const response = await createMessageFn({
    model: normalizeModelStringForAPI(model),
    max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
    messages: messagesToSend,
    tools: tools.length > 0 ? tools : undefined,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    metadata: getAPIMetadata(),
    ...getExtraBodyParams(),
    // OpenAI 兼容格式不支持 thinking 参数
    ...(!useOpenAIFormat && containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })

  const usage = response.usage
  const inputTokens = usage.input_tokens
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0
  const cacheReadTokens = usage.cache_read_input_tokens || 0

  return inputTokens + cacheCreationTokens + cacheReadTokens
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.zy.com/docs/en/build-with-zy/vision#calculate-image-costs
    // 令牌 = (宽 px * 高 px)/750
    // 图像被调整为最大 2000x2000（5333 令牌）。使用保守
    // 估计以匹配 microCompact 的 IMAGE_MAX_TOKEN_SIZE，避免
    // 低估并过晚触发自动压缩。
    //
    // document：源中的 base64 PDF。绝不能到达
    // jsonStringify 的 catch-all — 1MB PDF 约 ~1.33M base64 字符 →
    // ~325k 估计令牌，而 API 实际收取约 ~2000。
    // 与 microCompact 的 calculateToolResultTokens 相同的常量。
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_use') {
    // input 是模型生成的 JSON — 任意大小（bash
    // 命令、Edit 差异、文件内容）。字符串化一次以获取
    // 字符计数；API 无论如何都会重新序列化，所以这就是它看到的。
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use、web_search_tool_result 等 —
  // 类文本有效负载（工具输入、搜索结果、无 base64）。
  // 字符串长度跟踪 API 看到的序列化形式；
  // 键/括号开销在实际块上是个位数百分比。
  return roughTokenCountEstimation(jsonStringify(block))
}

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens 需要模型 ID，而不是推理配置文件 / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // 当我们传递工具且没有消息时，我们需要传递一个虚拟消息
      // 以获得准确的工具令牌计数。
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const { CountTokensCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )
    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
