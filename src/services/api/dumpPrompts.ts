import type { ClientOptions } from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { getZyConfigHomeDir, isInternalBuild } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// 为 ant 用户缓存最近几次 API 请求（例如用于 /issue 命令）
const MAX_CACHED_REQUESTS = 5
const cachedApiRequests: Array<{ timestamp: string; request: unknown }> = []

type DumpState = {
  initialized: boolean
  messageCountSeen: number
  lastInitDataHash: string
  // 变更检测的廉价代理 — 当 model/tools/system
  // 与上次调用结构相同时跳过昂贵的 stringify+hash。
  lastInitFingerprint: string
}

// 按会话跟踪状态，避免重复数据
const dumpState = new Map<string, DumpState>()

export function getLastApiRequests(): Array<{
  timestamp: string
  request: unknown
}> {
  return [...cachedApiRequests]
}

export function clearApiRequestCache(): void {
  cachedApiRequests.length = 0
}

export function clearDumpState(agentIdOrSessionId: string): void {
  dumpState.delete(agentIdOrSessionId)
}

export function clearAllDumpState(): void {
  dumpState.clear()
}

export function addApiRequestToCache(requestData: unknown): void {
  if (!isInternalBuild()) return
  cachedApiRequests.push({
    timestamp: new Date().toISOString(),
    request: requestData,
  })
  if (cachedApiRequests.length > MAX_CACHED_REQUESTS) {
    cachedApiRequests.shift()
  }
}

export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  return join(
    getZyConfigHomeDir(),
    'dump-prompts',
    `${agentIdOrSessionId ?? getSessionId()}.jsonl`,
  )
}

function appendToFile(filePath: string, entries: string[]): void {
  if (entries.length === 0) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, entries.join('\n') + '\n'))
    .catch(() => {})
}

function initFingerprint(req: Record<string, unknown>): string {
  const tools = req.tools as Array<{ name?: string }> | undefined
  const system = req.system as unknown[] | string | undefined
  const sysLen =
    typeof system === 'string'
      ? system.length
      : Array.isArray(system)
        ? system.reduce(
            (n: number, b) => n + ((b as { text?: string }).text?.length ?? 0),
            0,
          )
        : 0
  const toolNames = tools?.map(t => t.name ?? '').join(',') ?? ''
  return `${req.model}|${toolNames}|${sysLen}`
}

function dumpRequest(
  body: string,
  ts: string,
  state: DumpState,
  filePath: string,
): void {
  try {
    const req = jsonParse(body) as Record<string, unknown>
    addApiRequestToCache(req)

    if (!isInternalBuild()) return
    const entries: string[] = []
    const messages = (req.messages ?? []) as Array<{ role?: string }>

    // 在首次请求时写入初始化数据（system、tools、metadata），
    // 并在变更时写入 system_update 条目。
    // 先做廉价指纹检测：system+tools 在回合间不会变化，
    // 因此当结构未变时跳过 300ms 的 stringify。
    const fingerprint = initFingerprint(req)
    if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
      const { messages: _, ...initData } = req
      const initDataStr = jsonStringify(initData)
      const initDataHash = hashString(initDataStr)
      state.lastInitFingerprint = fingerprint
      if (!state.initialized) {
        state.initialized = true
        state.lastInitDataHash = initDataHash
        // 复用 initDataStr 而非在包装器中重新序列化 initData。
        // toISOString() 的时间戳不包含需要 JSON 转义的字符。
        entries.push(
          `{"type":"init","timestamp":"${ts}","data":${initDataStr}}`,
        )
      } else if (initDataHash !== state.lastInitDataHash) {
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"system_update","timestamp":"${ts}","data":${initDataStr}}`,
        )
      }
    }

    // 仅写入新的用户消息（助手消息在响应中捕获）
    for (const msg of messages.slice(state.messageCountSeen)) {
      if (msg.role === 'user') {
        entries.push(
          jsonStringify({ type: 'message', timestamp: ts, data: msg }),
        )
      }
    }
    state.messageCountSeen = messages.length

    appendToFile(filePath, entries)
  } catch {
    // 忽略解析错误
  }
}

export function createDumpPromptsFetch(
  agentIdOrSessionId: string,
): ClientOptions['fetch'] {
  const filePath = getDumpPromptsPath(agentIdOrSessionId)

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const state = dumpState.get(agentIdOrSessionId) ?? {
      initialized: false,
      messageCountSeen: 0,
      lastInitDataHash: '',
      lastInitFingerprint: '',
    }
    dumpState.set(agentIdOrSessionId, state)

    let timestamp: string | undefined

    if (init?.method === 'POST' && init.body) {
      timestamp = new Date().toISOString()
      // 解析 + 序列化请求（系统提示 + 工具 schema = MB 级）
      // 需要数百毫秒。延迟执行以免阻塞实际 API 调用 —
      // 这是 /issue 的调试工具，不在关键路径上。
      setImmediate(dumpRequest, init.body as string, timestamp, state, filePath)
    }

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const response = await globalThis.fetch(input, init)

    // 异步保存响应
    if (timestamp && response.ok && isInternalBuild()) {
      const cloned = response.clone()
      void (async () => {
        try {
          const isStreaming = cloned.headers
            .get('content-type')
            ?.includes('text/event-stream')

          let data: unknown
          if (isStreaming && cloned.body) {
            // 将 SSE 流解析为数据块
            const reader = cloned.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
              }
            } finally {
              reader.releaseLock()
            }
            const chunks: unknown[] = []
            for (const event of buffer.split('\n\n')) {
              for (const line of event.split('\n')) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    chunks.push(jsonParse(line.slice(6)))
                  } catch {
                    // 忽略解析错误
                  }
                }
              }
            }
            data = { stream: true, chunks }
          } else {
            data = await cloned.json()
          }

          await fs.appendFile(
            filePath,
            jsonStringify({ type: 'response', timestamp, data }) + '\n',
          )
        } catch {
          // 尽力而为
        }
      })()
    }

    return response
  }
}
