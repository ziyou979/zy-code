const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')

const apiKey = process.env.ZY_API_KEY
const model = process.env.MODEL ?? 'deepseek-v4-flash'

if (!apiKey) {
  console.error('缺少 API Key，请设置 ZY_API_KEY、OPENAI_API_KEY 或 LLM_API_KEY。')
  process.exit(1)
}

const endpoint = `${baseUrl}/chat/completions`
const titleSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short session title.',
    },
  },
  required: ['title'],
  additionalProperties: false,
}

const baseMessages = [
  {
    role: 'system',
    content: [
      {
        type: 'text',
        text: 'Return a compact JSON object with one field named title.',
      },
    ],
  },
  {
    role: 'user',
    content:
      '<conversation><user>分析一下这个请求为什么 400，可以写个简单的测试脚本调用一下</user></conversation>',
  },
]

const jsonSchemaFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'response',
    schema: titleSchema,
    strict: true,
  },
}

const cases = [
  {
    name: 'baseline-disabled-thinking',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 512,
      thinking: { type: 'disabled' },
    },
  },
  {
    name: 'json-schema-disabled-thinking',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      response_format: jsonSchemaFormat,
    },
  },
  {
    name: 'json-schema-stream-disabled-thinking',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      response_format: jsonSchemaFormat,
    },
  },
  {
    name: 'dashboard-like-title-request',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 8000,
      temperature: 1,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
      response_format: jsonSchemaFormat,
    },
  },
  {
    name: 'dashboard-like-without-effort',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 8000,
      temperature: 1,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      response_format: jsonSchemaFormat,
    },
  },
  {
    name: 'json-object-stream-disabled-thinking',
    body: {
      model,
      messages: baseMessages,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    },
  },
]

for (const item of cases) {
  const startedAt = Date.now()
  console.log(`\n=== ${item.name} ===`)
  console.log(
    JSON.stringify({
      model: item.body.model,
      stream: item.body.stream === true,
      thinking: item.body.thinking,
      responseFormat: item.body.response_format?.type ?? null,
      hasOutputConfig: item.body.output_config != null,
    }),
  )

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(item.body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    const elapsedMs = Date.now() - startedAt

    console.log(`status=${response.status} elapsedMs=${elapsedMs}`)
    console.log(text.slice(0, 2000))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`request_error=${message}`)
  }
}
