import { describe, expect, test } from 'bun:test'

import {
  redactSecrets,
  resolveWebSearchConfig,
  runSearchChain,
  type ResolvedWebSearchConfig,
  type SearchRequest,
} from '../../src/tools/WebSearchTool/searchBackends.js'

const HOSTED_KEY = 'zys_hostedKeyhostedKeyhostedKeyhostedKey1234567'
const TAVILY_KEY = 'tvly-secret-tavily-key'
const BRAVE_KEY = 'BSA-secret-brave-key'

const REQ: SearchRequest = { query: 'bun test', rawQuery: 'bun test', maxResults: 5 }

type Call = { url: string; init?: RequestInit }

function fakeFetch(
  routes: Array<[string, (call: Call) => Response | Promise<Response>]>,
  calls: Call[],
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    for (const [prefix, handler] of routes) {
      if (call.url.startsWith(prefix)) {
        return handler(call)
      }
    }
    throw new TypeError(`fetch failed: ECONNREFUSED ${call.url}`)
  }) as typeof fetch
}

const openSerpBody = (n = 2) =>
  JSON.stringify({
    query: { text: 'bun test' },
    meta: { took_ms: 10 },
    results: Array.from({ length: n }, (_, i) => ({
      title: `T${i}`,
      url: `https://o.test/${i}`,
      snippet: `s${i}`,
    })),
  })

function config(over: Partial<ResolvedWebSearchConfig> = {}): ResolvedWebSearchConfig {
  return { openserpUrl: 'http://127.0.0.1:7000', ...over }
}

function headerOf(call: Call, name: string): string | null {
  return new Headers(call.init?.headers).get(name)
}

describe('resolveWebSearchConfig', () => {
  test('defaults to local OpenSERP only', () => {
    const c = resolveWebSearchConfig({}, {})
    expect(c.openserpUrl).toBe('http://127.0.0.1:7000')
    expect(c.hosted).toBeUndefined()
    expect(c.tavilyKey).toBeUndefined()
    expect(c.braveKey).toBeUndefined()
  })

  test('env overrides settings; hosted needs both URL and key', () => {
    const c = resolveWebSearchConfig(
      {
        ZY_SEARCH_URL: 'https://env.example/',
        ZY_SEARCH_KEY: HOSTED_KEY,
        TAVILY_API_KEY: TAVILY_KEY,
      },
      { hostedUrl: 'https://settings.example', hostedKey: 'zys_other', braveApiKey: BRAVE_KEY },
    )
    expect(c.hosted).toEqual({ url: 'https://env.example', key: HOSTED_KEY })
    expect(c.tavilyKey).toBe(TAVILY_KEY)
    expect(c.braveKey).toBe(BRAVE_KEY)

    const noUrl = resolveWebSearchConfig({ ZY_SEARCH_KEY: HOSTED_KEY }, {})
    expect(noUrl.hosted).toBeUndefined()
    expect(noUrl.hostedMisconfigured).toContain('ZY_SEARCH_URL')

    const noKey = resolveWebSearchConfig({ ZY_SEARCH_URL: 'https://env.example' }, {})
    expect(noKey.hosted).toBeUndefined()
    expect(noKey.hostedMisconfigured).toBeUndefined()
  })

  test('refuses to send the hosted key over plain http (except loopback)', () => {
    const c = resolveWebSearchConfig(
      { ZY_SEARCH_URL: 'http://evil.example', ZY_SEARCH_KEY: HOSTED_KEY },
      {},
    )
    expect(c.hosted).toBeUndefined()
    expect(c.hostedMisconfigured).toContain('https')
    const local = resolveWebSearchConfig(
      { ZY_SEARCH_URL: 'http://127.0.0.1:8787', ZY_SEARCH_KEY: HOSTED_KEY },
      {},
    )
    expect(local.hosted?.url).toBe('http://127.0.0.1:8787')
  })

  test('ZY_OPENSERP_URL overrides the local base URL', () => {
    expect(
      resolveWebSearchConfig({ ZY_OPENSERP_URL: 'http://10.0.0.5:7000/' }, {}).openserpUrl,
    ).toBe('http://10.0.0.5:7000')
  })
})

describe('runSearchChain', () => {
  test('uses local OpenSERP when it answers (no other backend is called)', async () => {
    const calls: Call[] = []
    const f = fakeFetch(
      [['http://127.0.0.1:7000/mega/search', () => new Response(openSerpBody(3))]],
      calls,
    )
    const r = await runSearchChain(
      REQ,
      config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY }, tavilyKey: TAVILY_KEY }),
      f,
    )
    expect(r.backend).toBe('local OpenSERP')
    expect(r.items).toEqual([
      { title: 'T0', url: 'https://o.test/0', content: 's0' },
      { title: 'T1', url: 'https://o.test/1', content: 's1' },
      { title: 'T2', url: 'https://o.test/2', content: 's2' },
    ])
    expect(calls).toHaveLength(1)
  })

  test('local down → hosted gateway with Bearer key, key never in the URL', async () => {
    const calls: Call[] = []
    const f = fakeFetch(
      [['https://gw.test/mega/search', () => new Response(openSerpBody(2))]],
      calls,
    )
    const r = await runSearchChain(
      REQ,
      config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }),
      f,
    )
    expect(r.backend).toBe('hosted zy-search')
    const hostedCall = calls.find((c) => c.url.startsWith('https://gw.test'))!
    expect(headerOf(hostedCall, 'authorization')).toBe(`Bearer ${HOSTED_KEY}`)
    expect(hostedCall.url).not.toContain(HOSTED_KEY)
    const u = new URL(hostedCall.url)
    expect(u.searchParams.get('text')).toBe('bun test')
    expect(u.searchParams.get('engines')).toBeNull()
  })

  test('hosted quota error falls through to Tavily without long waits', async () => {
    const calls: Call[] = []
    const f = fakeFetch(
      [
        [
          'https://gw.test',
          () =>
            new Response(
              JSON.stringify({
                error: 'quota_exceeded',
                message: 'Daily quota of 100 searches used up.',
              }),
              {
                status: 429,
                headers: { 'Retry-After': '40000' },
              },
            ),
        ],
        [
          'https://api.tavily.com/search',
          () =>
            new Response(
              JSON.stringify({
                results: [
                  { title: 'Tav', url: 'https://t.test/1', content: 'tavily snippet', score: 0.9 },
                ],
              }),
            ),
        ],
      ],
      calls,
    )
    const started = Date.now()
    const r = await runSearchChain(
      { ...REQ, allowedDomains: ['bun.sh'], query: 'bun test site:bun.sh', date: 'past_week' },
      config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY }, tavilyKey: TAVILY_KEY }),
      f,
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.backend).toBe('Tavily')
    expect(r.items).toEqual([{ title: 'Tav', url: 'https://t.test/1', content: 'tavily snippet' }])
    const tav = calls.find((c) => c.url.startsWith('https://api.tavily.com'))!
    expect(headerOf(tav, 'authorization')).toBe(`Bearer ${TAVILY_KEY}`)
    const body = JSON.parse(String(tav.init?.body))
    expect(body).toMatchObject({
      query: 'bun test',
      include_domains: ['bun.sh'],
      time_range: 'week',
      max_results: 5,
    })
    expect(calls.filter((c) => c.url.startsWith('https://gw.test'))).toHaveLength(1)
  })

  test('Brave is last; results and freshness are mapped', async () => {
    const calls: Call[] = []
    const f = fakeFetch(
      [
        [
          'https://api.tavily.com',
          () => new Response('{"detail":{"error":"Unauthorized"}}', { status: 401 }),
        ],
        [
          'https://api.search.brave.com/res/v1/web/search',
          () =>
            new Response(
              JSON.stringify({
                web: {
                  results: [
                    {
                      title: 'Brave <strong>Bun</strong>',
                      url: 'https://b.test/1',
                      description: 'a &amp; <strong>b</strong>',
                    },
                    { title: 'no url' },
                  ],
                },
              }),
            ),
        ],
      ],
      calls,
    )
    const r = await runSearchChain(
      { ...REQ, date: '20250101..20250131' },
      config({ tavilyKey: TAVILY_KEY, braveKey: BRAVE_KEY }),
      f,
    )
    expect(r.backend).toBe('Brave Search')
    expect(r.items).toEqual([{ title: 'Brave Bun', url: 'https://b.test/1', content: 'a & b' }])
    const brave = calls.find((c) => c.url.startsWith('https://api.search.brave.com'))!
    expect(headerOf(brave, 'x-subscription-token')).toBe(BRAVE_KEY)
    const u = new URL(brave.url)
    expect(u.searchParams.get('freshness')).toBe('2025-01-01to2025-01-31')
    expect(u.searchParams.get('count')).toBe('5')
    expect(brave.url).not.toContain(BRAVE_KEY)
  })

  test('local OpenSERP with all engines failing counts as unavailable', async () => {
    const calls: Call[] = []
    const f = fakeFetch(
      [
        [
          'http://127.0.0.1:7000',
          () =>
            new Response(
              JSON.stringify({
                meta: { took_ms: 1, engines_failed: ['bing', 'google'] },
                results: [],
              }),
            ),
        ],
        [
          'https://api.search.brave.com',
          () =>
            new Response(
              JSON.stringify({ web: { results: [{ title: 'x', url: 'https://x.test' }] } }),
            ),
        ],
      ],
      calls,
    )
    const r = await runSearchChain(REQ, config({ braveKey: BRAVE_KEY }), f)
    expect(r.backend).toBe('Brave Search')
  })

  test('nothing available → clear error pointing at the DuckDuckGo example, no keys leaked', async () => {
    const f = fakeFetch(
      [
        // A misbehaving provider that echoes the key back in its error must not leak it.
        [
          'https://api.tavily.com',
          () => {
            throw new Error(`boom ${TAVILY_KEY}`)
          },
        ],
      ],
      [],
    )
    let message = ''
    try {
      await runSearchChain(REQ, config({ tavilyKey: TAVILY_KEY }), f)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('No web search backend is available')
    expect(message).toContain('local OpenSERP')
    expect(message).toContain('web-search-duckduckgo.ts')
    expect(message).toContain('ZY_SEARCH_KEY')
    expect(message).not.toContain(TAVILY_KEY)
    expect(message).toContain('[REDACTED]')
  })

  test('respects maxResults across providers', async () => {
    const f = fakeFetch([['http://127.0.0.1:7000', () => new Response(openSerpBody(10))]], [])
    const r = await runSearchChain({ ...REQ, maxResults: 4 }, config(), f)
    expect(r.items).toHaveLength(4)
  })
})

describe('redactSecrets', () => {
  test('replaces every occurrence and ignores empty secrets', () => {
    expect(redactSecrets('a SECRET b SECRET', ['SECRET', undefined, ''])).toBe(
      'a [REDACTED] b [REDACTED]',
    )
  })
})

describe('debug logging never contains keys', () => {
  test('log sink receives no key material across a full fallback run', async () => {
    const logged: string[] = []
    const f = fakeFetch(
      [
        [
          'https://gw.test',
          () =>
            new Response(JSON.stringify({ error: 'invalid_key', message: 'bad' }), { status: 401 }),
        ],
        ['https://api.tavily.com', () => new Response('nope', { status: 400 })],
        [
          'https://api.search.brave.com',
          () => new Response(JSON.stringify({ web: { results: [] } })),
        ],
      ],
      [],
    )
    const r = await runSearchChain(
      REQ,
      config({
        hosted: { url: 'https://gw.test', key: HOSTED_KEY },
        tavilyKey: TAVILY_KEY,
        braveKey: BRAVE_KEY,
      }),
      f,
      (m) => logged.push(m),
    )
    expect(r.backend).toBe('Brave Search')
    const all = logged.join('\n')
    expect(all).toContain('hosted zy-search')
    for (const k of [HOSTED_KEY, TAVILY_KEY, BRAVE_KEY]) {
      expect(all).not.toContain(k)
    }
  })
})
