/**
 * OpenAI 流式响应 fixtures：构造各种典型/边缘场景的 ChatCompletionChunk 序列。
 *
 * 用于喂给 mapOpenAIStreamToStandard 测试其 chunk_start / chunk_delta 输出是否合规。
 */
import type OpenAI from 'openai'

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk

/** 构造一条只含 content delta 的 chunk */
export function textChunk(content: string, model = 'gpt-4'): Chunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}

/** 构造一条带 reasoning_content 的 chunk（DashScope 等百炼平台） */
export function reasoningChunk(reasoning: string, model = 'qwen-plus'): Chunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: { reasoning_content: reasoning } as any, finish_reason: null }],
  }
}

/** 构造一条 tool_call 起始 chunk（含 id/name，arguments 可选） */
export function toolCallStartChunk(args: {
  index: number
  id: string
  name: string
  argumentsFragment?: string
  model?: string
}): Chunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: args.model ?? 'gpt-4',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: args.index,
              id: args.id,
              type: 'function',
              function: {
                name: args.name,
                arguments: args.argumentsFragment ?? '',
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }
}

/** 构造一条 tool_call arguments 增量 chunk（无 id/name） */
export function toolCallArgFragmentChunk(args: {
  index: number
  argumentsFragment: string
  model?: string
}): Chunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: args.model ?? 'gpt-4',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: args.index,
              function: { arguments: args.argumentsFragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }
}

/** 构造结束 chunk（含 finish_reason 和可选 usage） */
export function finishChunk(args: {
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  promptTokens?: number
  completionTokens?: number
  model?: string
}): Chunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: args.model ?? 'gpt-4',
    choices: [{ index: 0, delta: {}, finish_reason: args.finishReason }],
    usage:
      args.promptTokens !== undefined
        ? {
            prompt_tokens: args.promptTokens,
            completion_tokens: args.completionTokens ?? 0,
            total_tokens: args.promptTokens + (args.completionTokens ?? 0),
          }
        : undefined,
  }
}

/** 把一组 chunks 转成 AsyncIterable */
export async function* chunksToStream(chunks: Chunk[]): AsyncIterable<Chunk> {
  for (const c of chunks) {
    yield c
  }
}
