import { describe, expect, test } from 'bun:test'

import { getDuckDuckGoRegionForUiLanguage } from '../../../src/services/search/index.js'
import { WebSearchTool } from '../../../src/tools/WebSearchTool/WebSearchTool.js'

const realWebSearchTest = process.env.ZY_RUN_REAL_WEB_SEARCH_TEST === '1' ? test : test.skip

function createDuckDuckGoHtml(
  results: Array<{ title: string; url: string; snippet: string }>,
): string {
  return results
    .map(
      (result) => `
        <a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}&amp;rut=test" class='result-link'>${result.title}</a>
        <td class='result-snippet'>${result.snippet}</td>
      `,
    )
    .join('\n')
}

describe('WebSearchTool', () => {
  test('maps UI language to DuckDuckGo search region', () => {
    expect(getDuckDuckGoRegionForUiLanguage('zh-CN')).toBe('cn-zh')
    expect(getDuckDuckGoRegionForUiLanguage('en')).toBe('us-en')
  })

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

  test('uses local DuckDuckGo provider and respects max_results', async () => {
    const originalFetch = globalThis.fetch
    const progressEvents: unknown[] = []
    const html = createDuckDuckGoHtml([
      {
        title: '杭州天气',
        url: 'https://example.com/weather',
        snippet: '杭州天气示例摘要',
      },
      {
        title: '杭州天气第二条',
        url: 'https://example.com/weather-2',
        snippet: '杭州天气第二条示例摘要',
      },
    ])

    globalThis.fetch = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch

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

  realWebSearchTest('performs a real DuckDuckGo search and returns links', async () => {
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
})
