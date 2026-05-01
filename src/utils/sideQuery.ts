import type {
  ToolDefinition,
  LLMResponse,
  LLMMessage,
  TextBlock,
  ToolChoice,
} from '../types/llm.js'

import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getCLISyspromptPrefix,
} from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'

import { getLLMAdapter } from '../services/api/client.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { normalizeModelStringForAPI } from './model/model.js'

// BetaJSONOutputFormat can be inlined as a local type for structured output format
type BetaJSONOutputFormat = { type: 'json_schema'; json_schema?: unknown; schema?: unknown }

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlock block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlock[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: LLMMessage[]
  /** Optional tools (supports both standard ToolDefinition[] for custom tool types) */
  tools?: ToolDefinition[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in zy_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
}


/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<LLMResponse> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  const systemBlocks: TextBlock[] = [
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlock => block !== null)

  let thinkingConfig: { type: 'disabled' } | { type: 'enabled'; budget_tokens: number } | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)
  const start = Date.now()

  // 统一通过 adapter 分派（OpenAI / Anthropic 等 provider 由 adapter 自行处理）
  const adapter = getLLMAdapter()

  // 把 systemBlocks 拼成 system role 消息放在 messages 前面
  const allMessages: LLMMessage[] = []
  if (systemBlocks.length > 0) {
    allMessages.push({
      role: 'system',
      content: systemBlocks.map(b => b.text).join('\n\n'),
    } as any)
  }
  for (const m of messages) allMessages.push(m)

  const response = await adapter.createMessage(
    {
      model: normalizedModel,
      messages: allMessages,
      maxTokens: max_tokens,
      temperature,
      stopSequences: stop_sequences,
      tools: tools as any,
      toolChoice: tool_choice as any,
      providerExtras: {
        anthropic: {
          thinking: thinkingConfig,
          betas: betas.length > 0 ? betas : undefined,
          outputConfig: output_format ? { format: output_format } : undefined,
        },
      },
    },
    signal ?? new AbortController().signal,
  )

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('zy_api_success', {
    requestId:
      response.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    cachedInputTokens: response.usage?.extras?.cacheReadInputTokens ?? 0,
    uncachedInputTokens: response.usage?.extras?.cacheCreationInputTokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}
