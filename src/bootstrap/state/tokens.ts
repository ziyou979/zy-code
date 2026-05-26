// Token 计数与轮次预算。
// 三个原模块本地变量（outputTokensAtTurnStart / currentTurnTokenBudget /
// budgetContinuationCount）已迁入 STATE，避免 _core ↔ tokens 循环依赖，
// 同时让 resetStateForTests 通过 getInitialState() 一并清零。

import sumBy from 'lodash-es/sumBy.js'
import { STATE } from './_core.js'

export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - STATE.outputTokensAtTurnStart
}

export function getCurrentTurnTokenBudget(): number | null {
  return STATE.currentTurnTokenBudget
}

export function snapshotOutputTokensForTurn(budget: number | null): void {
  STATE.outputTokensAtTurnStart = getTotalOutputTokens()
  STATE.currentTurnTokenBudget = budget
  STATE.budgetContinuationCount = 0
}

export function getBudgetContinuationCount(): number {
  return STATE.budgetContinuationCount
}

export function incrementBudgetContinuationCount(): void {
  STATE.budgetContinuationCount++
}
