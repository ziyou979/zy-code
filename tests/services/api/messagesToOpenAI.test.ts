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
import { describe, expect, test } from 'bun:test'
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
    // 必须同时 mock provider 为非 REASONING_CONTENT_PROVIDERS，否则 provider 级判断会短路
    mock.module('../../../src/services/model/providers.js', () => ({
      getAPIProvider: () => 'generic',
    }))
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

  test('非 reasoning provider 的模型：thinking 包成 <thinking>...</thinking> 并入 content', async () => {
    const { mock } = await import('bun:test')
    // 确保 provider 不在 REASONING_CONTENT_PROVIDERS 中
    mock.module('../../../src/services/model/providers.js', () => ({
      getAPIProvider: () => 'generic',
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
    const result = fn(messages as any, 'qwen-plus')
    const a = result[0] as any
    expect(a.content).toBe('<thinking>reasoning here</thinking>\n\nfinal answer')
    expect(a.reasoning_content).toBeUndefined()
    mock.restore()
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

  test('assistant string content + toolCalls 独立字段：string 分支不处理 toolCalls', () => {
    const result = messagesToOpenAI([
      {
        role: 'assistant',
        content: 'Let me search',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"hi"}' }],
      },
    ] as any)
    const a = result.find((m) => m.role === 'assistant') as any
    expect(a.content).toBe('Let me search')
    expect(a.tool_calls).toBeUndefined()
  })

  test('user content 为非 object（如 null）：兜底为空', () => {
    const result = messagesToOpenAI([{ role: 'user', content: null }] as any)
    expect(result[0].content).toBe('')
  })

  test('user 单 text block 带 cache_control：保留 array 形式而非压扁成 string', () => {
    // 回归：addCacheBreakpoints 给最后一条 user 消息打的 marker 必须能透出到
    // 百炼/火山等 OpenAI 兼容端点；否则单 text block 被三元运算符压扁成纯
    // string 时 cache_control 会被静默丢弃。
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    expect(result).toHaveLength(1)
    const m = result[0] as any
    expect(m.role).toBe('user')
    expect(Array.isArray(m.content)).toBe(true)
    expect(m.content).toHaveLength(1)
    expect(m.content[0]).toEqual({
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral' },
    })
    assertValidOpenAIChatMessages(result)
  })

  test('user 单 text block 不带 cache_control：仍压扁成 string（保持原行为）', () => {
    const result = messagesToOpenAI([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ] as any)
    expect(result[0]).toEqual({ role: 'user', content: 'hello' })
    assertValidOpenAIChatMessages(result)
  })

  test('tool_result block 带 cache_control → 迁移到前面的 user 消息（DashScope 兼容）', () => {
    const cc = { type: 'ephemeral' }
    const messages = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'c1', content: 'ok', cache_control: cc }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    // tool 消息上不应有 cache_control（DashScope 忽略）
    const toolMsg = result.find((m) => m.role === 'tool') as any
    expect(toolMsg).not.toHaveProperty('cache_control')
    // cache_control 应迁移到最后一条 user 消息上
    const userMsgs = result.filter((m) => m.role === 'user') as any[]
    const lastUser = userMsgs[userMsgs.length - 1]
    const lastBlock = Array.isArray(lastUser.content)
      ? lastUser.content[lastUser.content.length - 1]
      : lastUser.content
    expect(typeof lastBlock === 'object' ? lastBlock.cache_control : undefined).toEqual(cc)
  })

  test('tool_result block 无 cache_control → role:tool 消息无多余字段', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'c1', content: 'ok' }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const toolMsg = result.find((m) => m.role === 'tool') as any
    expect(toolMsg).not.toHaveProperty('cache_control')
  })

  test('多个 tool_result，cache_control 迁移到最后 user 消息', () => {
    const cc = { type: 'ephemeral' }
    const messages = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'c1', name: 'read', input: {} },
          { type: 'tool_call', id: 'c2', name: 'write', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'c1', content: 'r1' },
          { type: 'tool_result', toolCallId: 'c2', content: 'r2', cache_control: cc },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    // tool 消息无 cache_control
    const toolMsgs = result.filter((m) => m.role === 'tool') as any[]
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[0]).not.toHaveProperty('cache_control')
    expect(toolMsgs[1]).not.toHaveProperty('cache_control')
    // 最后 user 消息有 cache_control
    const userMsgs = result.filter((m) => m.role === 'user') as any[]
    const lastUser = userMsgs[userMsgs.length - 1]
    if (typeof lastUser.content === 'string') {
      // string 转为 array 后应带 cache_control
      expect(false).toBe(true) // 不应该到这里
    } else {
      const last = lastUser.content[lastUser.content.length - 1]
      expect(last.cache_control).toEqual(cc)
    }
  })

  test('assistant text block 带 cache_control → content 保持 array 形式', () => {
    const cc = { type: 'ephemeral' }
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer', cache_control: cc }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const am = result[0] as any
    expect(Array.isArray(am.content)).toBe(true)
    expect(am.content[0].text).toBe('answer')
    expect(am.content[0].cache_control).toEqual(cc)
  })

  test('assistant text block 无 cache_control → content 为 string（保持原行为）', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const am = result[0] as any
    expect(typeof am.content).toBe('string')
    expect(am.content).toBe('answer')
  })

  test('assistant 多 text block 带 cache_control → 合并后保留 cache_control', () => {
    const cc = { type: 'ephemeral' }
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2', cache_control: cc },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)
    const am = result[0] as any
    expect(Array.isArray(am.content)).toBe(true)
    expect(am.content[0].text).toBe('part1\n\npart2')
    expect(am.content[0].cache_control).toEqual(cc)
  })

  test('agentic loop 端到端：cache_control 从 tool_result 迁移到最后 user 消息', () => {
    // 模拟实际多轮对话：user → assistant(tool_call) → user(tool_result with cache_control)
    const cc = { type: 'ephemeral' }
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '帮我读一下文件' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_call', id: 'tc1', name: 'Read', input: { path: '/tmp/a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'tc1',
            content: 'const x = 1',
            cache_control: cc,
          },
        ],
      },
    ]
    const result = messagesToOpenAI(messages as any)

    // 验证结构：user → assistant(tool_calls) → tool → (no extra user)
    expect(result[0]).toMatchObject({ role: 'user' })
    expect((result[1] as any).role).toBe('assistant')
    expect((result[2] as any).role).toBe('tool')

    // tool 消息不应有 cache_control
    expect((result[2] as any).cache_control).toBeUndefined()

    // 最后一条 user 消息（即 result[0]）应收到迁移的 cache_control
    const firstUser = result[0] as any
    if (Array.isArray(firstUser.content)) {
      const lastBlock = firstUser.content[firstUser.content.length - 1]
      expect(lastBlock.cache_control).toEqual(cc)
    } else {
      // string 被转为 array
      expect(Array.isArray(firstUser.content)).toBe(true)
    }
  })

  test('多轮对话：cache_control 迁移到距离 tool_result 最近的 user 消息', () => {
    const cc = { type: 'ephemeral' }
    const messages = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: [{ type: 'text', text: '回复1' }] },
      { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'tc1', name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'tc1', content: 'done', cache_control: cc }],
      },
    ]
    const result = messagesToOpenAI(messages as any)

    // tool 消息无 cache_control
    const toolMsgs = result.filter((m) => m.role === 'tool') as any[]
    for (const t of toolMsgs) {
      expect(t.cache_control).toBeUndefined()
    }

    // 最后一条 user 是 "第二轮"（因为 tool_result 变成了 role:'tool'）
    const userMsgs = result.filter((m) => m.role === 'user') as any[]
    const lastUser = userMsgs[userMsgs.length - 1]
    if (Array.isArray(lastUser.content)) {
      const lastBlock = lastUser.content[lastUser.content.length - 1]
      expect(lastBlock.cache_control).toEqual(cc)
    } else {
      // "第二轮" string → 应被转为 array
      expect(Array.isArray(lastUser.content)).toBe(true)
    }
  })
})
