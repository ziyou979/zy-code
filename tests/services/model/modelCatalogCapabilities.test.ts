import { describe, expect, test } from 'bun:test'
import {
  getModelThinkingSupport,
  mergeModelCatalogCapabilities,
  removeThinkingEffortOverride,
  extractModelCatalogCapability,
  extractRegistryModelCapability,
  type ModelCatalogCapability,
} from '../../../src/services/model/modelCatalogCapabilities.js'

type ThinkingCapability = NonNullable<ModelCatalogCapability['capabilities']['thinking']>

describe('modelCatalogCapabilities', () => {
  test('空 thinking 保持未知，清除唯一 effort 覆盖后删除整个声明', () => {
    expect(getModelThinkingSupport({})).toBeUndefined()
    expect(getModelThinkingSupport({ effort: ['off'] })).toBe(false)
    expect(removeThinkingEffortOverride({ effort: ['off'] })).toBeUndefined()
    expect(removeThinkingEffortOverride({ effort: ['on'], preserve: 'always' })).toEqual({
      preserve: 'always',
    })
  })
  test('目录只有关闭档时不虚构默认思考，最强档仅采用平台明确声明的值', () => {
    expect(
      extractRegistryModelCapability({
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none'] }],
      }).capabilities.thinking?.effort,
    ).toEqual(['off'])
    expect(
      extractRegistryModelCapability({
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['high', 'xhigh', 'max'] }],
      }).capabilities.thinking?.effort,
    ).toEqual({ levels: ['thorough', 'extreme'], map: { thorough: 'high', extreme: 'max' } })
  })
  test('公共目录明确思考强度时自动生成中性档位映射，不维护模型名白名单', () => {
    const capability = extractRegistryModelCapability({
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
    })
    expect(capability.capabilities.thinking?.effort).toEqual({
      levels: ['off', 'light', 'balanced', 'thorough', 'extreme'],
      map: { light: 'low', balanced: 'medium', thorough: 'high', extreme: 'xhigh' },
    })
  })
  test('方舟目录保留多模态、版本 token 限制和结构化输出能力', () => {
    expect(
      extractModelCatalogCapability({
        modalities: { input_modalities: ['text', 'image', 'video', 'audio'] },
        features: { structured_outputs: { json_schema: true } },
        token_limits: {
          context_window: 1048576,
          max_input_token_length: 1048576,
          max_output_token_length: 262144,
          max_reasoning_token_length: 262144,
        },
      }),
    ).toEqual({
      capabilities: {
        input: ['text', 'image'],
        structured_outputs: true,
        thinking: { effort: ['on'] },
      },
      tokens: {
        contextWindow: 1048576,
        maxInputTokens: 1048576,
        maxOutputTokens: 262144,
        maxThinkingTokens: 262144,
      },
    })
  })
  test('OpenRouter 只提取明确参数，response_format 不等于严格结构化输出', () => {
    expect(
      extractModelCatalogCapability({
        architecture: { input_modalities: ['text', 'image'] },
        context_length: 128000,
        top_provider: { max_completion_tokens: 4000 },
        supported_parameters: ['reasoning', 'response_format'],
      }),
    ).toEqual({
      capabilities: { input: ['text', 'image'], thinking: { effort: ['on'] } },
      tokens: { contextWindow: 128000, maxOutputTokens: 4000 },
    })
  })
  test('名称或描述不能推断思考和视觉能力，非法额度保持未知', () => {
    expect(
      extractModelCatalogCapability({
        id: 'vision-thinking-pro',
        description: 'Supports everything',
        context_length: -1,
      }),
    ).toBeUndefined()
    expect(
      extractModelCatalogCapability({
        modalities: { input_modalities: ['text'] },
        token_limits: { context_window: '1m', max_reasoning_token_length: 0 },
      }),
    ).toEqual({ capabilities: { input: ['text'] } })
  })
})

test('目录保留具体 MIME，公共目录 PDF 使用标准 MIME 值', () => {
  const inputs = [
    'text',
    'image/jpeg',
    'application/pdf',
    'audio/mpeg',
    'image/jpeg',
    'image/*',
    'invalid',
  ]
  expect(
    extractModelCatalogCapability({ modalities: { input_modalities: inputs } })?.capabilities.input,
  ).toEqual(['text', 'image/jpeg', 'application/pdf', 'audio/mpeg'])
  expect(
    extractRegistryModelCapability({ modalities: { input: ['text', 'pdf', 'image/png'] } })
      .capabilities.input,
  ).toEqual(['text', 'application/pdf', 'image/png'])
})

test('明确不支持思考时不继承 preserve/adaptive，部分或未知覆盖仍继承', () => {
  const merge = (thinking: ThinkingCapability, override?: ThinkingCapability) =>
    mergeModelCatalogCapabilities(
      { capabilities: { thinking } },
      { capabilities: override ? { thinking: override } : {} },
    ).capabilities.thinking
  const bases: ThinkingCapability[] = [
    { preserve: 'optional', effort: ['on'] },
    { preserve: 'always' },
    { adaptive: true, effort: ['off', 'on'] },
  ]
  for (const base of bases) {
    expect(merge(base, { effort: ['off'] })).toEqual({ effort: ['off'] })
    expect(merge(base, { effort: { levels: ['off'] } })).toEqual({ effort: { levels: ['off'] } })
    expect(getModelThinkingSupport(merge(base, { effort: ['off'] }))).toBe(false)
    expect(merge(base)).toEqual(base)
    expect(merge(base, {})).toEqual(base)
  }
  expect(merge({ preserve: 'always', adaptive: true }, { effort: ['off', 'on'] })).toEqual({
    preserve: 'always',
    adaptive: true,
    effort: ['off', 'on'],
  })
})
