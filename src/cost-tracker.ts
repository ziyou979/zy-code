import chalk from 'chalk'
import type { ModelUsage } from 'src/types/index.js'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import { tSync } from './i18n/index.js'
import { stringWidth } from './ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './services/analytics/index.js'
import type { TokenUsage as Usage } from './types/llm.js'
import { getAdvisorUsage } from './utils/advisor.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './utils/config.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from './utils/context.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { calculateUSDCost, getCurrencySymbol } from './utils/modelCost.js'

export {
  addToTotalLinesChanged,
  formatCost,
  getModelUsage,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setHasUnknownModelCost,
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

/**
 * 从项目配置中获取指定会话的已存储费用状态。
 * 仅在会话 ID 匹配时返回费用数据，否则返回 undefined。
 * 用于在 saveCurrentSessionCosts() 覆盖配置之前读取费用数据。
 */
export function getStoredSessionCosts(sessionId: string): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // 仅在上次保存的是同一会话时返回费用数据
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  // 构建带上下文窗口的模型用量信息
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries: projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * 恢复会话时从项目配置还原费用状态。
 * 仅在会话 ID 与上次保存的会话匹配时才恢复。
 * @returns 如果费用状态已恢复则返回 true，否则返回 false
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * 将当前会话的费用数据保存到项目配置。
 * 在切换会话之前调用此方法，以避免丢失已累积的费用数据。
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig((current) => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUSD,
        },
      ]),
    ),
    lastSessionId: getSessionId(),
  }))
}

function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  const symbol = getCurrencySymbol()
  return `${symbol}${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

// 按显示宽度右填充（处理 CJK 双列宽字符）
const LABEL_COL_WIDTH = 23
function padToWidth(text: string, targetWidth: number): string {
  const w = stringWidth(text)
  return text + ' '.repeat(Math.max(1, targetWidth - w))
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return tSync('costTracker.usageEmpty')
  }

  // 按短名称累计用量
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = model
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  // 模型名称右对齐到 LABEL_COL_WIDTH
  let result = tSync('costTracker.usageByModel')
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    const label = `${shortName}:`
    const w = stringWidth(label)
    const paddedLabel = ' '.repeat(Math.max(0, LABEL_COL_WIDTH - w)) + label
    const usageString =
      `  ${formatNumber(usage.inputTokens)} ${tSync('costTracker.input')}, ` +
      `${formatNumber(usage.outputTokens)} ${tSync('costTracker.output')}, ` +
      `${formatNumber(usage.cacheReadInputTokens)} ${tSync('costTracker.cacheRead')}, ` +
      `${formatNumber(usage.cacheCreationInputTokens)} ${tSync('costTracker.cacheWrite')}` +
      (usage.webSearchRequests > 0
        ? `, ${formatNumber(usage.webSearchRequests)} ${tSync('costTracker.webSearch')}`
        : '') +
      ` (${formatCost(usage.costUSD)})`
    result += `\n${paddedLabel}${usageString}`
  }
  return result
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost() ? ` ${tSync('costTracker.costsMayBeInaccurate')}` : '')

  const modelUsageDisplay = formatModelUsage()

  const linesAdded = getTotalLinesAdded()
  const linesRemoved = getTotalLinesRemoved()

  const labelCost = `${tSync('costTracker.totalCost')}:`
  const labelApi = `${tSync('costTracker.totalDurationApi')}:`
  const labelWall = `${tSync('costTracker.totalDurationWall')}:`
  const labelCode = `${tSync('costTracker.totalCodeChanges')}:`

  return chalk.dim(
    `${padToWidth(labelCost, LABEL_COL_WIDTH)}${costDisplay}\n` +
      `${padToWidth(labelApi, LABEL_COL_WIDTH)}${formatDuration(getTotalAPIDuration())}\n` +
      `${padToWidth(labelWall, LABEL_COL_WIDTH)}${formatDuration(getTotalDuration())}\n` +
      `${padToWidth(labelCode, LABEL_COL_WIDTH)}${tSync(linesAdded === 1 ? 'costTracker.lineAdded' : 'costTracker.linesAdded', { count: linesAdded })}, ${tSync(linesRemoved === 1 ? 'costTracker.lineRemoved' : 'costTracker.linesRemoved', { count: linesRemoved })}\n` +
      `${modelUsageDisplay}`,
  )
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

function addToTotalModelUsage(cost: number, usage: Usage, model: string): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.inputTokens
  modelUsage.outputTokens += usage.outputTokens
  modelUsage.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  modelUsage.webSearchRequests += (usage as any).server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model)
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(cost: number, usage: Usage, model: string): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs = { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.inputTokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.outputTokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cacheReadInputTokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cacheCreationInputTokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('zy_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.inputTokens,
      output_tokens: advisorUsage.outputTokens,
      cache_read_input_tokens: advisorUsage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: advisorUsage.cacheCreationInputTokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(advisorCost, advisorUsage, advisorUsage.model)
  }
  return totalCost
}
