/**
 * E2E 往返测试 —— 直接复现 DashScope 400 错误。
 *
 * 链路：
 * 1. 模拟 OpenAI 流式响应（含 tool_call 分片）
 * 2. mapOpenAIStreamToStandard 把 SDK 事件 → 标准 StreamEvent
 * 3. accumulateStream（模拟 zy.ts L1880-L2080 主循环）累积出 contentBlocks（input 是字符串）
 * 4. normalizeContentFromAPI 应该把字符串 input parse 回对象
 * 5. 用累积出来的 assistant 消息 + 一个 tool 结果，组装下一轮 messages，喂给 messagesToOpenAI
 * 6. 用 SDK 校验器校验 OpenAI 请求体是否合规（tool_call.function.arguments 必须是合法 JSON 对象的字符串）
 *
 * 这条路径就是真实生产链路。任何环节出问题都会被本测试拦截。
 */
import { describe, expect, test } from 'bun:test'
import {
  mapOpenAIStreamToStandard,
  messagesToOpenAI,
} from '../../../src/services/api/conversions/openai.js'
import { normalizeContentFromAPI } from '../../../src/services/messages/normalize.js'
import {
  chunksToStream,
  finishChunk,
  textChunk,
  toolCallArgFragmentChunk,
  toolCallStartChunk,
} from '../../_helpers/openaiStreamFixtures.js'
import { assertValidOpenAIChatMessages } from '../../_helpers/sdkValidators.js'
import { accumulateStream } from '../../_helpers/streamAccumulator.js'

// 给 normalizeContentFromAPI 喂一个空 tools 集合即可（它只会查 findToolByName，找不到就跳过 normalize）
// biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
const EMPTY_TOOLS: any[] = []

describe('E2E: OpenAI 流式 tool_call → 累积 → normalize → 回传请求体', () => {
  test('单个 tool_call，arguments 完整一次到达：往返后请求体合法', async () => {
    // ---- 步骤 1+2：模拟 OpenAI 流，转标准 StreamEvent ----
    const chunks = [
      toolCallStartChunk({
        index: 0,
        id: 'call_001',
        name: 'get_weather',
        argumentsFragment: '{"city":"Hangzhou"}',
      }),
      finishChunk({ finishReason: 'tool_calls', promptTokens: 10, completionTokens: 5 }),
    ]
    const stream = mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus')

    // ---- 步骤 3：累积成 contentBlocks（input 此时是字符串） ----
    const accumulated = await accumulateStream(stream)
    expect(accumulated.contentBlocks).toHaveLength(1)
    const toolBlock = accumulated.contentBlocks[0]!
    expect(toolBlock.type).toBe('tool_call')
    if (toolBlock.type !== 'tool_call') {
      throw new Error('type narrow')
    }
    expect(typeof toolBlock.input).toBe('string')
    expect(toolBlock.input).toBe('{"city":"Hangzhou"}')

    // ---- 步骤 4：normalize 应该把字符串 input parse 回对象 ----
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalized = normalizeContentFromAPI(accumulated.contentBlocks as any, EMPTY_TOOLS as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalizedTool = normalized[0] as any
    // 这是 DashScope 400 的根因关键点：normalize 后必须是 object
    expect(typeof normalizedTool.input).toBe('object')
    expect(normalizedTool.input).toEqual({ city: 'Hangzhou' })

    // ---- 步骤 5+6：用 normalize 后的内容组装下一轮 messages，喂给 messagesToOpenAI ----
    const nextRoundMessages = [
      { role: 'user', content: 'What is the weather in Hangzhou?' },
      { role: 'assistant', content: normalized },
      {
        role: 'tool',
        toolCallId: 'call_001',
        content: 'Sunny, 20°C',
      },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(nextRoundMessages as any)

    // 用 SDK 协议校验器硬验
    assertValidOpenAIChatMessages(openAIMessages)

    // 找到 assistant tool_call，验证 arguments 是合法 JSON 对象的字符串（不是双重转义、不是空、不是 string of string）
    const assistantMsg = openAIMessages.find((m) => m.role === 'assistant')!
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const toolCalls = (assistantMsg as any).tool_calls
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.arguments).toBe('{"city":"Hangzhou"}')
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ city: 'Hangzhou' })
  })

  test('单个 tool_call，arguments 分多片到达：往返后请求体合法', async () => {
    const chunks = [
      toolCallStartChunk({ index: 0, id: 'call_002', name: 'search', argumentsFragment: '' }),
      toolCallArgFragmentChunk({ index: 0, argumentsFragment: '{"q":"' }),
      toolCallArgFragmentChunk({ index: 0, argumentsFragment: 'hello' }),
      toolCallArgFragmentChunk({ index: 0, argumentsFragment: ' world"}' }),
      finishChunk({ finishReason: 'tool_calls' }),
    ]
    const accumulated = await accumulateStream(
      mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus'),
    )
    expect(accumulated.contentBlocks).toHaveLength(1)
    const toolBlock = accumulated.contentBlocks[0]!
    if (toolBlock.type !== 'tool_call') {
      throw new Error('type narrow')
    }
    expect(toolBlock.input).toBe('{"q":"hello world"}')

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalized = normalizeContentFromAPI(accumulated.contentBlocks as any, EMPTY_TOOLS as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((normalized[0] as any).input).toEqual({ q: 'hello world' })

    const next = [
      { role: 'assistant', content: normalized },
      { role: 'tool', toolCallId: 'call_002', content: 'ok' },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(next as any)
    assertValidOpenAIChatMessages(openAIMessages)
  })

  test('text + tool_call 混合：往返后两条消息都合法', async () => {
    const chunks = [
      textChunk('I will check the weather. '),
      toolCallStartChunk({
        index: 0,
        id: 'call_003',
        name: 'get_weather',
        argumentsFragment: '{"city":"Beijing"}',
      }),
      finishChunk({ finishReason: 'tool_calls' }),
    ]
    const accumulated = await accumulateStream(
      mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus'),
    )
    expect(accumulated.contentBlocks).toHaveLength(2)
    expect(accumulated.contentBlocks[0]!.type).toBe('text')
    expect(accumulated.contentBlocks[1]!.type).toBe('tool_call')

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalized = normalizeContentFromAPI(accumulated.contentBlocks as any, EMPTY_TOOLS as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((normalized[1] as any).input).toEqual({ city: 'Beijing' })

    const next = [
      { role: 'assistant', content: normalized },
      { role: 'tool', toolCallId: 'call_003', content: 'cold' },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(next as any)
    assertValidOpenAIChatMessages(openAIMessages)
  })

  test('多个并行 tool_call：每个 arguments 都被正确累积+normalize+回传', async () => {
    const chunks = [
      toolCallStartChunk({
        index: 0,
        id: 'call_a',
        name: 'tool_a',
        argumentsFragment: '{"x":1}',
      }),
      toolCallStartChunk({
        index: 1,
        id: 'call_b',
        name: 'tool_b',
        argumentsFragment: '{"y":2}',
      }),
      finishChunk({ finishReason: 'tool_calls' }),
    ]
    const accumulated = await accumulateStream(
      mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus'),
    )
    expect(accumulated.contentBlocks).toHaveLength(2)

    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalized = normalizeContentFromAPI(accumulated.contentBlocks as any, EMPTY_TOOLS as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((normalized[0] as any).input).toEqual({ x: 1 })
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((normalized[1] as any).input).toEqual({ y: 2 })

    const next = [
      { role: 'assistant', content: normalized },
      { role: 'tool', toolCallId: 'call_a', content: 'a-result' },
      { role: 'tool', toolCallId: 'call_b', content: 'b-result' },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(next as any)
    assertValidOpenAIChatMessages(openAIMessages)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const assistantMsg = openAIMessages.find((m) => m.role === 'assistant')! as any
    expect(assistantMsg.tool_calls).toHaveLength(2)
    expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ x: 1 })
    expect(JSON.parse(assistantMsg.tool_calls[1].function.arguments)).toEqual({ y: 2 })
  })

  test('空 arguments（模型只发了名字没发参数）：normalize 后是 {}，回传后仍是合法 JSON object 字符串', async () => {
    // 这是真实场景：有些模型对零参数工具直接发 ""
    const chunks = [
      toolCallStartChunk({
        index: 0,
        id: 'call_void',
        name: 'noop',
        argumentsFragment: '',
      }),
      finishChunk({ finishReason: 'tool_calls' }),
    ]
    const accumulated = await accumulateStream(
      mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus'),
    )
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const block = accumulated.contentBlocks[0]! as any
    expect(typeof block.input).toBe('string')
    expect(block.input).toBe('')

    // normalize 后应该是 {}（safeParseJSON('') === null → ?? {} → {}）
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const normalized = normalizeContentFromAPI(accumulated.contentBlocks as any, EMPTY_TOOLS as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    expect((normalized[0] as any).input).toEqual({})

    const next = [
      { role: 'assistant', content: normalized },
      { role: 'tool', toolCallId: 'call_void', content: 'done' },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(next as any)
    // 关键断言：arguments 不能是空字符串、不能是 undefined、必须是合法 JSON 对象的字符串
    assertValidOpenAIChatMessages(openAIMessages)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const assistantMsg = openAIMessages.find((m) => m.role === 'assistant')! as any
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{}')
  })

  test('双重防线：即使跳过 normalize，safeStringifyToolArguments 也能兜底成合法 JSON 对象字符串', async () => {
    // 历史：旧路径如果跳过 normalize → input 是字符串 → messagesToOpenAI 做
    // JSON.stringify 产生双重转义 → DashScope 400 拒绝。
    //
    // A2 双重防线：
    //   1) normalizeContentFromAPI 在 chunk_stop 时把字符串 input parse 成 object（主防线）
    //   2) conversions/openai.ts safeStringifyToolArguments 在出站时检测到 input 是合法
    //      JSON 字符串则直接复用而不再 stringify（兜底防线）
    // 这条用例证明即使主防线被绕过，兜底防线仍能让请求体合法。
    const chunks = [
      toolCallStartChunk({
        index: 0,
        id: 'call_skip_normalize',
        name: 'get_weather',
        argumentsFragment: '{"city":"Hangzhou"}',
      }),
      finishChunk({ finishReason: 'tool_calls' }),
    ]
    const accumulated = await accumulateStream(
      mapOpenAIStreamToStandard(chunksToStream(chunks), 'qwen-plus'),
    )
    // 故意跳过 normalize：contentBlocks 中的 input 仍是字符串
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const toolBlock = accumulated.contentBlocks[0] as any
    expect(typeof toolBlock.input).toBe('string')

    const next = [
      { role: 'assistant', content: accumulated.contentBlocks },
      { role: 'tool', toolCallId: 'call_skip_normalize', content: 'sunny' },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const openAIMessages = messagesToOpenAI(next as any)
    // biome-ignore lint/suspicious/noExplicitAny: 测试 mock 对象构造
    const assistantMsg = openAIMessages.find((m) => m.role === 'assistant')! as any
    const argStr = assistantMsg.tool_calls[0].function.arguments
    // 关键：A2 兜底防线起效，arguments 是合法 JSON 对象的字符串，不是双重转义
    expect(argStr).toBe('{"city":"Hangzhou"}')
    const parsed = JSON.parse(argStr)
    expect(typeof parsed).toBe('object')
    expect(parsed).toEqual({ city: 'Hangzhou' })
    // SDK 校验器接受
    assertValidOpenAIChatMessages(openAIMessages)
  })
})
