import { describe, expect, test } from 'bun:test'

import {
  redactSecrets,
  resolveWebSearchConfig,
  runSearchChain,
  type ResolvedWebSearchConfig,
  type SearchRequest,
} from '../../src/tools/WebSearchTool/searchBackends.js'

const HOSTED_KEY = 'zys_hostedKeyhostedKeyhostedKeyhostedKey1234567'

const REQ: SearchRequest = { query: 'bun test', maxResults: 5 }

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
    expect(c.hostedMisconfigured).toBeUndefined()
  })

  test('ignores third-party search API keys entirely', () => {
    const c = resolveWebSearchConfig({ TAVILY_API_KEY: 'tvly-x', BRAVE_SEARCH_API_KEY: 'BSA-x' }, {
      tavilyApiKey: 'tvly-y',
      braveApiKey: 'BSA-y',
    } as never)
    expect(Object.keys(c).sort()).toEqual(['openserpUrl'])
  })

  test('env overrides settings; hosted needs both URL and key', () => {
    const c = resolveWebSearchConfig(
      {
        ZY_SEARCH_URL: 'https://env.example/',
        ZY_SEARCH_KEY: HOSTED_KEY,
      },
      { hostedUrl: 'https://settings.example', hostedKey: 'zys_other' },
    )
    expect(c.hosted).toEqual({ url: 'https://env.example', key: HOSTED_KEY })

    const fromSettings = resolveWebSearchConfig(
      {},
      { hostedUrl: 'https://settings.example/', hostedKey: HOSTED_KEY },
    )
    expect(fromSettings.hosted).toEqual({ url: 'https://settings.example', key: HOSTED_KEY })

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
      config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }),
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

  test('hosted quota error ends the chain with a clear error, without long waits', async () => {
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
      ],
      calls,
    )
    const started = Date.now()
    let message = ''
    try {
      await runSearchChain(REQ, config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }), f)
    } catch (e) {
      message = (e as Error).message
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect(message).toContain('No web search backend is available')
    expect(message).toContain('Daily quota of 100 searches used up.')
    expect(calls.filter((c) => c.url.startsWith('https://gw.test'))).toHaveLength(1)
    // Only local OpenSERP and the user's own gateway are ever contacted.
    for (const c of calls) {
      expect(c.url.startsWith('http://127.0.0.1:7000') || c.url.startsWith('https://gw.test')).toBe(
        true,
      )
    }
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
        ['https://gw.test', () => new Response(openSerpBody(1))],
      ],
      calls,
    )
    const r = await runSearchChain(
      REQ,
      config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }),
      f,
    )
    expect(r.backend).toBe('hosted zy-search')
  })

  test('nothing available → clear error naming OpenSERP and the hosted gateway, no keys leaked', async () => {
    const f = fakeFetch(
      [
        // A misbehaving gateway that echoes the key back in its error must not leak it.
        [
          'https://gw.test',
          () => {
            throw new Error(`boom ${HOSTED_KEY}`)
          },
        ],
      ],
      [],
    )
    let message = ''
    try {
      await runSearchChain(REQ, config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }), f)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('No web search backend is available')
    expect(message).toContain('local OpenSERP')
    expect(message).toContain('hosted zy-search')
    expect(message).toContain('ZY_OPENSERP_URL')
    expect(message).not.toContain(HOSTED_KEY)
    expect(message).toContain('[REDACTED]')
    expect(message).not.toMatch(/tavily|brave/i)
  })

  test('unconfigured gateway is named in the error hint', async () => {
    const f = fakeFetch([], [])
    let message = ''
    try {
      await runSearchChain(REQ, config(), f)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('ZY_SEARCH_URL')
    expect(message).toContain('ZY_SEARCH_KEY')
    expect(message).not.toMatch(/tavily|brave/i)
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
            new Response(JSON.stringify({ error: 'invalid_key', message: `bad ${HOSTED_KEY}` }), {
              status: 401,
            }),
        ],
      ],
      [],
    )
    await expect(
      runSearchChain(REQ, config({ hosted: { url: 'https://gw.test', key: HOSTED_KEY } }), f, (m) =>
        logged.push(m),
      ),
    ).rejects.toThrow('No web search backend is available')
    const all = logged.join('\n')
    expect(all).toContain('hosted zy-search')
    expect(all).not.toContain(HOSTED_KEY)
  })
})
