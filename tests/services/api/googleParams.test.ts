/**
 * Google 原生格式出站参数测试。
 */
import { describe, expect, test } from 'bun:test'
import { buildGoogleRequestParams } from '../../../src/services/api/conversions/google.js'

describe('buildGoogleRequestParams: 出站 Google 请求构造', () => {
  test('顶层 disabled thinking → thinkingBudget 0', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  test('顶层 enabled thinking + reasoningEffort → Google thinkingConfig', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-pro',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      thinking: { type: 'enabled', budgetTokens: 2048 },
      reasoningEffort: 'xhigh',
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    })
  })

  test('responseFormat.json_schema → response schema', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    }
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      responseFormat: { type: 'json_schema', schema },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.generationConfig?.responseMimeType).toBe('application/json')
    expect(result.generationConfig?.responseSchema).toEqual(schema)
  })

  test('toolChoice tool → Google ANY + allowedFunctionNames', () => {
    const result = buildGoogleRequestParams({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'search' },
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof buildGoogleRequestParams>[0])

    expect(result.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['search'],
      },
    })
    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })
})
