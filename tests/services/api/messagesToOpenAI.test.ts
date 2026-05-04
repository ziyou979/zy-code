/**
 * 出站测试：标准 Message[] → OpenAI ChatCompletionMessageParam[]
 * 被测函数：streamAdapter.ts messagesToOpenAI
 *
 * 重点关注：
 * - 4 角色分离消息正确转换
 * - assistant 的 tool_call 块 → OpenAI tool_calls，arguments 必须是合法 JSON 字符串
 * - 兼容 v1 (tool_use) 与 v2 (tool_call) 格式
 * - 兼容 v1 user 消息内嵌 tool_result（拆出独立 tool 消息）
 * - 多模态：image 块 → image_url
 * - 异常 input：非对象/字符串 input 时的行为（这是 DashScope 400 关键防线）
 */
import { describe, test, expect } from 'bun:test'
import { messagesToOpenAI } from '../../../src/services/api/conversions/openai.js'
import { assertValidOpenAIChatMessages } from '../../_helpers/sdkValidators.js'

describe('messagesToOpenAI: 出站 OpenAI 请求构造', () => {
  test('纯 system + user 文本：原样转换', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]
    const result = messagesToOpenAI(messages as any)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(result[1]).toEqual({ role: 'user', content: 'Hi' })
    assertValidOpenAIChatMessages(result)
  })

  test('user 消息为字符串和数组形式，处理一致', () => {
    const r1 = messagesToOpenAI([{ role: 'user', content: 'hi' }] as any)
    const r2 = messagesToOpenAI([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as any)
    expect(r1[0]).toEqual({ role: 'user', content: 'hi' })
    expect(r2[0]).toEqual({ role: 'user', content: 'hi' })
  })

  test('assistant 含 tool_call (v2)：input 是 object，arguments 是合法 JSON 字符串', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'search',
            input: { query: 'hello' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'result' },
    ]
    const result = messagesToOpenAI(messages as any)
    assertValidOpenAIChatMessages(result)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.content).toBe('Let me check.')
    expect(a.tool_calls).toHaveLength(1)
    expect(a.tool_calls[0].function.arguments).toBe('{"query":"hello"}')
    expect(JSON.parse(a.tool_calls[0].function.arguments)).toEqual({ query: 'hello' })
  })

  test('assistant 含 tool_use (v1 旧字段名)：A2 重构后双识别 tool_call/tool_use，正确转出', () => {
    // 历史：旧 streamAdapter L386 有 `block.type === 'tool_call' || block.type === 'tool_call'`
    // 重复判断 bug，导致 v1 'tool_use' 被忽略。A2 conversions/openai.ts 已修复为
    // `block.type === 'tool_call' || block.type === 'tool_use'`，两种历史格式都能识别。
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_v1',
            name: 'search',
            input: { q: 'hi' },
          },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.tool_calls).toHaveLength(1)
    expect(a.tool_calls[0].id).toBe('call_v1')
    expect(a.tool_calls[0].function.name).toBe('search')
    expect(JSON.parse(a.tool_calls[0].function.arguments)).toEqual({ q: 'hi' })
    assertValidOpenAIChatMessages(result)
  })

  test('assistant 多个 tool_call：所有 arguments 都是合法 JSON', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'a', name: 'fa', input: { x: 1 } },
          { type: 'tool_call', id: 'b', name: 'fb', input: { y: 'two' } },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: 'ra' },
      { role: 'tool', toolCallId: 'b', content: 'rb' },
    ]
    const result = messagesToOpenAI(messages as any)
    assertValidOpenAIChatMessages(result)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.tool_calls).toHaveLength(2)
    expect(JSON.parse(a.tool_calls[0].function.arguments)).toEqual({ x: 1 })
    expect(JSON.parse(a.tool_calls[1].function.arguments)).toEqual({ y: 'two' })
  })

  test('assistant tool_call 的 input 缺失：默认 {}', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'noop' }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.tool_calls[0].function.arguments).toBe('{}')
  })

  test('CRITICAL 防线：input 是合法 JSON 字符串时，safeStringifyToolArguments 直接复用，不再双重 stringify', () => {
    // 历史：旧实现 JSON.stringify(string) 产生双重转义触发 DashScope 400。
    // A2 防线：conversions/openai.ts 的 safeStringifyToolArguments 检测到入参已是
    // 合法 JSON 字符串时，直接原样使用；input 仍是字符串只是因为流式累积阶段未及时
    // normalize（虽然已不会引起 400，但仍建议在 normalizeContentFromAPI 中转 object）。
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'c1',
            name: 'search',
            input: '{"q":"hi"}', // ← 字符串形态（流式累积未 normalize）
          },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const a = result.find((m) => m.role === 'assistant') as any
    const argStr = a.tool_calls[0].function.arguments
    // 关键：A2 重构后 arguments 是合法 JSON 对象的字符串，不再双重转义
    expect(argStr).toBe('{"q":"hi"}')
    const parsed = JSON.parse(argStr)
    expect(typeof parsed).toBe('object')
    expect(parsed).toEqual({ q: 'hi' })
    // SDK 校验器接受
    assertValidOpenAIChatMessages(result)
  })

  test('防线兜底：input 是非法 JSON 字符串时，被包装成 {raw: "..."} 而不是产生双重转义', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'c2',
            name: 'noop',
            input: 'not a json at all',
          },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const a = result.find((m) => m.role === 'assistant') as any
    const parsed = JSON.parse(a.tool_calls[0].function.arguments)
    expect(parsed).toEqual({ raw: 'not a json at all' })
    assertValidOpenAIChatMessages(result)
  })

  test('v1 user 消息内嵌 tool_result：被拆成独立 role:tool 消息', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'call_x',
            content: 'tool output',
          },
          { type: 'text', text: 'And here is more user input.' },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_x',
      content: 'tool output',
    })
    expect(result[1]).toEqual({
      role: 'user',
      content: 'And here is more user input.',
    })
  })

  test('user 消息含图片：平铺 ImageBlock 转 image_url', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', mimeType: 'image/png', data: 'AAA' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/jpeg', data: 'BBB' }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const u1 = result[0] as any
    const u2 = result[1] as any
    expect(u1.content).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
    expect(u2.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    ])
  })

  test('DeepSeek + tool_call + 具备 thinking 能力：走 reasoning_content 独立字段', async () => {
    // DeepSeek 协议：两轮之间有 tool_call 时必须回传 reasoning_content
    // 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/settings/localModelCapabilities.js', () => ({
      localModelHasCapability: (model: string, cap: string) =>
        model.toLowerCase().includes('deepseek') && cap === 'thinking',
    }))
    const { messagesToOpenAI: fn } = await import('../../../src/services/api/conversions/openai.js')
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning here', signature: 'sig' },
          { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } },
        ],
      },
    ]
    const result = fn(messages as any, 'deepseek-reasoner')
    const a = result[0] as any
    expect(a.reasoning_content).toBe('reasoning here')
    expect(a.content).toBeUndefined()
    expect(a.tool_calls).toHaveLength(1)
    mock.restore()
  })

  test('DeepSeek + 纯文本轮次：thinking 被丢弃', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/settings/localModelCapabilities.js', () => ({
      localModelHasCapability: (model: string, cap: string) =>
        model.toLowerCase().includes('deepseek') && cap === 'thinking',
    }))
    const { messagesToOpenAI: fn } = await import('../../../src/services/api/conversions/openai.js')
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning here', signature: 'sig' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ]
    const result = fn(messages as any, 'deepseek-reasoner')
    const a = result[0] as any
    expect(a.content).toBe('final answer')
    expect(a.reasoning_content).toBeUndefined()
    mock.restore()
  })

  test('DeepSeek 但不具备 thinking 能力（model-capabilities 未声明）：走普通 <thinking> 兜底', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/settings/localModelCapabilities.js', () => ({
      localModelHasCapability: () => false, // 未声明 thinking 能力
    }))
    const { messagesToOpenAI: fn } = await import('../../../src/services/api/conversions/openai.js')
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 'sig' },
          { type: 'tool_call', id: 'c1', name: 'n', input: {} },
        ],
      },
    ]
    const result = fn(messages as any, 'deepseek-chat')
    const a = result[0] as any
    // 没声明 thinking 能力 → 按非 DeepSeek 处理，<thinking> 入 content
    expect(a.content).toBe('<thinking>r</thinking>')
    expect(a.reasoning_content).toBeUndefined()
    mock.restore()
  })

  test('非 DeepSeek 模型：thinking 包成 <thinking>...</thinking> 并入 content', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning here', signature: 'sig' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any, 'qwen-plus')
    const a = result[0] as any
    expect(a.content).toBe('<thinking>reasoning here</thinking>\n\nfinal answer')
    expect(a.reasoning_content).toBeUndefined()
  })

  test('未传 model 参数：按非 DeepSeek 处理（保守 fallback）', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r', signature: 'sig' },
          { type: 'text', text: 'ans' },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const a = result[0] as any
    expect(a.content).toBe('<thinking>r</thinking>\n\nans')
  })

  test('完整多轮：user → assistant(tool_call) → tool → assistant(text)', () => {
    const messages = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c', name: 'w', input: { city: 'BJ' } }],
      },
      { role: 'tool', toolCallId: 'c', content: 'cold' },
      { role: 'assistant', content: 'It is cold in BJ.' },
    ]
    const result = messagesToOpenAI(messages as any)
    assertValidOpenAIChatMessages(result)
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  test('tool 消息 content 为空：兜底为 (empty)', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'n', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: '' },
    ]
    const result = messagesToOpenAI(messages as any)
    const t = result.find((m) => m.role === 'tool') as any
    expect(t.content).toBe('(empty)')
  })

  test('user content 非 string 非 array（如数字）：兜底为空', () => {
    const result = messagesToOpenAI([{ role: 'user', content: 123 }] as any)
    expect(result[0].content).toBe('')
  })

  test('user content 数组全为未知 block 类型：无 text/image/tool_result，推送空 user', () => {
    const result = messagesToOpenAI([
      {
        role: 'user',
        content: [{ type: 'unknown_block', foo: 'bar' }],
      },
    ] as any)
    expect(result[0].content).toBe('')
  })

  test('tool_result content 是数组（多 text block）：拼接为字符串', () => {
    const result = messagesToOpenAI([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c', name: 'f', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    ] as any)
    const toolMsg = result.find((m) => m.role === 'tool') as any
    expect(toolMsg.content).toBe('line1\nline2')
  })

  test('assistant string content + toolCalls 独立字段：text + tool_calls 共存', () => {
    const result = messagesToOpenAI([
      {
        role: 'assistant',
        content: 'Let me search',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"hi"}' }],
      },
    ] as any)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.content).toBe('Let me search')
    expect(a.tool_calls).toHaveLength(1)
    expect(a.tool_calls[0].function.arguments).toBe('{"q":"hi"}')
  })

  test('assistant content 为 array 无 tool_call，但 msg.toolCalls 独立字段存在 → 走 fallback', () => {
    const result = messagesToOpenAI([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{}' }],
      },
    ] as any)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.content).toBe('answer')
    expect(a.tool_calls).toHaveLength(1)
  })

  test('user content 为非 object（如 null）：兜底为空', () => {
    const result = messagesToOpenAI([{ role: 'user', content: null }] as any)
    expect(result[0].content).toBe('')
  })
})
