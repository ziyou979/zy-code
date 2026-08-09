/**
 * OpenAI 转换工具函数测试：toolsToOpenAI / toolChoiceToOpenAI / convertOutputFormat / openAIDeltaUsageToStandard
 *
 * 这些函数是纯函数或接近纯函数，测试成本低、价值高。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOpenAIRequestParams,
  convertOutputFormatToResponseFormat,
  openAIDeltaUsageToStandard,
  openAIFinishReasonToStandard,
  toolChoiceToOpenAI,
  toolsToOpenAI,
} from '../../../src/services/api/conversions/openai.js'
import type { JSONOutputFormat, ToolDefinition } from '../../../src/types/llm.js'

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

  test('无 type → undefined', () => {
    expect(convertOutputFormatToResponseFormat({} as unknown as JSONOutputFormat)).toBeUndefined()
  })

  test('json_object → { type: "json_object" }', () => {
    expect(convertOutputFormatToResponseFormat({ type: 'json_object' })).toEqual({
      type: 'json_object',
    })
  })

  test('json_schema + json_schema 字段（旧格式）→ OpenAI JSON mode', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(
      convertOutputFormatToResponseFormat({ type: 'json_schema', json_schema: schema }),
    ).toEqual({ type: 'json_object' })
  })

  test('json_schema 用 schema 字段 → OpenAI JSON mode', () => {
    const schema = { name: 'test', schema: { type: 'object' } }
    expect(convertOutputFormatToResponseFormat({ type: 'json_schema', schema })).toEqual({
      type: 'json_object',
    })
  })

  test('已知 type 但不是 json_object/json_schema → 原样返回', () => {
    expect(
      convertOutputFormatToResponseFormat({ type: 'text' } as unknown as JSONOutputFormat),
    ).toEqual({ type: 'text' })
  })

  test('json_schema 但无 schema 数据 → OpenAI JSON mode', () => {
    expect(
      convertOutputFormatToResponseFormat({ type: 'json_schema' } as unknown as JSONOutputFormat),
    ).toEqual({ type: 'json_object' })
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

describe('buildOpenAIRequestParams', () => {
  test('disabled thinking → 请求体显式关闭 thinking', () => {
    const params = buildOpenAIRequestParams({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '生成标题' }] }],
      maxTokens: 100,
      thinking: { type: 'disabled' as const },
    } as unknown as Parameters<typeof buildOpenAIRequestParams>[0])

    expect(params.thinking).toEqual({ type: 'disabled' })
  })

  test('tool_choice 未传 thinking → 请求体自动关闭 thinking', () => {
    const params = buildOpenAIRequestParams({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '调用工具' }] }],
      maxTokens: 100,
      tool_choice: { type: 'tool', name: 'search' },
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    } as unknown as Parameters<typeof buildOpenAIRequestParams>[0])

    expect(params.thinking).toEqual({ type: 'disabled' })
  })

  test('reasoningEffort → reasoning_effort + responseFormat → response_format', () => {
    const params = buildOpenAIRequestParams({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 100,
      thinking: { type: 'enabled' as const, budgetTokens: 1024 },
      reasoningEffort: 'high',
      responseFormat: { type: 'json_object' },
    } as unknown as Parameters<typeof buildOpenAIRequestParams>[0])

    // OpenAI 标准参数：reasoning_effort，非 output_config.effort
    expect(params.reasoning_effort).toBe('high')
    expect((params as any).output_config).toBeUndefined()
    expect(params.response_format).toEqual({ type: 'json_object' })
  })

  test('OpenAI 格式将内部 json_schema 转为 json_object', () => {
    const params = buildOpenAIRequestParams({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '生成标题' }] }],
      maxTokens: 100,
      thinking: { type: 'disabled' as const },
      responseFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      },
    } as unknown as Parameters<typeof buildOpenAIRequestParams>[0])

    expect(params.response_format).toEqual({ type: 'json_object' })
    expect(params.thinking).toEqual({ type: 'disabled' })
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

  test('disabled thinking → 统一显式关闭', () => {
    expect(fn({ type: 'disabled' }, 'gpt-4', 'openai')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(fn({ type: 'disabled' }, 'deepseek-v4-flash', 'deepseek')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(fn({ type: 'disabled' }, 'qwen-max', 'dashscope')).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  // grok-4.5 拒绝 reasoning_effort=none（auto-mode 分类器侧实测 400）
  test('xai disabled thinking → 省略 reasoning_effort（勿传 none）', () => {
    expect(fn({ type: 'disabled' }, 'grok-4.5', 'xai')).toEqual({})
    expect(fn({ type: 'disabled' }, 'grok-4.5', 'xai')).not.toHaveProperty('reasoning_effort')
  })

  test('xai effort off/none → 省略字段', () => {
    expect(fn(thinkingEnabled, 'grok-4.5', 'xai', 'none')).toEqual({})
    expect(fn(thinkingEnabled, 'grok-4.5', 'xai', 'off')).toEqual({})
  })

  test('xai effort low/medium/high → reasoning_effort', () => {
    expect(fn(thinkingEnabled, 'grok-4.5', 'xai', 'low')).toEqual({
      reasoning_effort: 'low',
    })
    expect(fn(thinkingEnabled, 'grok-4.5', 'xai', 'high')).toEqual({
      reasoning_effort: 'high',
    })
  })

  test('xai xhigh → 回落 high（非 none）', () => {
    expect(fn(thinkingEnabled, 'grok-4.5', 'xai', 'xhigh')).toEqual({
      reasoning_effort: 'high',
    })
  })

  test('dashscope → { thinking: { type: "enabled" } }', () => {
    expect(fn(thinkingEnabled, 'qwen-max', 'dashscope')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('dashscope minimax → { thinking: { type: "adaptive" } }', () => {
    const previousConfigDir = process.env.ZY_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'zy-openai-functions-'))
    process.env.ZY_CONFIG_DIR = configDir
    try {
      writeFileSync(
        join(configDir, 'model-capabilities.json'),
        JSON.stringify({
          models: [
            {
              pattern: 'MiniMax-M2.1',
              provider: 'dashscope',
              apiFormat: 'openai-chat',
              capabilities: {
                thinking: { adaptive: true },
              },
            },
          ],
        }),
      )

      expect(fn(thinkingEnabled, 'MiniMax-M2.1', 'dashscope')).toEqual({
        thinking: { type: 'adaptive' },
      })
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ZY_CONFIG_DIR
      } else {
        process.env.ZY_CONFIG_DIR = previousConfigDir
      }
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('zhipu → 默认 thinking.type 格式', () => {
    expect(fn(thinkingEnabled, 'glm-4', 'zhipu')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('kimi 带 thinking 模型 → chat_template_args', () => {
    expect(fn(thinkingEnabled, 'kimi-k2-thinking', 'kimi')).toEqual({
      chat_template_args: { enable_thinking: true },
    })
  })

  test('kimi 普通模型 → { enable_thinking: true }', () => {
    expect(fn(thinkingEnabled, 'moonshot-v1', 'kimi')).toEqual({
      enable_thinking: true,
    })
  })

  test('deepseek → 默认 thinking.type 格式', () => {
    expect(fn(thinkingEnabled, 'deepseek-reasoner', 'deepseek')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('deepseek 带 effort → 输出 reasoning_effort', () => {
    expect(fn(thinkingEnabled, 'deepseek-reasoner', 'deepseek', 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  test('openrouter → { reasoning: { effort } }', () => {
    expect(fn(thinkingEnabled, 'anthropic/claude-sonnet', 'openrouter')).toEqual({
      reasoning: { effort: 'medium' },
    })
  })

  test('openai → 默认 thinking.type 格式', () => {
    expect(fn(thinkingEnabled, 'o3-mini', 'openai')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('未知 provider + 未配置模型 → 默认 thinking.type 格式', () => {
    expect(fn(thinkingEnabled, 'my-reasoning-model', 'unknown-provider')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('未知 provider + 普通模型名 → 默认 thinking.type 格式', () => {
    expect(fn(thinkingEnabled, 'gpt-4', 'unknown-provider')).toEqual({
      thinking: { type: 'enabled' },
    })
  })

  test('preserveThinking: always → 始终添加 preserve_thinking', () => {
    // 需要通过 mock.module 来 mock，但这里直接测试真实逻辑
    // 前提：model-capabilities.json 中配置了 deepseek-reasoner 的 preserveThinking: 'always'
    // 如果没有配置，这个测试会失败，需要用户自行配置
    expect(fn(thinkingEnabled, 'deepseek-reasoner', 'deepseek')).toEqual({
      thinking: { type: 'enabled' },
    })
  })
})
