import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  fetchProviderModels,
  resolveDefaultModelsUrl,
} from '../../../src/services/model/fetchProviderModels.js'

describe('fetchProviderModels', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('方舟目录中的模型能力不会在归一化列表时丢失', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'doubao-seed-2-1-pro-260915',
                modalities: { input_modalities: ['text', 'image'] },
                token_limits: { context_window: 1048576, max_reasoning_token_length: 262144 },
                features: { structured_outputs: { json_schema: true } },
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch
    const result = await fetchProviderModels({ provider: 'ark' })
    if (result.status !== 'success') throw new Error('模型查询失败')
    expect(result.models[0]?.capability).toEqual({
      capabilities: {
        input: ['text', 'image'],
        thinking: { effort: ['on'] },
        structured_outputs: true,
      },
      tokens: { contextWindow: 1048576, maxThinkingTokens: 262144 },
    })
  })

  test('resolveDefaultModelsUrl 正确推导各平台默认模型查询地址', () => {
    expect(resolveDefaultModelsUrl('openai')).toBe('https://api.openai.com/v1/models')
    expect(resolveDefaultModelsUrl('deepseek')).toBe('https://api.deepseek.com/models')
    expect(resolveDefaultModelsUrl('openrouter')).toBe('https://openrouter.ai/api/v1/models')
    expect(resolveDefaultModelsUrl('siliconflow')).toBe('https://api.siliconflow.cn/v1/models')
    expect(resolveDefaultModelsUrl('ant-ling')).toBe('https://api.ant-ling.com/v1/models')
    expect(resolveDefaultModelsUrl('ollama')).toBe('http://localhost:11434/api/tags')
    expect(resolveDefaultModelsUrl('anthropic')).toBe('https://api.anthropic.com/v1/models')

    // 自定义 baseUrl
    expect(resolveDefaultModelsUrl('generic', 'http://localhost:8000/v1')).toBe(
      'http://localhost:8000/v1/models',
    )
    expect(resolveDefaultModelsUrl('generic', 'http://localhost:8000')).toBe(
      'http://localhost:8000/models',
    )
    expect(resolveDefaultModelsUrl('ollama', 'http://192.168.1.10:11434/')).toBe(
      'http://192.168.1.10:11434/api/tags',
    )
    expect(resolveDefaultModelsUrl('generic', 'https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/models',
    )
    expect(
      resolveDefaultModelsUrl('vertex', 'https://aiplatform.googleapis.com/v1beta1', 'google'),
    ).toBe('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100')
    expect(
      resolveDefaultModelsUrl(
        'vertex',
        'https://aiplatform.googleapis.com/v1beta1',
        'google',
        'eu',
      ),
    ).toBe('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100')
    expect(
      resolveDefaultModelsUrl(
        'vertex',
        'https://aiplatform.googleapis.com/v1beta1',
        'google',
        'us-central1',
      ),
    ).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100',
    )
    // 双协议平台传入内置 anthropic 端点时，仍推导至官方模型目录而非 404 的 /anthropic/v1/models
    expect(
      resolveDefaultModelsUrl('mimo', 'https://api.xiaomimimo.com/anthropic', 'anthropic'),
    ).toBe('https://api.xiaomimimo.com/v1/models')
    expect(resolveDefaultModelsUrl('kimi', 'https://api.moonshot.cn/anthropic', 'anthropic')).toBe(
      'https://api.moonshot.cn/v1/models',
    )
    expect(
      resolveDefaultModelsUrl('minimax', 'https://api.minimaxi.com/anthropic', 'anthropic'),
    ).toBe('https://api.minimaxi.com/v1/models')
    expect(
      resolveDefaultModelsUrl(
        'tencent',
        'https://api.lkeap.cloud.tencent.com/coding/anthropic',
        'anthropic',
      ),
    ).toBe('https://api.lkeap.cloud.tencent.com/v1/models')
    expect(
      resolveDefaultModelsUrl('zhipu', 'https://open.bigmodel.cn/api/anthropic', 'anthropic'),
    ).toBe('https://open.bigmodel.cn/api/paas/v4/models')
    expect(resolveDefaultModelsUrl('github-copilot')).toBe(
      'https://api.individual.githubcopilot.com/models',
    )
    expect(
      resolveDefaultModelsUrl(
        'bedrock',
        'https://bedrock-runtime.us-east-1.amazonaws.com',
        'anthropic',
      ),
    ).toBeNull()
    expect(
      resolveDefaultModelsUrl(
        'gemini-oauth',
        'https://cloudcode-pa.googleapis.com/v1internal',
        'google',
      ),
    ).toBeNull()
  })

  test('正确解析 OpenAI 兼容规范的模型列表，并过滤掉官方非对话模型', async () => {
    const mockData = {
      object: 'list',
      data: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'text-embedding-3-small' }, // 应被官方过滤
        { id: 'whisper-1' }, // 应被官方过滤
        { id: 'o3-mini', description: 'Fast reasoning model' },
      ],
    }

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') throw new Error('模型查询失败')
    expect(result.models.map((m) => m.id)).toEqual(['gpt-4o', 'o3-mini'])
    expect(result.models[1].description).toBe('Fast reasoning model')
  })

  test('正确解析 Ollama 原生 /api/tags 格式并提取模型大小', async () => {
    const mockData = {
      models: [
        { name: 'qwen2.5-coder:7b', size: 4700000000 },
        { model: 'deepseek-r1:14b', size: 9000000000 },
      ],
    }

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') throw new Error('模型查询失败')
    expect(result.models).toHaveLength(2)
    expect(result.models[0].id).toBe('qwen2.5-coder:7b')
    expect(result.models[0].description).toBe('4.4 GB')
    expect(result.models[1].id).toBe('deepseek-r1:14b')
  })

  test('使用自定义 modelsUrl 时优先请求该地址', async () => {
    let requestedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({ data: [{ id: 'custom-model-1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      provider: 'generic',
      baseUrl: 'http://localhost:8000/v1',
      modelsUrl: 'http://localhost:8000/api/available-models',
    })

    expect(requestedUrl).toBe('http://localhost:8000/api/available-models')
    expect(result.status).toBe('success')
    if (result.status !== 'success') throw new Error('模型查询失败')
    expect(result.models).toHaveLength(1)
    expect(result.models[0].id).toBe('custom-model-1')
  })

  test('HTTP 错误返回明确状态，不伪装成空目录', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Not Found', { status: 404 })
    }) as unknown as typeof fetch

    const models = await fetchProviderModels({
      provider: 'generic',
      baseUrl: 'http://localhost:9999/v1',
    })

    expect(models).toEqual({ status: 'unavailable', reason: 'http', httpStatus: 404 })
  })

  test('每次查询更新目录，新增和下线模型不会被进程缓存掩盖', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      return new Response(
        JSON.stringify({ data: [{ id: callCount === 1 ? 'old-model' : 'Ling-3.1-flash' }] }),
        {
          status: 200,
        },
      )
    }) as unknown as typeof fetch

    const first = await fetchProviderModels({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-12345678',
    })
    const second = await fetchProviderModels({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-12345678',
    })

    expect(callCount).toBe(2)
    expect(first).toEqual({ status: 'success', models: [{ id: 'old-model', label: 'old-model' }] })
    expect(second).toEqual({
      status: 'success',
      models: [{ id: 'Ling-3.1-flash', label: 'Ling-3.1-flash' }],
    })
  })

  test('认证失败后可使用更新的凭证重新查询', async () => {
    const keys: string[] = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Authorization') ?? '')
      return keys.length === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: 'Ling-3.1-flash' }] }))
    }) as unknown as typeof fetch
    expect(await fetchProviderModels({ provider: 'ant-ling', apiKey: 'old-key' })).toEqual({
      status: 'unavailable',
      reason: 'authentication',
      httpStatus: 401,
    })
    const fresh = await fetchProviderModels({ provider: 'ant-ling', apiKey: 'new-key' })
    expect(fresh.status).toBe('success')
    expect(keys).toEqual(['Bearer old-key', 'Bearer new-key'])
  })

  test('空目录、不支持查询和无效响应具有不同状态', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] })),
    ) as unknown as typeof fetch
    expect(await fetchProviderModels({ provider: 'ant-ling' })).toEqual({
      status: 'success',
      models: [],
    })
    expect(await fetchProviderModels({ provider: 'generic' })).toEqual({
      status: 'unavailable',
      reason: 'unsupported',
    })
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ unexpected: [] })),
    ) as unknown as typeof fetch
    expect(await fetchProviderModels({ provider: 'ant-ling' })).toEqual({
      status: 'unavailable',
      reason: 'invalid-response',
    })
  })

  test('Google 目录过滤非生成模型并移除 models 前缀', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/live-model',
                displayName: 'Live Model',
                supportedGenerationMethods: ['generateContent'],
              },
              { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
        ),
    ) as unknown as typeof fetch
    const result = await fetchProviderModels({ provider: 'gemini' })
    expect(result).toEqual({
      status: 'success',
      models: [{ id: 'live-model', label: 'Live Model' }],
    })
  })

  test('Vertex publisherModels 列表过滤非对话模型并移除 publishers/google/models 前缀', async () => {
    let requestedUrl = ''
    let authHeader = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url)
      authHeader = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(
        JSON.stringify({
          publisherModels: [
            { name: 'publishers/google/models/gemini-2.5-pro', launchStage: 'GA' },
            { name: 'publishers/google/models/gemini-3.5-flash', launchStage: 'GA' },
            { name: 'publishers/google/models/gemini-embedding-2', launchStage: 'GA' },
            { name: 'publishers/google/models/gemini-2.5-flash-tts', launchStage: 'GA' },
            { name: 'publishers/google/models/gemini-3-pro-image', launchStage: 'GA' },
            { name: 'publishers/google/models/textembedding-gecko', launchStage: 'GA' },
          ],
        }),
      )
    }) as unknown as typeof fetch

    const result = await fetchProviderModels({
      provider: 'vertex',
      apiFormat: 'google',
      baseUrl: 'https://aiplatform.googleapis.com/v1beta1',
      location: 'global',
      getHeaders: async () => ({ Authorization: 'Bearer adc-token' }),
    })

    expect(requestedUrl).toBe(
      'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100',
    )
    expect(authHeader).toBe('Bearer adc-token')
    expect(result).toEqual({
      status: 'success',
      models: [
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
        { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash' },
      ],
    })
  })

  test('OpenRouter 排除无文本输出的模型并按大小写去重', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'text-model', architecture: { output_modalities: ['text'] } },
              { id: 'TEXT-MODEL' },
              { id: 'image-model', architecture: { output_modalities: ['image'] } },
            ],
          }),
        ),
    ) as unknown as typeof fetch
    const result = await fetchProviderModels({ provider: 'openrouter' })
    expect(result).toEqual({
      status: 'success',
      models: [{ id: 'text-model', label: 'text-model' }],
    })
  })

  test('超时与调用方取消分开处理', async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason)
        else
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }) as unknown as typeof fetch
    expect(await fetchProviderModels({ provider: 'ant-ling', timeoutMs: 5 })).toEqual({
      status: 'unavailable',
      reason: 'timeout',
    })
    const controller = new AbortController()
    controller.abort()
    expect(await fetchProviderModels({ provider: 'ant-ling', signal: controller.signal })).toEqual({
      status: 'unavailable',
      reason: 'cancelled',
    })
  })
})
