// Session metadata 持久化 / 恢复：标题、标签、PR 链接、agent 名称色、模式、worktree 状态。
// 所有 save* 通过 updateSessionSidecar 写入 sidecar <sessionId>.meta.json（原子整体覆写,
// 不再追加到 JSONL）；getCurrentSession* 读 Project 单例缓存。

import type { UUID } from 'node:crypto'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getSessionId } from '../../bootstrap/runtime/runtimeContext.js'
import { type SessionId } from '../../types/ids.js'
import { type PersistedWorktreeSession } from '../../types/logs.js'
import { updateSessionName } from '../session/concurrentSessions.js'
import { getTranscriptPathForSession } from './paths.js'
import { getProject } from './project.js'
import { updateSessionSidecar } from './sessionSidecar.js'

/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  // 如果未提供 fullPath 则回退到计算的路径
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  updateSessionSidecar(resolvedPath, { customTitle })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
  logEvent('zy_session_renamed', {
    source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 将 AI 生成的标题作为独立的 `ai-title` entry 持久化到 JSONL。
 *
 * 写入单独的 entry 类型（而非复用 `custom-title`）是承重的：
 * - 读取优先级：读取器优先使用 `customTitle` 字段而非 `aiTitle`，
 *   因此用户重命名始终优先，无论追加顺序。
 * - 恢复安全性：`loadTranscriptFile` 仅从 `custom-title` entry 填充
 *   `customTitles` Map，因此 `restoreSessionMetadata` 永不缓存 AI 标题，
 *   `reAppendSessionMetadata` 永不在 EOF 重新追加 AI 标题 — 避免了
 *   恢复时过时 AI 标题覆盖 session 中用户重命名的 bug。
 * - CAS 语义：VS Code 的 `onlyIfNoCustomTitle` 检查仅扫描
 *   `customTitle` 字段，因此 AI 可覆盖自己之前的 AI 标题但永不覆盖用户标题。
 * - 指标：AI 标题不触发 `zy_session_renamed`。
 *
 * 因为该 entry 永不被重新追加，一旦积累足够消息就会滚出 64KB
 * 尾部窗口。读取器（`readLiteMetadata`、`listSessionsImpl`、
 * VS Code `fetchSessions`）在这种情况下回退到扫描头部缓冲区的
 * `aiTitle`。头部和尾部读取都是有界的（各 64KB，通过
 * `extractLastJsonStringField`），永不全量扫描。
 *
 * 具有过时写入守卫的调用者（例如 VS Code 客户端）应优先
 * 向 SDK 控制请求传递 `persist: false`，并在守卫通过后通过
 * 自己的重命名路径持久化，以避免 AI 标题在飞行中的用户重命名
 * 之后落地的竞争。
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  updateSessionSidecar(getTranscriptPathForSession(sessionId), { aiTitle })
}

/**
 * 为 `zy ps` 追加周期性任务摘要。与 ai-title 不同，这不会被
 * reAppendSessionMetadata 重新追加 — 它是代理当前正在做什么的滚动快照，
 * 因此过时是可以接受的；ps 从尾部读取最新的。
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  updateSessionSidecar(getTranscriptPathForSession(sessionId), {
    taskSummary: { summary, timestamp: new Date().toISOString() },
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // 如果未提供 fullPath 则回退到计算的路径
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  updateSessionSidecar(resolvedPath, { tag })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
  logEvent('zy_session_tagged', {})
}

/**
 * 将 session 链接到 GitHub pull request。
 * 存储 PR 编号、URL 和仓库，用于跟踪和导航。
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  updateSessionSidecar(resolvedPath, {
    prLink: { prNumber, prUrl, prRepository, timestamp: new Date().toISOString() },
  })
  // 为当前 session 缓存，以便 reAppendSessionMetadata 可在压缩后重写
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
  logEvent('zy_session_linked_to_pr', { prNumber })
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // 仅返回当前 session 的标签（我们唯一缓存的）
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(sessionId: SessionId): string | undefined {
  // 仅返回当前 session 的标题（我们唯一缓存的）
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * 恢复时将 session metadata 还原到内存缓存中。
 * 填充缓存使 metadata 可用于显示（例如代理横幅），
 * 并在 session 退出时通过 reAppendSessionMetadata 重新追加。
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  permissionMode?: string
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const project = getProject()
  // ??= 使 --name（cacheSessionTitle）优先于恢复的 session 标题。
  // REPL.tsx 在调用前清除，因此 /resume 不受影响。
  if (meta.customTitle) {
    project.currentSessionTitle ??= meta.customTitle
  }
  if (meta.tag !== undefined) {
    project.currentSessionTag = meta.tag || undefined
  }
  if (meta.agentName) {
    project.currentSessionAgentName = meta.agentName
  }
  if (meta.agentColor) {
    project.currentSessionAgentColor = meta.agentColor
  }
  if (meta.agentSetting) {
    project.currentSessionAgentSetting = meta.agentSetting
  }
  if (meta.mode) {
    project.currentSessionMode = meta.mode
  }
  if (meta.permissionMode !== undefined) {
    project.currentSessionPermissionMode = meta.permissionMode
  }
  if (meta.worktreeSession !== undefined) {
    project.currentSessionWorktree = meta.worktreeSession
  }
  if (meta.prNumber !== undefined) {
    project.currentSessionPrNumber = meta.prNumber
  }
  if (meta.prUrl) {
    project.currentSessionPrUrl = meta.prUrl
  }
  if (meta.prRepository) {
    project.currentSessionPrRepository = meta.prRepository
  }
}

/**
 * 清除所有缓存的 session metadata（标题、标签、代理名称/颜色）。
 * 当 /clear 创建新 session 时调用，以防止前一个 session 的
 * 过时 metadata 泄漏到新 session 中。
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionPermissionMode = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * 将缓存的 session metadata（自定义标题、标签）重新追加到 transcript
 * 文件末尾。在压缩后调用此函数以使 metadata 保持在 readLiteMetadata
 * 在渐进加载时读取的 16KB 尾部窗口内。否则，足够多的压缩后消息会将
 * metadata entry 推出窗口，导致 `--resume` 显示自动生成的 firstPrompt
 * 而非用户设置的 session 名称。
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  updateSessionSidecar(resolvedPath, { agentName })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
  logEvent('zy_agent_name_set', {
    source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function saveAgentColor(sessionId: UUID, agentColor: string, fullPath?: string) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  updateSessionSidecar(resolvedPath, { agentColor })
  // 仅为当前 session 缓存（用于即时可见性）
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
  logEvent('zy_agent_color_set', {})
}

/**
 * 缓存 session 代理设置。由 materializeSessionFile 在首条用户消息时写入磁盘，
 * 并在退出时由 reAppendSessionMetadata 重新标记。
 * 此处仅缓存以避免在启动时创建仅含 metadata 的 session 文件。
 */
export function saveAgentSetting(agentSetting: string): void {
  const project = getProject()
  project.currentSessionAgentSetting = agentSetting
  // 文件已存在则立即落 sidecar;否则 materializeSessionFile 会通过
  // reAppendSessionMetadata(flushSidecar) 在首条消息时写入。
  if (project.sessionFile) {
    updateSessionSidecar(project.sessionFile, { agentSetting })
  }
}

/**
 * 缓存启动时设置的 session 标题（--name）。由 materializeSessionFile
 * 在首条用户消息时写入磁盘。此处仅缓存，以在 session ID 确定之前
 * 不创建孤立的仅含 metadata 的文件。
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * 缓存 session 模式。由 materializeSessionFile 在首条用户消息时写入磁盘，
 * 并在退出时由 reAppendSessionMetadata 重新标记。
 * 此处仅缓存以避免在启动时创建仅含 metadata 的 session 文件。
 */
export function saveMode(mode: 'coordinator' | 'normal'): void {
  const project = getProject()
  project.currentSessionMode = mode
  if (project.sessionFile) {
    updateSessionSidecar(project.sessionFile, { mode })
  }
}

export function savePermissionMode(mode: string): void {
  const project = getProject()
  project.currentSessionPermissionMode = mode
  if (project.sessionFile) {
    updateSessionSidecar(project.sessionFile, { permissionMode: mode })
  }
}

/**
 * 记录 session 的 worktree 状态用于 --resume。由 materializeSessionFile
 * 在首条用户消息时写入磁盘，并在退出时由 reAppendSessionMetadata 重新标记。
 * 退出 worktree 时传入 null，以便 --resume 知道不要 cd 回去。
 */
export function saveWorktreeState(worktreeSession: PersistedWorktreeSession | null): void {
  // 剥离调用者可能通过完整 WorktreeSession 对象传递的临时字段
  // （creationDurationMs, usedSparsePaths）— TypeScript 结构类型允许这样做，
  // 但我们不希望它们被序列化到 transcript 中。
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // 当文件已存在时急切写入（session 中进入/退出）。
  // 对于 --worktree 启动，sessionFile 为 null — materializeSessionFile
  // 将在首条消息时通过 reAppendSessionMetadata 写入。
  // stripped 可为 null（已退出 worktree）— updateSessionSidecar 会保留该 null。
  if (project.sessionFile) {
    updateSessionSidecar(project.sessionFile, { worktreeState: stripped })
  }
}
