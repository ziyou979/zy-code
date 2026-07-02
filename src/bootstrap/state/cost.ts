// 成本与代码行数累计。
// 含 totalCost / modelUsage 写入入口 / 代码行数 / unknown model cost 标志 /
// 会话恢复时的成本回灌 / 测试相关的部分重置。

import type { ModelUsage } from 'src/types/index.js'
import { DEFAULT_CURRENCY } from '../../types/currency.js'
import { STATE } from './_core.js'

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
  currency: string = DEFAULT_CURRENCY,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCost += cost
  STATE.totalCostByCurrency[currency] = (STATE.totalCostByCurrency[currency] ?? 0) + cost
}

export function getTotalCost(): number {
  return STATE.totalCost
}

/**
 * 获取按币种分别累计的费用。
 * 用于 statusline 等展示层按币种分别显示。
 */
export function getTotalCostByCurrency(): Record<string, number> {
  return STATE.totalCostByCurrency
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/**
 * /clear 等场景调用：把当前会话的成本/时长/行数/usage/promptId 清零，
 * 但不动 session id 等会话级标识。
 */
export function resetCostState(): void {
  STATE.totalCost = 0
  STATE.totalCostByCurrency = { CNY: 0, USD: 0 }
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * 设置会话恢复的成本状态值。
 * 由 cost-tracker.ts 中的 restoreCostStateForSession 调用。
 */
export function setCostStateForRestore({
  totalCost,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
  totalCostByCurrency,
}: {
  totalCost: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  totalCostByCurrency?: Record<string, number>
}): void {
  STATE.totalCost = totalCost
  STATE.totalCostByCurrency = totalCostByCurrency ?? { CNY: totalCost, USD: 0 }
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复每个模型的使用明细
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整 startTime 使累计时长正确累加
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

/**
 * 测试专用：清空 totalAPIDuration / totalAPIDurationWithoutRetries / totalCost。
 * 与 resetCostState 区别：本函数仅供测试用，原 state.ts 暴露的精简版。
 */
export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCost = 0
}
