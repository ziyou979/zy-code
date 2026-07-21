// 会话级可变元数据的 sidecar 存储。
//
// 历史上 custom-title / last-prompt / tag / mode / agent-* / pr-link / worktree-state
// 这些「会话级、last-wins、可变」字段被写进只追加的 .jsonl,为了让 64KB 尾读取
// (readLiteMetadata) 能找到它们,reAppendSessionMetadata 在多个生命周期点反复追加到
// EOF —— 导致同一文件出现大量重复行。把它们移到一个原子整体覆写的 sidecar
// `<sessionId>.meta.json`,既根除重复,也让尾读取退化为 O(1) 读小文件。

import { mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { isSessionPersistenceDisabled } from '../../bootstrap/runtime/runtimeContext.js'
import type { PersistedWorktreeSession } from '../../types/logs.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../../services/infra/file.js'
import { getSessionMetadataPathFromTranscriptPath } from './paths.js'

const SIDECAR_VERSION = 1 as const

export type SessionSidecarPrLink = {
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
}

export type SessionSidecarTaskSummary = {
  summary: string
  timestamp: string
}

export type SessionSidecarMetadata = {
  version: typeof SIDECAR_VERSION
  sessionId: string
  customTitle?: string
  aiTitle?: string
  lastPrompt?: string
  taskSummary?: SessionSidecarTaskSummary
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  prLink?: SessionSidecarPrLink
  mode?: 'coordinator' | 'normal'
  // undefined = 从未进入 worktree;null = 已显式退出(保留三态语义)
  worktreeState?: PersistedWorktreeSession | null
}

export type SessionSidecarPatch = Partial<Omit<SessionSidecarMetadata, 'version' | 'sessionId'>>

function extractSessionId(transcriptPath: string): string {
  // Windows 路径使用反斜杠，不能只用 lastIndexOf('/')，否则 base 会变成完整路径。
  const base = basename(transcriptPath)
  return base.replace(/\.jsonl$/, '').replace(/\.meta\.json$/, '')
}

function parseSidecar(raw: string, path: string): SessionSidecarMetadata | null {
  try {
    const parsed = JSON.parse(raw) as SessionSidecarMetadata
    // 未知版本 → 视为缺失,让调用方回退到 JSONL 派生逻辑
    if (parsed?.version !== SIDECAR_VERSION) {
      return null
    }
    // 修复旧版本在 Windows 上写入的错误 sessionId（完整路径而非 UUID）。
    // sidecar 文件名与 transcript 文件名同名，sessionId 必须以文件名为权威来源。
    const expectedSessionId = extractSessionId(path)
    if (parsed.sessionId !== expectedSessionId) {
      parsed.sessionId = expectedSessionId
    }
    return parsed
  } catch (e) {
    logForDebugging(`sessionSidecar parse failed: ${path}: ${String(e)}`)
    return null
  }
}

export function readSessionSidecar(transcriptPath: string): SessionSidecarMetadata | null {
  const path = getSessionMetadataPathFromTranscriptPath(transcriptPath)
  try {
    return parseSidecar(readFileSync(path, 'utf-8'), path)
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    logForDebugging(`readSessionSidecar failed: ${path}: ${String(e)}`)
    return null
  }
}

export async function readSessionSidecarAsync(
  transcriptPath: string,
): Promise<SessionSidecarMetadata | null> {
  const path = getSessionMetadataPathFromTranscriptPath(transcriptPath)
  try {
    return parseSidecar(await readFile(path, 'utf-8'), path)
  } catch (e) {
    if (isFsInaccessible(e)) {
      return null
    }
    logForDebugging(`readSessionSidecarAsync failed: ${path}: ${String(e)}`)
    return null
  }
}

export function writeSessionSidecar(transcriptPath: string, data: SessionSidecarMetadata): void {
  if (isSessionPersistenceDisabled()) {
    return
  }
  const path = getSessionMetadataPathFromTranscriptPath(transcriptPath)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // 目录已存在或不可创建 — 让下面的写入决定成败
  }
  try {
    writeFileSyncAndFlush_DEPRECATED(path, JSON.stringify(data), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch (e) {
    logForDebugging(`writeSessionSidecar failed: ${path}: ${String(e)}`)
  }
}

/**
 * 读-合并-原子写。patch 里 `undefined` 的键跳过(不清除已有值);
 * 显式 `null`(worktreeState 表示已退出)会被保留写入。
 */
export function updateSessionSidecar(transcriptPath: string, patch: SessionSidecarPatch): void {
  if (isSessionPersistenceDisabled()) {
    return
  }
  const existing = readSessionSidecar(transcriptPath)
  // sessionId 必须以文件名派生：sidecar 文件名与 transcript 文件名同名，
  // 老版本在 Windows 上把完整路径写进 sessionId，这里覆盖修复。
  const derivedSessionId = extractSessionId(transcriptPath)
  const next: SessionSidecarMetadata = existing
    ? { ...existing, version: SIDECAR_VERSION, sessionId: derivedSessionId }
    : { version: SIDECAR_VERSION, sessionId: derivedSessionId }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue
    }
    ;(next as Record<string, unknown>)[key] = value
  }
  writeSessionSidecar(transcriptPath, next)
}
