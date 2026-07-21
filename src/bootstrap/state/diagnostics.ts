// diagnostics 领域的运行时状态访问器。

import { isInternalBuild } from '../../services/infra/envUtils.js'
import { STATE } from './core.js'

// 慢速操作追踪，用于 dev bar
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (!isInternalBuild()) {
    return
  }
  // 跳过编辑器会话的追踪（用户在 $EDITOR 中编辑提示文件）
  // 这些是有意慢速的，因为用户在起草文本
  if (operation.includes('exec') && operation.includes('zy-prompt-')) {
    return
  }
  const now = Date.now()
  // 移除过期的操作
  STATE.slowOperations = STATE.slowOperations.filter(
    (op) => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // 添加新操作
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // 仅保留最近的操作
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // 最常见的情况：没有追踪任何内容。返回稳定引用，使
  // 调用者的 setState() 可以通过 Object.is 跳过，而不是以 2fps 重新渲染。
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // 仅在有操作真正过期时才分配新数组；否则在
  // 操作仍然新鲜时保持引用稳定。
  if (STATE.slowOperations.some((op) => now - op.timestamp >= SLOW_OPERATION_TTL_MS)) {
    STATE.slowOperations = STATE.slowOperations.filter(
      (op) => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // 可以直接返回：addSlowOperation() 在推入前重新赋值 STATE.slowOperations，
  // 因此 React 状态持有的数组永远不会被修改。
  return STATE.slowOperations
}
