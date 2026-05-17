/**
 * 目标驱动模式状态管理。
 * 参考 src/proactive/index.ts 的模块级状态 + 订阅者模式。
 */
import { getTotalInputTokens, getTotalOutputTokens, getTotalCost } from '../cost-tracker.js'

let _goalActive = false
let _goalPaused = false
let _goalDescription = ''
let _turnCount = 0
let _startTime = 0
let _startInputTokens = 0
let _startOutputTokens = 0
let _startCost = 0
const _subscribers: Array<() => void> = []

export interface GoalSnapshot {
  active: boolean
  paused: boolean
  description: string
  turnCount: number
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  costUSD: number
}

/** 激活目标模式 */
export function activateGoal(description: string): void {
  _goalActive = true
  _goalPaused = false
  _goalDescription = description
  _turnCount = 0
  _startTime = Date.now()
  _startInputTokens = getTotalInputTokens()
  _startOutputTokens = getTotalOutputTokens()
  _startCost = getTotalCost()
  _notifySubscribers()
}

/** 停用目标模式 */
export function deactivateGoal(): void {
  _goalActive = false
  _goalPaused = false
  _goalDescription = ''
  _notifySubscribers()
}

/** 暂停目标模式（保留状态，临时静默） */
export function pauseGoal(): void {
  _goalPaused = true
}

/** 恢复之前暂停的目标模式 */
export function resumeGoal(): void {
  _goalPaused = false
}

/** 目标模式是否激活 */
export function isGoalActive(): boolean {
  return _goalActive
}

/** 目标模式是否暂停 */
export function isGoalPaused(): boolean {
  return _goalPaused
}

/** 递增目标轮次计数 */
export function incrementGoalTurn(): void {
  _turnCount++
}

/** 获取目标模式完整快照 */
export function getGoalState(): GoalSnapshot {
  return {
    active: _goalActive,
    paused: _goalPaused,
    description: _goalDescription,
    turnCount: _turnCount,
    elapsedMs: _goalActive ? Date.now() - _startTime : 0,
    inputTokens: getTotalInputTokens() - _startInputTokens,
    outputTokens: getTotalOutputTokens() - _startOutputTokens,
    costUSD: getTotalCost() - _startCost,
  }
}

/** 订阅目标模式状态变化 */
export function subscribeToGoalChanges(callback: () => void): () => void {
  _subscribers.push(callback)
  return () => {
    const index = _subscribers.indexOf(callback)
    if (index > -1) {
      _subscribers.splice(index, 1)
    }
  }
}

function _notifySubscribers(): void {
  _subscribers.forEach((cb) => cb())
}
