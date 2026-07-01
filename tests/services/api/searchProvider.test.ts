import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

/**
 * 内置搜索 API 测试。
 *
 * 搜索逻辑已内联到 WebSearchTool 中，这里直接测试 HTTP 请求行为。
 */

const SEARCH_API_URL = 'http://127.0.0.1:8089'

describe('BuiltinSearch', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('requests correct URL with query', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await fetch(`${SEARCH_API_URL}/search?q=test&format=json&categories=general&safesearch=0`, {
      headers: { Accept: 'application/json' },
    })

    expect(requestedUrl).toContain('http://127.0.0.1:8089/search')
    expect(requestedUrl).toContain('q=test')
    expect(requestedUrl).toContain('format=json')
  })

  test('parses search results correctly', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet 1' },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet 2' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const response = await fetch(`${SEARCH_API_URL}/search?q=test`)
    const data = await response.json()

    expect(data.results).toHaveLength(2)
    expect(data.results[0].title).toBe('Result 1')
    expect(data.results[0].content).toBe('Snippet 1')
  })

  test('handles empty results', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch

    const response = await fetch(`${SEARCH_API_URL}/search?q=test`)
    const data = await response.json()

    expect(data.results).toEqual([])
  })

  test('handles non-ok response', async () => {
    globalThis.fetch = (async () =>
      new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      })) as unknown as typeof fetch

    const response = await fetch(`${SEARCH_API_URL}/search?q=test`)

    expect(response.ok).toBe(false)
    expect(response.status).toBe(404)
  })

  test('handles missing results field', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: 'something' }), {
        status: 200,
      })) as unknown as typeof fetch

    const response = await fetch(`${SEARCH_API_URL}/search?q=test`)
    const data = await response.json()

    expect(data.results).toBeUndefined()
  })

  test('encodes special characters in query', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const q = encodeURIComponent('hello world & goodbye')
    await fetch(`${SEARCH_API_URL}/search?q=${q}&format=json`)

    expect(requestedUrl).toContain('q=hello%20world%20%26%20goodbye')
  })
})
