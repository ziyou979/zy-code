import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { BuiltinSearchProvider } from '../../../src/services/search/BuiltinSearchProvider.js'

describe('BuiltinSearchProvider', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('has id "web-search"', () => {
    const provider = new BuiltinSearchProvider({})
    expect(provider.id).toBe('web-search')
  })

  test('uses default URL when no url option provided', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    await provider.search('test')

    expect(requestedUrl).toContain('http://search.zy.ai:8089/search')
    expect(requestedUrl).toContain('q=test')
    expect(requestedUrl).toContain('format=json')
  })

  test('uses custom URL when provided', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({ url: 'http://localhost:8888' })
    await provider.search('hello world')

    expect(requestedUrl).toContain('http://localhost:8888/search')
    expect(requestedUrl).toContain('q=hello+world')
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

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query')

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Result 1',
      url: 'https://example.com/1',
      snippet: 'Snippet 1',
    })
    expect(results[1]).toEqual({
      title: 'Result 2',
      url: 'https://example.com/2',
      snippet: 'Snippet 2',
    })
  })

  test('respects maxResults option', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'R1', url: 'https://a.com', content: 'S1' },
            { title: 'R2', url: 'https://b.com', content: 'S2' },
            { title: 'R3', url: 'https://c.com', content: 'S3' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query', { maxResults: 2 })

    expect(results).toHaveLength(2)
  })

  test('filters blocked domains', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'Good', url: 'https://good.com', content: 'OK' },
            { title: 'Bad', url: 'https://evil.com/page', content: 'No' },
            { title: 'Also Good', url: 'https://good.org', content: 'Fine' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query', { blockedDomains: ['evil.com'] })

    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.url.includes('evil.com'))).toBe(true)
  })

  test('skips results without title or url', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'Good', url: 'https://good.com', content: 'OK' },
            { title: '', url: 'https://empty-title.com' },
            { title: 'No URL', url: '' },
            { url: 'https://no-title.com', content: 'Missing title' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query')

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Good')
  })

  test('returns empty array for empty results', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query')

    expect(results).toEqual([])
  })

  test('throws on non-ok response', async () => {
    globalThis.fetch = (async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})

    await expect(provider.search('query')).rejects.toThrow('Web search failed: 404 Not Found')
  })

  test('returns empty array when response has no results field', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: 'something' }), {
        status: 200,
      })) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    const results = await provider.search('query')

    expect(results).toEqual([])
  })

  test('encodes special characters in query', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    await provider.search('hello world & goodbye')

    expect(requestedUrl).toContain('q=hello+world+%26+goodbye')
  })

  test('adds site: filter for allowedDomains', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new BuiltinSearchProvider({})
    await provider.search('query', { allowedDomains: ['example.com'] })

    expect(requestedUrl).toContain('site%3Aexample.com')
  })
})
