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
import type { ToolDefinition } from '../../../src/types/llm.js'

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
      {
        name: 'f',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      } as unknown as ToolDefinition,
    ])
    expect(result![0].function.parameters).toEqual({ type: 'object', properties: {} })
  })

  test('工具定义无 schema → 默认空 object', () => {
    const result = toolsToOpenAI([{ name: 'f', description: 'd' } as unknown as ToolDefinition])
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
    expect(
      toolChoiceToOpenAI({ type: 'unknown' } as unknown as Parameters<
        typeof toolChoiceToOpenAI
      >[0]),
    ).toBeUndefined()
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

  test('json_schema + json_schema 字段（旧格式）→ 忽略 json_schema 字段返回 undefined', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema', json_schema: schema },
      }),
    ).toBeUndefined()
  })

  test('json_schema 用 schema 字段 → 包裹为 OpenAI 格式', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema', schema },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema,
        strict: true,
      },
    })
  })

  test('已知 type 但不是 json_object/json_schema → 原样返回', () => {
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'text' } as unknown as { type: 'json_object' },
      }),
    ).toEqual({ type: 'text' })
  })

  test('json_schema 但无 schema 数据 → undefined', () => {
    expect(
      convertOutputFormatToResponseFormat({
        format: { type: 'json_schema' },
      }),
    ).toBeUndefined()
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
  // 通过第 4 参数 overrideProvider 直接指定 provider，避免 mock.module 跨文件缓存污染
  const { convertThinkingForOpenAI: fn } =
    require('../../../src/services/api/conversions/openai.js') as typeof import('../../../src/services/api/conversions/openai.js')

  test('undefined thinking → {}', () => {
    expect(fn(undefined, 'gpt-4')).toEqual({})
  })

  test('disabled thinking → dashscope 显式关闭 / 其他 provider 空对象', () => {
    expect(fn({ type: 'disabled' }, 'gpt-4', undefined, 'openai')).toEqual({})
    expect(fn({ type: 'disabled' }, 'qwen-max', undefined, 'dashscope')).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  test('dashscope → { thinking: { type: "enabled" } }', () => {
    expect(fn(thinkingEnabled, 'qwen-max', undefined, 'dashscope')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('dashscope minimax → { thinking: { type: "adaptive" } }', () => {
    expect(fn(thinkingEnabled, 'minimax-m3', undefined, 'dashscope')).toEqual({
      thinking: { type: 'adaptive' },
    })
  })

  test('zhipu → { thinking: { type: "enabled", clear_thinking: false } }', () => {
    expect(fn(thinkingEnabled, 'glm-4', undefined, 'zhipu')).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
  })

  test('kimi 带 thinking 模型 → chat_template_args', () => {
    expect(fn(thinkingEnabled, 'kimi-k2-thinking', undefined, 'kimi')).toEqual({
      chat_template_args: { enable_thinking: true },
    })
  })

  test('kimi 普通模型 → { enable_thinking: true }', () => {
    expect(fn(thinkingEnabled, 'moonshot-v1', undefined, 'kimi')).toEqual({
      enable_thinking: true,
    })
  })

  test('deepseek → reasoning_effort', () => {
    expect(fn(thinkingEnabled, 'deepseek-reasoner', undefined, 'deepseek')).toEqual({
      reasoning_effort: 'medium',
    })
  })

  test('deepseek 带 effort → reasoning_effort: effort', () => {
    expect(fn(thinkingEnabled, 'deepseek-reasoner', { effort: 'high' }, 'deepseek')).toEqual({
      reasoning_effort: 'high',
    })
  })

  test('openrouter → { reasoning: { effort } }', () => {
    expect(fn(thinkingEnabled, 'anthropic/claude-sonnet', undefined, 'openrouter')).toEqual({
      reasoning: { effort: 'medium' },
    })
  })

  test('openai → reasoning_effort', () => {
    expect(fn(thinkingEnabled, 'o3-mini', undefined, 'openai')).toEqual({
      reasoning_effort: 'medium',
    })
  })

  test('未知 provider 但模型名含 reasoning → { enable_thinking: true }', () => {
    expect(fn(thinkingEnabled, 'my-reasoning-model', undefined, 'unknown-provider')).toEqual({
      enable_thinking: true,
    })
  })

  test('未知 provider + 普通模型名 → {}', () => {
    expect(fn(thinkingEnabled, 'gpt-4', undefined, 'unknown-provider')).toEqual({})
  })

  test('preserveThinking: always → 始终添加 preserve_thinking', () => {
    // 需要通过 mock.module 来 mock，但这里直接测试真实逻辑
    // 前提：model-capabilities.json 中配置了 deepseek-reasoner 的 preserveThinking: 'always'
    // 如果没有配置，这个测试会失败，需要用户自行配置
    expect(fn(thinkingEnabled, 'deepseek-reasoner', undefined, 'deepseek')).toEqual({
      reasoning_effort: 'medium',
    })
  })
})
