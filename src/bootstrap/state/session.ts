// 会话标识与工作目录。
// 含 sessionId / parentSessionId / sessionProjectDir / originalCwd / projectRoot / cwd /
// directConnectServerUrl 等会话级标识字段。
// session 切换 signal 在 _core.ts 中创建，本模块仅在 switchSession 中调用 emit。

import type { SessionId } from 'src/types/ids.js'
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { createSessionId } from 'src/utils/uuid.js'
import { emitSessionSwitched, STATE } from './_core.js'

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(options: { setCurrentAsParent?: boolean } = {}): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 移除传出会话的计划 slug 条目，防止 Map
  // 积累过期 key。需要在 clearConversation 之前读取的调用者
  //（如 REPL.tsx clearContext）在此调用前获取 slug。
  STATE.planSlugCache.delete(STATE.sessionId)
  // 重新生成的会话留在当前项目中：重置 projectDir 为
  // null，使 getTranscriptPath() 从 originalCwd 推导。
  STATE.sessionId = createSessionId()
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子性地切换活跃会话。`sessionId` 和 `sessionProjectDir`
 * 始终一起变更 — 没有单独的 setter，因此它们不会
 * 不同步（CC-34）。
 *
 * @param projectDir — 包含 `<sessionId>.jsonl` 的目录。省略（或
 *   传 `null`）表示当前项目中的会话 — 路径将在读取时从
 *   originalCwd 推导。当会话位于不同项目目录时
 *   传 `dirname(transcriptPath)`（git worktree、跨项目恢复）。
 *   每次调用都会重置项目目录，不会从前一个会话继承。
 */
export function switchSession(sessionId: SessionId, projectDir: string | null = null): void {
  // 移除传出会话的计划 slug 条目，使 Map 在
  // 重复 /resume 时保持有界。只有当前会话的 slug 会被读取
  //（plans.ts getPlanSlug 默认为 getSessionId()）。
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  emitSessionSwitched(sessionId)
}

/**
 * 当前会话转录所在的项目目录，如果
 * 会话是在当前项目中创建的（常见情况 — 从
 * originalCwd 推导）则为 `null`。参见 `switchSession()`。
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录。
 * 与 getOriginalCwd() 不同，它永远不会被会话中的 EnterWorktreeTool 更新
 *（因此技能/历史记录在进入一次性 worktree 时保持稳定）。
 * 启动时由 --worktree 设置，因为该 worktree 就是会话的项目。
 * 用于项目标识（历史记录、技能、会话），而非文件操作。
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * 仅用于 --worktree 启动标志。会话中的 EnterWorktreeTool 绝不能
 * 调用此函数 — 技能/历史记录应锚定在会话启动的位置。
 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

export function getCwdState(): string {
  return STATE.cwd
}

export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}
