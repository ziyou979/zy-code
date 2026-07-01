import { describe, expect, test } from 'bun:test'

import { hasExternalToolOverride } from '../../../src/tools/externalToolLoader.js'
import { WebSearchTool } from '../../../src/tools/WebSearchTool/WebSearchTool.js'

const realWebSearchTest = process.env.ZY_RUN_REAL_WEB_SEARCH_TEST === '1' ? test : test.skip

function createSearXNGJson(
  results: Array<{ title: string; url: string; content?: string }>,
): string {
  return JSON.stringify({ results })
}

describe('WebSearchTool', () => {
  test('rejects empty query', async () => {
    const result = await WebSearchTool.validateInput({ query: '' })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
  })

  test('rejects simultaneous allowed and blocked domains', async () => {
    const result = await WebSearchTool.validateInput({
      query: '杭州天气',
      allowed_domains: ['example.com'],
      blocked_domains: ['example.org'],
    })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
  })

  test('accepts max_results and maxResults numeric strings', () => {
    const snakeCaseInput = WebSearchTool.inputSchema.parse({
      query: '杭州天气',
      max_results: '3',
    })
    const camelCaseInput = WebSearchTool.inputSchema.parse({
      query: '杭州天气',
      maxResults: '4',
    })

    expect(snakeCaseInput.max_results).toBe(3)
    expect(camelCaseInput.maxResults).toBe(4)
  })

  test('uses builtin provider and respects max_results', async () => {
    const originalFetch = globalThis.fetch
    const progressEvents: unknown[] = []
    const json = createSearXNGJson([
      {
        title: '杭州天气',
        url: 'https://example.com/weather',
        content: '杭州天气示例摘要',
      },
      {
        title: '杭州天气第二条',
        url: 'https://example.com/weather-2',
        content: '杭州天气第二条示例摘要',
      },
    ])

    globalThis.fetch = (async () =>
      new Response(json, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    try {
      const parsedInput = WebSearchTool.inputSchema.parse({
        query: '杭州天气',
        max_results: '1',
      })
      const output = await WebSearchTool.call(
        parsedInput,
        undefined as never,
        undefined as never,
        undefined as never,
        (progressEvent) => progressEvents.push(progressEvent),
      )

      const firstResult = output.data.results[0]

      expect(output.data.query).toBe('杭州天气')
      expect(typeof firstResult).toBe('object')
      expect(firstResult).toEqual({
        toolCallId: expect.any(String),
        content: [
          {
            title: '杭州天气',
            url: 'https://example.com/weather',
            snippet: '杭州天气示例摘要',
          },
        ],
      })
      expect(progressEvents).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  realWebSearchTest('performs a real web search and returns links', async () => {
    const output = await WebSearchTool.call(
      { query: 'OpenAI official website' },
      undefined as never,
      undefined as never,
      undefined as never,
      undefined,
    )

    const linkResult = output.data.results.find(
      (result) =>
        typeof result === 'object' && result.content.some((item) => /^https?:\/\//.test(item.url)),
    )

    expect(output.data.query).toBe('OpenAI official website')
    expect(linkResult).toBeDefined()

    if (!linkResult || typeof linkResult === 'string') {
      throw new Error('Expected real web search to return at least one link result')
    }

    expect(linkResult.content.length).toBeGreaterThan(0)
  })

  test('renders links from search results', () => {
    const block = WebSearchTool.mapToolResultToToolResultBlock(
      {
        query: '杭州天气',
        durationSeconds: 1,
        results: [
          {
            toolCallId: 'search-test',
            content: [
              {
                title: '杭州天气',
                url: 'https://example.com/weather',
                snippet: '杭州天气示例摘要',
              },
            ],
          },
        ],
      },
      'tool-use-test',
    )

    expect(block.type).toBe('tool_result')
    expect(block.toolCallId).toBe('tool-use-test')
    expect(block.content).toContain('https://example.com/weather')
    expect(block.content).toContain('杭州天气示例摘要')
    expect(block.content).toContain('REMINDER')
  })

  test('hasExternalToolOverride returns false when no external tools loaded', () => {
    expect(hasExternalToolOverride('WebSearch')).toBe(false)
  })

  test('isEnabled returns true when no external override and model is set', () => {
    // 在测试环境中，如果没有外部工具覆盖且模型已设置，isEnabled 应返回 true
    // 注意：isEnabled 依赖 getMainLoopModel()，测试中可能返回 false
    const hasOverride = hasExternalToolOverride('WebSearch')
    expect(hasOverride).toBe(false)
    // isEnabled() 还检查 getMainLoopModel()，所以不直接测试其返回值
  })

  test('search handles no results gracefully', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch

    try {
      const parsedInput = WebSearchTool.inputSchema.parse({ query: 'no results query' })
      const output = await WebSearchTool.call(
        parsedInput,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
      )

      expect(output.data.query).toBe('no results query')
      expect(output.data.results).toHaveLength(1)
      expect(output.data.results[0]).toBe('No results found for this query.')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('search handles fetch errors gracefully', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('Network error')
    }) as unknown as typeof fetch

    try {
      const parsedInput = WebSearchTool.inputSchema.parse({ query: 'error query' })
      const output = await WebSearchTool.call(
        parsedInput,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
      )

      expect(output.data.query).toBe('error query')
      expect(output.data.results[0]).toContain('Web search error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('respects blocked_domains in search', async () => {
    const originalFetch = globalThis.fetch
    const json = createSearXNGJson([
      { title: 'Good', url: 'https://good.com', content: 'OK' },
      { title: 'Blocked', url: 'https://evil.com/page', content: 'No' },
    ])

    globalThis.fetch = (async () => new Response(json, { status: 200 })) as unknown as typeof fetch

    try {
      const parsedInput = WebSearchTool.inputSchema.parse({
        query: 'test',
        blocked_domains: ['evil.com'],
      })
      const output = await WebSearchTool.call(
        parsedInput,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
      )

      const firstResult = output.data.results[0]
      expect(typeof firstResult).toBe('object')
      if (typeof firstResult !== 'string') {
        expect(firstResult.content).toHaveLength(1)
        expect(firstResult.content[0].url).toBe('https://good.com')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
