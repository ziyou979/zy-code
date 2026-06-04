/**
 * Workflow Journal — agent() 调用的 append-only 缓存。
 * 用于 resumeFromRunId 断点续跑。
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getOriginalCwd, getSessionId } from '../../../bootstrap/state.js'
import { getProjectDir } from '../../../utils/sessionStorage.js'

// --- Journal 条目类型 ---

interface JournalStartedEntry {
  type: 'started'
  key: string
  agentId: string
}

interface JournalResultEntry {
  type: 'result'
  key: string
  agentId: string
  result: unknown
}

type JournalEntry = JournalStartedEntry | JournalResultEntry

// --- Journal 索引 ---

export interface JournalIndex {
  results: Map<string, { agentId: string; result: unknown }>
  started: Map<string, JournalStartedEntry[]>
}

// --- 缓存键计算 ---

/**
 * 从 opts 中提取影响缓存的白名单字段，稳定序列化。
 * 与逆向结果一致：仅 schema/model/isolation/agentType 参与键计算。
 */
function serializeOpts(opts: Record<string, unknown> | undefined): string {
  if (!opts) {
    return '{}'
  }
  const whitelist = ['schema', 'model', 'isolation', 'agentType']
  const filtered: Record<string, unknown> = {}
  for (const key of whitelist) {
    const val = opts[key]
    if (val === undefined || typeof val === 'function') {
      continue
    }
    filtered[key] = val
  }
  return JSON.stringify(sortKeys(filtered))
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys)
  }
  if (obj && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeys((obj as Record<string, unknown>)[k])
    }
    return sorted
  }
  return obj
}

/**
 * 链式哈希：key = sha256(prevKey ‖ prompt ‖ opts白名单)
 * 保证同一 prompt 在脚本不同位置产生不同 key。
 */
export function computeAgentKey(
  prompt: string,
  opts: Record<string, unknown> | undefined,
  prevKey: string,
): string {
  const hash = createHash('sha256')
    .update(prevKey)
    .update('\x00')
    .update(prompt)
    .update('\x00')
    .update(serializeOpts(opts))
    .digest('hex')
  return `v2:${hash}`
}

// --- Journal 目录 ---

function getJournalDir(runId: string): string {
  const sessionDir = join(getProjectDir(getOriginalCwd()), getSessionId())
  return join(sessionDir, 'subagents', 'workflows', runId)
}

// --- Journal 类 ---

export class WorkflowJournal {
  private readonly filePath: string
  private dirReady = false

  constructor(runId: string) {
    this.filePath = join(getJournalDir(runId), 'journal.jsonl')
  }

  async load(): Promise<JournalIndex> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf-8')
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { results: new Map(), started: new Map() }
      }
      throw err
    }

    const results = new Map<string, { agentId: string; result: unknown }>()
    const started = new Map<string, JournalStartedEntry[]>()

    for (const line of content.split('\n')) {
      if (!line) {
        continue
      }
      try {
        const entry: JournalEntry = JSON.parse(line)
        if (entry.type === 'result') {
          results.set(entry.key, { agentId: entry.agentId, result: entry.result })
        } else if (entry.type === 'started') {
          const arr = started.get(entry.key)
          if (arr) {
            arr.push(entry)
          } else {
            started.set(entry.key, [entry])
          }
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    return { results, started }
  }

  async appendStarted(key: string, agentId: string): Promise<void> {
    await this.ensureDir()
    const entry: JournalStartedEntry = { type: 'started', key, agentId }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8').catch(() => {})
  }

  async appendResult(key: string, agentId: string, result: unknown): Promise<void> {
    await this.ensureDir()
    const entry: JournalResultEntry = { type: 'result', key, agentId, result }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8').catch(() => {})
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return
    }
    await mkdir(join(this.filePath, '..'), { recursive: true })
    this.dirReady = true
  }
}
