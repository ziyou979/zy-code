// API 时长 + 工具时长 + 轮次内 hook/tool/classifier 时长与计数 + lastInteractionTime。
// addToTotalDurationState 写入 totalAPIDuration / totalAPIDurationWithoutRetries；
// 工具时长同时累计到轮次。
// updateLastInteractionTime / flushInteractionTime 把 Date.now() 调用延后到
// Ink 渲染前批量提交，避免每次按键都触发系统调用。

import { STATE } from './core.js'
export function addToTotalDurationState(duration: number, durationWithoutRetries: number): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

/**
 * 标记发生了一次交互。
 *
 * 默认情况下，实际的 Date.now() 调用会延迟到下一次 Ink 渲染
 * 帧（通过 flushInteractionTime()），这样我们可以避免在每次
 * 按键时都调用 Date.now()。
 *
 * 当从 React useEffect 回调或其他在 Ink 渲染周期之后
 * 运行的代码中调用时，传 `immediate = true`。
 * 否则时间戳会保持过期，直到下一次渲染，而如果用户空闲
 *（例如权限对话框等待输入），可能永远不会到来。
 */
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * 如果自上次刷新以来记录了交互，则立即更新时间戳。
 * 由 Ink 在每次渲染周期前调用，以便将多次按键批量处理为
 * 单次 Date.now() 调用。
 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}
