import { updateSessionWireId } from '../services/session/concurrentSessions.js'
import type { ReplWireHandle } from './replBridge.js'
import { toCompatSessionId } from './sessionIdCompat.js'
/**
 * 指向活跃 REPL bridge handle 的全局引用，使 useReplBridge React tree 外的调用方
 *（工具、slash command）也能调用 subscribePR 等 handle 方法。采用与 bridgeDebug.ts
 * 相同的单进程单 bridge 设计：handle 闭包捕获创建会话时的 sessionId 与
 * getAccessToken；若按 BriefTool/upload.ts 的模式各自重新推导，可能导致 staging/prod
 * token 不一致。
 *
 * useReplBridge.tsx 初始化完成后设置，teardown 时清除。
 */

let handle: ReplWireHandle | null = null

export function setReplWireHandle(h: ReplWireHandle | null): void {
  handle = h
  // 在会话记录中发布或清除自身 bridge session ID，使其他本地 peer 能将当前会话从
  // bridge 列表中去重；本地会话优先。
  void updateSessionWireId(getSelfWireCompatId() ?? null).catch(() => {})
}

export function getReplWireHandle(): ReplWireHandle | null {
  return handle
}

/**
 * 返回自身 bridge session ID，并转换为 API 在 /v1/sessions 响应中使用的
 * session_* 兼容格式；bridge 未连接时返回 undefined。
 */
export function getSelfWireCompatId(): string | undefined {
  const h = getReplWireHandle()
  return h ? toCompatSessionId(h.bridgeSessionId) : undefined
}
