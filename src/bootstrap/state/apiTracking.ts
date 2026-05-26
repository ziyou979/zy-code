// API 请求追踪：lastMainRequestId / lastApiCompletionTimestamp / pendingPostCompaction /
// lastAPIRequest / lastAPIRequestMessages / lastClassifierRequests。

import type { CreateParams } from '../../types/llm.js'
import { STATE } from './_core.js'

export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** 标记压缩刚刚发生。下一次 API 成功事件将
 *  包含 isPostCompaction=true，然后标志自动重置。 */
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/** 消费压缩后标志。压缩后返回一次 true，
 *  然后返回 false 直到下次压缩。 */
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

export function setLastAPIRequest(params: Omit<CreateParams, 'messages'> | null): void {
  STATE.lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<CreateParams, 'messages'> | null {
  return STATE.lastAPIRequest
}

export function setLastAPIRequestMessages(messages: CreateParams['messages'] | null): void {
  STATE.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages(): CreateParams['messages'] | null {
  return STATE.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}
