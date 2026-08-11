import { createHash, randomUUID, type UUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import isPlainObject from 'lodash-es/isPlainObject.js'
import mapValues from 'lodash-es/mapValues.js'
import { addToTotalSessionCost } from 'src/services/cost/costTracker.js'
import { calculateCost, getModelCurrency } from 'src/services/model/modelCost.js'
import type { AssistantContentBlock } from '../types/llm.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../types/message.js'
import { getCwd } from '../services/environment/cwd.js'
import { env } from '../services/environment/env.js'
import { getZyConfigHomeDir, isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'
import { getErrnoCode } from '../utils/errors.js'
import { normalizeMessagesForAPI } from './messages/api.js'
import { jsonParse, jsonStringify } from '../services/infra/slowOperations.js'

function shouldUseVCR(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return true
  }

  if (isInternalBuild() && isEnvTruthy(process.env.FORCE_VCR)) {
    return true
  }

  return false
}

/**
 * 通用固定装置管理助手
 * 处理任意数据类型的缓存、读取、写入固定装置
 */
async function withFixture<T>(
  input: unknown,
  fixtureName: string,
  f: () => Promise<T>,
): Promise<T> {
  if (!shouldUseVCR()) {
    return await f()
  }

  // 为固定装置文件名创建输入哈希
  const hash = createHash('sha1').update(jsonStringify(input)).digest('hex').slice(0, 12)
  const filename = join(
    process.env.ZY_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${fixtureName}-${hash}.json`,
  )

  // 获取缓存的固定装置
  try {
    const cached = jsonParse(await readFile(filename, { encoding: 'utf8' })) as T
    return cached
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  if ((env.isCI || process.env.CI) && !isEnvTruthy(process.env.VCR_RECORD)) {
    throw new Error(
      `Fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result.`,
    )
  }

  // 创建并写入新固定装置
  const result = await f()

  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, jsonStringify(result, null, 2), {
    encoding: 'utf8',
  })

  return result
}

export async function withVCR(
  messages: Message[],
  f: () => Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]>,
): Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]> {
  if (!shouldUseVCR()) {
    return await f()
  }

  const messagesForAPI = normalizeMessagesForAPI(
    messages.filter((_) => {
      if (_.type !== 'user') {
        return true
      }
      if (_.isMeta) {
        return false
      }
      return true
    }),
  )

  const dehydratedInput = mapMessages(
    messagesForAPI.map((_) => _.message.content),
    dehydrateValue,
  )
  const filename = join(
    process.env.ZY_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${dehydratedInput.map((_) => createHash('sha1').update(jsonStringify(_)).digest('hex').slice(0, 6)).join('-')}.json`,
  )

  // 获取缓存的固定装置
  try {
    const cached = jsonParse(await readFile(filename, { encoding: 'utf8' })) as {
      output: (AssistantMessage | StreamEvent)[]
    }
    cached.output.forEach(addCachedCostToTotalSessionCost)
    return cached.output.map((message, index) =>
      mapMessage(message, hydrateValue, index, randomUUID()),
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  if (env.isCI && !isEnvTruthy(process.env.VCR_RECORD)) {
    throw new Error(
      `Anthropic API fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result. Input messages:\n${jsonStringify(dehydratedInput, null, 2)}`,
    )
  }

  // 创建并写入新固定装置
  const results = await f()
  if (env.isCI && !isEnvTruthy(process.env.VCR_RECORD)) {
    return results
  }

  await mkdir(dirname(filename), { recursive: true })
  await writeFile(
    filename,
    jsonStringify(
      {
        input: dehydratedInput,
        output: results.map((message, index) => mapMessage(message, dehydrateValue, index)),
      },
      null,
      2,
    ),
    { encoding: 'utf8' },
  )
  return results
}

function addCachedCostToTotalSessionCost(message: AssistantMessage | StreamEvent): void {
  if (message.type === 'stream_event') {
    return
  }
  const model = message.message.model ?? ''
  const usage = message.message.usage
  if (!usage) {
    return
  }
  const cost = calculateCost(model, usage)
  const currency = getModelCurrency(model)
  addToTotalSessionCost(cost, usage, model, currency)
}

function mapMessages(
  messages: (UserMessage | AssistantMessage)['message']['content'][],
  f: (s: unknown) => unknown,
): (UserMessage | AssistantMessage)['message']['content'][] {
  return messages.map((_) => {
    if (typeof _ === 'string') {
      return f(_)
    }
    return _.map((_) => {
      switch (_.type) {
        case 'tool_result':
          if (typeof _.content === 'string') {
            return { ..._, content: f(_.content) }
          }
          if (Array.isArray(_.content)) {
            return {
              ..._,
              content: _.content.map((_) => {
                switch (_.type) {
                  case 'text':
                    return { ..._, text: f(_.text) }
                  case 'image':
                    return _
                  default:
                    return undefined
                }
              }),
            }
          }
          return _
        case 'text':
          return { ..._, text: f(_.text) }
        case 'tool_call':
          return {
            ..._,
            input: mapValuesDeep(_.input as Record<string, unknown>, f),
          }
        case 'image':
          return _
        default:
          return undefined
      }
    })
  }) as (UserMessage | AssistantMessage)['message']['content'][]
}

function mapValuesDeep(
  obj: {
    [x: string]: unknown
  },
  f: (val: unknown, key: string, obj: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  return mapValues(obj, (val, key) => {
    if (Array.isArray(val)) {
      return val.map((_) => mapValuesDeep(_, f))
    }
    if (isPlainObject(val)) {
      return mapValuesDeep(val as Record<string, unknown>, f)
    }
    return f(val, key, obj)
  })
}

function mapAssistantMessage(
  message: AssistantMessage,
  f: (s: unknown) => unknown,
  index: number,
  uuid?: UUID,
): AssistantMessage {
  return {
    // 使用提供的 UUID（若给定，hydrate 路径用 randomUUID 生成全局唯一 ID），
    // 否则回退到基于索引的确定性 UUID（dehydrate/固定装置路径）。
    // sessionStorage.ts 按 UUID 去重消息，所以若 VCR 调用间 UUID 不唯一，
    // 恢复的会话会将不同响应视为重复。
    uuid: uuid ?? (`UUID-${index}` as unknown as UUID),
    requestId: 'REQUEST_ID',
    timestamp: message.timestamp,
    message: {
      ...message.message,
      content: (Array.isArray(message.message.content) ? message.message.content : [])
        .map((_) => {
          switch (_.type) {
            case 'text':
              return {
                ..._,
                text: f(_.text) as string,
              }
            case 'tool_call':
              return {
                ..._,
                input: mapValuesDeep(_.input as Record<string, unknown>, f),
              }
            default:
              return _ // Handle other block types unchanged
          }
        })
        .filter(Boolean) as AssistantContentBlock[],
    },
    type: 'assistant',
  }
}

function mapMessage(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent,
  f: (s: unknown) => unknown,
  index: number,
  uuid?: UUID,
): AssistantMessage | SystemAPIErrorMessage | StreamEvent {
  if (message.type === 'assistant') {
    return mapAssistantMessage(message, f, index, uuid)
  } else {
    return message
  }
}

function dehydrateValue(s: unknown): unknown {
  if (typeof s !== 'string') {
    return s
  }
  const cwd = getCwd()
  const configHome = getZyConfigHomeDir()
  let s1 = s
    .replace(/num_files="\d+"/g, 'num_files="[NUM]"')
    .replace(/duration_ms="\d+"/g, 'duration_ms="[DURATION]"')
    .replace(/cost_usd="\d+"/g, 'cost_usd="[COST]"')
    // 注意：我们有意不在这里将所有正斜杠替换为 path.sep。
    // 那会破坏类 XML 标签（例如 </system-reminder> -> <\system-reminder>）。
    // 下面的 [CONFIG_HOME] 和 [CWD] 替换处理路径归一化。
    .replaceAll(configHome, '[CONFIG_HOME]')
    .replaceAll(cwd, '[CWD]')
    .replace(/Available commands:.+/, 'Available commands: [COMMANDS]')
  // Windows 上路径可能以多种形式出现：
  // 1. 正斜杠变体（Git、某些 Node API）
  // 2. JSON 转义变体（序列化 JSON 中反斜杠加倍）
  if (process.platform === 'win32') {
    const cwdFwd = cwd.replaceAll('\\', '/')
    const configHomeFwd = configHome.replaceAll('\\', '/')
    // jsonStringify 转义 \ 为 \\ —— 匹配嵌入在 JSON 字符串中的路径
    const cwdJsonEscaped = jsonStringify(cwd).slice(1, -1)
    const configHomeJsonEscaped = jsonStringify(configHome).slice(1, -1)
    s1 = s1
      .replaceAll(cwdJsonEscaped, '[CWD]')
      .replaceAll(configHomeJsonEscaped, '[CONFIG_HOME]')
      .replaceAll(cwdFwd, '[CWD]')
      .replaceAll(configHomeFwd, '[CONFIG_HOME]')
  }
  // 在占位符后归一化反斜杠路径分隔符，使 VCR 固定装置
  // 哈希跨平台匹配（如 [CWD]\foo\bar -> [CWD]/foo/bar）
  // 同时处理单反斜杠和 JSON 转义双反斜杠 (\\)
  s1 = s1
    .replace(/\[CWD\][^\s"'<>]*/g, (match) => match.replaceAll('\\\\', '/').replaceAll('\\', '/'))
    .replace(/\[CONFIG_HOME\][^\s"'<>]*/g, (match) =>
      match.replaceAll('\\\\', '/').replaceAll('\\', '/'),
    )
  if (s1.includes('Files modified by user:')) {
    return 'Files modified by user: [FILES]'
  }
  return s1
}

function hydrateValue(s: unknown): unknown {
  if (typeof s !== 'string') {
    return s
  }
  return s
    .replaceAll('[NUM]', '1')
    .replaceAll('[DURATION]', '100')
    .replaceAll('[CONFIG_HOME]', getZyConfigHomeDir())
    .replaceAll('[CWD]', getCwd())
}

export async function* withStreamingVCR(
  messages: Message[],
  f: () => AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  if (!shouldUseVCR()) {
    return yield* f()
  }

  // Compute and yield messages
  const buffer: (StreamEvent | AssistantMessage | SystemAPIErrorMessage)[] = []

  // Record messages (or fetch from cache)
  const cachedBuffer = await withVCR(messages, async () => {
    for await (const message of f()) {
      buffer.push(message)
    }
    return buffer
  })

  if (cachedBuffer.length > 0) {
    yield* cachedBuffer
    return
  }

  yield* buffer
}

export async function withTokenCountVCR(
  messages: unknown[],
  tools: unknown[],
  f: () => Promise<number | null>,
): Promise<number | null> {
  // 脱水前先脱水以便哈希，使固定装置键能跨越 cwd/config-home/tempdir
  // 变化和消息 UUID/时间戳翻新而存活。系统提示词嵌入工作目录（原始形式
  // 和 auto-memory 路径中斜杠转短横线的项目 slug 两种形式），消息携带每次运行
  // 的新 UUID；没有这一步，每次测试运行都会产生新哈希，固定装置在 CI 中永远命中不了。
  const cwdSlug = getCwd().replace(/[^a-zA-Z0-9]/g, '-')
  const dehydrated = (dehydrateValue(jsonStringify({ messages, tools })) as string)
    .replaceAll(cwdSlug, '[CWD_SLUG]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '[TIMESTAMP]')
  const result = await withFixture(dehydrated, 'token-count', async () => ({
    tokenCount: await f(),
  }))
  return result.tokenCount
}
