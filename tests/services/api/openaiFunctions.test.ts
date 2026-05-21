/**
 * OpenAI 转换工具函数测试：toolsToOpenAI / toolChoiceToOpenAI / convertOutputFormat / openAIDeltaUsageToStandard
 *
 * 这些函数是纯函数或接近纯函数，测试成本低、价值高。
 */
import { describe, expect, test } from 'bun:test'
import {
  convertOutputFormatToResponseFormat,
  openAIDeltaUsageToStandard,
  openAIFinishReasonToStandard,
  toolChoiceToOpenAI,
  toolsToOpenAI,
} from '../../../src/services/api/conversions/openai.js'

describe('toolsToOpenAI', () => {
  test('undefined → undefined', () => {
    expect(toolsToOpenAI(undefined)).toBeUndefined()
  })

  test('空数组 → undefined', () => {
    expect(toolsToOpenAI([])).toBeUndefined()
  })

  test('工具定义带 inputSchema → OpenAI 格式', () => {
    const result = toolsToOpenAI([
      {
        name: 'search',
        description: 'Search web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ])
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ])
  })

  test('工具定义带 input_schema（v1 旧名）→ 兼容', () => {
    const result = toolsToOpenAI([
      { name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } } as any,
    ])
    expect(result![0].function.parameters).toEqual({ type: 'object', properties: {} })
  })

  test('工具定义无 schema → 默认空 object', () => {
    const result = toolsToOpenAI([{ name: 'f', description: 'd' } as any])
    expect(result![0].function.parameters).toEqual({ type: 'object', properties: {} })
  })
})

describe('toolChoiceToOpenAI', () => {
  test('undefined → undefined', () => {
    expect(toolChoiceToOpenAI(undefined)).toBeUndefined()
  })

  test('auto → "auto"', () => {
    expect(toolChoiceToOpenAI({ type: 'auto' })).toBe('auto')
  })

  test('none → "none"', () => {
    expect(toolChoiceToOpenAI({ type: 'none' })).toBe('none')
  })

  test('tool → { type: "function", function: { name } }', () => {
    expect(toolChoiceToOpenAI({ type: 'tool', name: 'search' })).toEqual({
      type: 'function',
      function: { name: 'search' },
    })
  })

  test('未知 type → undefined', () => {
    expect(toolChoiceToOpenAI({ type: 'unknown' } as any)).toBeUndefined()
  })
})

describe('convertOutputFormatToResponseFormat', () => {
  test('undefined → undefined', () => {
    expect(convertOutputFormatToResponseFormat(undefined)).toBeUndefined()
  })

  test('outputConfig 无 format → undefined', () => {
    expect(convertOutputFormatToResponseFormat({})).toBeUndefined()
  })

  test('json_object → { type: "json_object" }', () => {
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_object' },
      }),
    ).toEqual({ type: 'json_object' })
  })

  test('json_schema → { type: "json_schema", json_schema }', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema', json_schema: schema },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: schema,
    })
  })

  test('json_schema 用 schema 字段（替代 json_schema）', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema', schema },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: schema,
    })
  })

  test('已知 type 但不是 json_object/json_schema → 原样返回', () => {
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'text' } as any,
      }),
    ).toEqual({ type: 'text' })
  })

  test('json_schema 但无 schema 数据 → 原样透传 type', () => {
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema' },
      }),
    ).toEqual({ type: 'json_schema' } as any)
  })
})

describe('openAIDeltaUsageToStandard', () => {
  test('正常 usage → DeltaUsage', () => {
    const result = openAIDeltaUsageToStandard({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    })
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(20)
  })

  test('null → outputTokens 0', () => {
    expect(openAIDeltaUsageToStandard(null).outputTokens).toBe(0)
  })

  test('undefined → outputTokens 0', () => {
    expect(openAIDeltaUsageToStandard(undefined).outputTokens).toBe(0)
  })
})

describe('openAIFinishReasonToStandard', () => {
  test('stop → end_turn', () => {
    expect(openAIFinishReasonToStandard('stop')).toBe('end_turn')
  })

  test('length → max_tokens', () => {
    expect(openAIFinishReasonToStandard('length')).toBe('max_tokens')
  })

  test('tool_calls → tool_use', () => {
    expect(openAIFinishReasonToStandard('tool_calls')).toBe('tool_use')
  })

  test('content_filter → content_filter', () => {
    expect(openAIFinishReasonToStandard('content_filter')).toBe('content_filter')
  })

  test('refusal → refusal', () => {
    expect(openAIFinishReasonToStandard('refusal')).toBe('refusal')
  })

  test('null → null', () => {
    expect(openAIFinishReasonToStandard(null)).toBeNull()
  })

  test('undefined → null', () => {
    expect(openAIFinishReasonToStandard(undefined)).toBeNull()
  })

  test('未知值 → end_turn（保守 fallback）', () => {
    expect(openAIFinishReasonToStandard('unknown_reason')).toBe('end_turn')
  })
})

describe('convertThinkingForOpenAI', () => {
  const thinkingEnabled = { type: 'enabled' as const, budgetTokens: 1024 }

  test('undefined thinking → {}', () => {
    const { convertThinkingForOpenAI } = require('../../../src/services/api/conversions/openai.js')
    expect(convertThinkingForOpenAI(undefined, 'gpt-4')).toEqual({})
  })

  test('disabled thinking → {}', () => {
    const { convertThinkingForOpenAI } = require('../../../src/services/api/conversions/openai.js')
    expect(convertThinkingForOpenAI({ type: 'disabled' }, 'gpt-4')).toEqual({})
  })

  test('dashscope → { enable_thinking: true }', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'dashscope',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'qwen-max')).toEqual({ enable_thinking: true })
    mock.restore()
  })

  test('zhipu → { thinking: { type: "enabled", clear_thinking: false } }', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'zhipu',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'glm-4')).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
    mock.restore()
  })

  test('kimi 带 thinking 模型 → chat_template_args', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'kimi',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'kimi-k2-thinking')).toEqual({
      chat_template_args: { enable_thinking: true },
    })
    mock.restore()
  })

  test('kimi 普通模型 → { enable_thinking: true }', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'kimi',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'moonshot-v1')).toEqual({ enable_thinking: true })
    mock.restore()
  })

  test('deepseek → reasoning_effort', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'deepseek',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'deepseek-reasoner')).toEqual({ reasoning_effort: 'medium' })
    mock.restore()
  })

  test('deepseek 带 effort → reasoning_effort: effort', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'deepseek',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'deepseek-reasoner', { effort: 'high' })).toEqual({
      reasoning_effort: 'high',
    })
    mock.restore()
  })

  test('openrouter → { reasoning: { effort } }', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'openrouter',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'anthropic/claude-sonnet')).toEqual({
      reasoning: { effort: 'medium' },
    })
    mock.restore()
  })

  test('openai → reasoning_effort', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'openai',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'o3-mini')).toEqual({ reasoning_effort: 'medium' })
    mock.restore()
  })

  test('未知 provider 但模型名含 reasoning → { enable_thinking: true }', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'unknown-provider',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'my-reasoning-model')).toEqual({ enable_thinking: true })
    mock.restore()
  })

  test('未知 provider + 普通模型名 → {}', async () => {
    const { mock } = await import('bun:test')
    mock.module('../../../src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'unknown-provider',
    }))
    const { convertThinkingForOpenAI: fn } = await import(
      '../../../src/services/api/conversions/openai.js'
    )
    expect(fn(thinkingEnabled, 'gpt-4')).toEqual({})
    mock.restore()
  })
})
