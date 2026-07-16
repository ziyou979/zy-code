import chalk from 'chalk'
import type { ModelUsage } from 'src/types/index.js'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getModelUsage,
  getTotalCost,
  getTotalCostByCurrency,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { getCostCounter, getTokenCounter } from 'src/bootstrap/runtime/runtimeContext.js'
import { getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalDuration,
  getTotalToolDuration,
} from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalWebSearchRequests,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { resetStateForTests } from 'src/bootstrap/runtime/runtimeContext.js'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../utils/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import type { TokenUsage as Usage } from '../../types/llm.js'
import type { Message } from '../../types/message.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from '../config/config.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../../utils/context.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { SYNTHETIC_MODEL } from '../messages/constants.js'
import { calculateCost, getCurrencySymbol, getModelCurrency } from '../model/modelCost.js'

export {
  addToTotalLinesChanged,
  formatCost,
  getModelUsage,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalCostByCurrency,
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
  totalCost: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  totalCostByCurrency?: Record<string, number>
}

function normalizeUsage(usage: Usage): Usage {
  return {
    ...usage,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
  }
}

function getWebSearchRequestsFromUsage(usage: Usage): number {
  return usage.extras?.webSearchRequests ?? 0
}

function createEmptyStoredCostState(): StoredCostState {
  return {
    totalCost: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    lastDuration: undefined,
    modelUsage: {},
    totalCostByCurrency: { CNY: 0, USD: 0 },
  }
}

function addUsageToStoredCostState(state: StoredCostState, model: string, rawUsage: Usage): void {
  const usage = normalizeUsage(rawUsage)
  const cost = calculateCost(model, usage)
  const currency = getModelCurrency(model)
  const modelUsage = state.modelUsage ?? {}
  const current = modelUsage[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    cost: 0,
    currency,
    contextWindow: getContextWindowForModel(model),
    maxOutputTokens: getModelMaxOutputTokens(model).default,
  }

  current.inputTokens += usage.inputTokens
  current.outputTokens += usage.outputTokens
  current.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
  current.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
  current.webSearchRequests += getWebSearchRequestsFromUsage(usage)
  current.cost += cost
  current.currency = currency
  current.contextWindow = getContextWindowForModel(model)
  current.maxOutputTokens = getModelMaxOutputTokens(model).default
  modelUsage[model] = current
  state.modelUsage = modelUsage

  state.totalCost += cost
  state.totalCostByCurrency ??= { CNY: 0, USD: 0 }
  state.totalCostByCurrency[currency] = (state.totalCostByCurrency[currency] ?? 0) + cost
}

/**
 * 从 transcript 中的 assistant usage 重建费用状态。
 * 这是 sessionCosts 缓存缺失时的兜底，避免 /resume 后状态栏计费从零重新开始。
 */
export function reconstructCostStateFromMessages(
  messages: readonly Message[],
): StoredCostState | undefined {
  const state = createEmptyStoredCostState()
  let hasUsage = false

  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue
    }
    const usage = message.message.usage
    const model = message.message.model
    if (!usage || !model || model === SYNTHETIC_MODEL) {
      continue
    }
    hasUsage = true
    addUsageToStoredCostState(state, model, usage)
  }

  return hasUsage ? state : undefined
}

export function getRestorableSessionCosts(
  sessionId: string,
  messages?: readonly Message[],
): StoredCostState | undefined {
  return (
    getStoredSessionCosts(sessionId) ??
    (messages ? reconstructCostStateFromMessages(messages) : undefined)
  )
}

/**
 * 从项目配置中获取指定会话的已存储费用状态。
 * 优先从 sessionCosts[sessionId] 读取（多会话存储），fallback 到旧的 lastSessionId 匹配逻辑。
 * 用于在 saveCurrentSessionCosts() 覆盖配置之前读取费用数据。
 */
export function getStoredSessionCosts(sessionId: string): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // 优先从多会话存储中读取
  const stored = projectConfig.sessionCosts?.[sessionId]
  if (stored) {
    return {
      ...stored,
      modelUsage: stored.lastModelUsage
        ? Object.fromEntries(
            Object.entries(stored.lastModelUsage).map(([model, usage]) => [
              model,
              {
                ...usage,
                currency: usage.currency ?? 'CNY',
                contextWindow: getContextWindowForModel(model),
                maxOutputTokens: getModelMaxOutputTokens(model).default,
              },
            ]),
          )
        : undefined,
    }
  }

  // fallback：旧的单会话存储逻辑（向后兼容）
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
          currency: usage.currency ?? 'CNY',
          contextWindow: getContextWindowForModel(model),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCost: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries: projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
    // 旧数据没有 totalCostByCurrency，回退到 CNY（历史默认）
    totalCostByCurrency: { CNY: projectConfig.lastCost ?? 0, USD: 0 },
  }
}

/**
 * 恢复会话时从项目配置还原费用状态。
 * 仅在会话 ID 与上次保存的会话匹配时才恢复。
 * @returns 如果费用状态已恢复则返回 true，否则返回 false
 */
export function restoreCostStateForSession(
  sessionId: string,
  messages?: readonly Message[],
): boolean {
  const data = getRestorableSessionCosts(sessionId, messages)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/** sessionCosts 最大存储会话数，防止配置文件无限膨胀 */
const MAX_SESSION_COSTS = 20

/**
 * 将当前会话的费用数据保存到项目配置。
 * 同时写入 sessionCosts[sessionId]（多会话存储）和旧的 lastCost/lastSessionId（向后兼容）。
 * 在切换会话之前调用此方法，以避免丢失已累积的费用数据。
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  const sessionId = getSessionId()
  const modelUsageData = Object.fromEntries(
    Object.entries(getModelUsage()).map(([model, usage]) => [
      model,
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        cost: usage.cost,
      },
    ]),
  )

  saveCurrentProjectConfig((current) => {
    // 写入多会话存储，超出上限时淘汰最旧的条目
    const sessionCosts = { ...(current.sessionCosts ?? {}) }
    sessionCosts[sessionId] = {
      totalCost: getTotalCost(),
      totalAPIDuration: getTotalAPIDuration(),
      totalAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
      totalToolDuration: getTotalToolDuration(),
      totalLinesAdded: getTotalLinesAdded(),
      totalLinesRemoved: getTotalLinesRemoved(),
      lastDuration: getTotalDuration(),
      lastModelUsage: modelUsageData,
      totalCostByCurrency: getTotalCostByCurrency(),
    }
    // 淘汰超出上限的旧条目（按写入顺序，删除最早的）
    const keys = Object.keys(sessionCosts)
    while (keys.length > MAX_SESSION_COSTS) {
      delete sessionCosts[keys.shift()!]
    }

    return {
      ...current,
      lastCost: getTotalCost(),
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
      lastModelUsage: modelUsageData,
      lastSessionId: sessionId,
      sessionCosts,
    }
  })
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
        cost: 0,
        currency: 'CNY',
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
    accumulated.cost += usage.cost
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
      ` (${formatCost(usage.cost)})`
    result += `\n${paddedLabel}${usageString}`
  }
  return result
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCost()) +
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

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
  currency: string = 'CNY',
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    cost: 0,
    currency: 'CNY' as const,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.inputTokens
  modelUsage.outputTokens += usage.outputTokens
  modelUsage.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
  modelUsage.webSearchRequests += usage.extras?.webSearchRequests ?? 0
  modelUsage.cost += cost
  modelUsage.currency = currency
  modelUsage.contextWindow = getContextWindowForModel(model)
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
  currency: string = 'CNY',
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model, currency)
  addToTotalCostState(cost, modelUsage, model, currency)

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

  return cost
}
