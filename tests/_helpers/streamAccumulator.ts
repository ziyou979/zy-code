/**
 * 流式累积模拟器：精确复刻 zy.ts L1880~L2080 中流事件 → contentBlocks 的累积逻辑。
 *
 * 这块逻辑没法从 zy.ts 独立 export 出来（埋在 query 函数主循环里、依赖大量 logEvent / feature flag），
 * 所以这里按 1:1 提取核心分支（chunk_start / chunk_delta / chunk_stop / response_delta）。
 *
 * 关键事实（来自 zy.ts）：
 * - chunk_start 的 'tool_use' / 'tool_call' 分支会把 input 强制初始化为 ''（字符串）
 * - chunk_delta 的 'input_json_delta' 分支会做 contentBlock.input += partialJson（字符串拼接）
 * - 所以累积阶段 input 一直是字符串
 * - 真正把字符串 parse 回对象的是 messages.ts 的 normalizeContentFromAPI
 */
import type { LLMStreamEvent } from '../../src/types/llm.js'

/**
 * 累积后的 ContentBlock。字段格式刻意保持与 zy.ts 累积出的 partialMessage.content 一致。
 * tool_call 块的 input 是 string（流式累积阶段的状态），等待 normalizeContentFromAPI 处理。
 */
export type AccumulatedBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_call'; id: string; name: string; input: string }
  | { type: 'tool_use'; id: string; name: string; input: string }

export interface AccumulatedResult {
  responseId: string
  model: string
  contentBlocks: AccumulatedBlock[]
  stopReason: string | null
}

/**
 * 模拟 zy.ts 主循环对流事件的累积处理，返回最终的 contentBlocks。
 *
 * 注意：本模拟器与 zy.ts L1880-L2080 的实际行为保持完全一致，
 * 包括 input 故意以 string 形式初始化和累积。
 */
export async function accumulateStream(
  stream: AsyncIterable<LLMStreamEvent>,
): Promise<AccumulatedResult> {
  const contentBlocks: AccumulatedBlock[] = []
  let responseId = ''
  let model = ''
  let stopReason: string | null = null

  for await (const part of stream) {
    switch (part.type) {
      case 'response_start': {
        responseId = part.responseId
        model = part.model
        break
      }
      case 'chunk_start': {
        const startChunk = (part as any).chunk
        switch (startChunk.type) {
          case 'tool_use':
          case 'tool_call':
            // 与 zy.ts L1924 一致：input 初始化为字符串
            contentBlocks[part.index] = {
              ...startChunk,
              input: '',
            }
            break
          case 'text':
            contentBlocks[part.index] = {
              ...startChunk,
              text: '',
            }
            break
          case 'thinking':
            contentBlocks[part.index] = {
              ...startChunk,
              thinking: '',
              signature: '',
            }
            break
          default:
            contentBlocks[part.index] = { ...startChunk }
            break
        }
        break
      }
      case 'chunk_delta': {
        const block = contentBlocks[part.index]
        if (!block) {
          throw new RangeError(
            `Content block not found at index ${part.index}; existing indices: ${contentBlocks
              .map((b, i) => (b ? i : null))
              .filter((i) => i !== null)
              .join(',')}`,
          )
        }
        const delta = part.delta as any
        switch (delta.type) {
          case 'text_delta':
            if (block.type !== 'text') {
              throw new Error(`text_delta at index ${part.index} but block type is "${block.type}"`)
            }
            block.text += delta.text
            break
          case 'input_json_delta':
            if (block.type !== 'tool_call' && block.type !== 'tool_use') {
              throw new Error(
                `input_json_delta at index ${part.index} but block type is "${block.type}". ` +
                  `(zy.ts would also throw 'Content block is not a input_json block'.)`,
              )
            }
            if (typeof block.input !== 'string') {
              throw new Error(
                `input_json_delta at index ${part.index} but block.input is not string (got ${typeof block.input})`,
              )
            }
            // 与 zy.ts L2024 一致：字符串拼接（标准层使用驼峰 partialJson）
            block.input += delta.partialJson ?? ''
            break
          case 'thinking_delta':
            if (block.type !== 'thinking') {
              throw new Error(
                `thinking_delta at index ${part.index} but block type is "${block.type}"`,
              )
            }
            block.thinking += delta.thinking
            break
          case 'signature_delta':
            if (block.type !== 'thinking') {
              throw new Error(
                `signature_delta at index ${part.index} but block type is "${block.type}"`,
              )
            }
            block.signature = delta.signature
            break
          default:
            // 其他类型忽略
            break
        }
        break
      }
      case 'chunk_stop':
        // zy.ts 此处不做特殊处理，仅作为标记
        break
      case 'response_delta':
        stopReason = part.stopReason as string | null
        break
      case 'response_stop':
        // 流结束
        break
    }
  }

  // 过滤掉数组中的 holes（index 不连续时会产生）
  return {
    responseId,
    model,
    contentBlocks: contentBlocks.filter(Boolean),
    stopReason,
  }
}

/**
 * 把一个事件数组转为 AsyncIterable。
 */
export async function* eventsToStream(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  for (const e of events) {
    yield e
  }
}
