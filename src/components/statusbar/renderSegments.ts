/**
 * Module → segment renderer for the built-in status bar.
 *
 * Shared between BuiltInStatusBar (live rendering) and the /statusline
 * configuration dialog (preview). Each renderer takes a fully-resolved
 * (icon, color) pair plus the StatusbarContext and returns a Segment, or
 * null when the module has no data to display (e.g. tokens with 0 usage).
 */

import { basename } from 'node:path'
import {
  CIRCLE_ALL_BUT_UPPER_LEFT,
  CIRCLE_FILLED,
  CIRCLE_RIGHT_HALF,
  CIRCLE_UPPER_RIGHT,
  FORK_GLYPH,
  RADIO_OFF,
  RADIO_ON,
  SLASHED_CIRCLE,
} from '../../constants/figures.js'
import {
  getTotalAPIDuration,
  getTotalCost,
  getTotalCostByCurrency,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../services/cost/costTracker.js'
import { tSync } from '../../i18n/index.js'
import type { ModelName } from '../../services/model/model.js'
import type { Currency } from '../../types/currency.js'
import { CURRENCY_SYMBOLS, getCurrencySymbol } from '../../types/currency.js'
import type { Message } from '../../types/message.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
} from '../../services/context/modelContext.js'
import { getCwd } from '../../services/environment/cwd.js'
import { getDisplayedEffortLevel, modelSupportsEffort } from '../../services/effort/effort.js'
import { formatTokens } from '../../utils/format.js'
import { getDisplayContextUsage } from '../../services/api/tokens.js'
import {
  effectiveColor,
  effectiveIcon,
  type ModuleConfig,
  type ModuleId,
} from './statusbarModuleDefaults.js'

export type Segment = {
  text: string
  /** Theme token name (e.g. 'success', 'rainbow_blue_shimmer') */
  colorToken: string
}

/**
 * Context passed to renderers. The BuiltInStatusBar collects this once per
 * render; the preview component in /statusline dialog constructs an equivalent
 * snapshot so users see the real values they're configuring against.
 */
export type StatusbarContext = {
  messages: Message[]
  mainLoopModel: ModelName
  effortValue: unknown
  thinkingEnabled: boolean
  branch: string | null
  gitClean: boolean | null
  memoryRss: number
}

const BAR_WIDTH = 8

const EFFORT_ICONS: Record<string, string> = {
  off: SLASHED_CIRCLE,
  on: CIRCLE_RIGHT_HALF,
  quick: RADIO_OFF,
  light: CIRCLE_UPPER_RIGHT,
  balanced: CIRCLE_RIGHT_HALF,
  thorough: CIRCLE_ALL_BUT_UPPER_LEFT,
  extreme: CIRCLE_FILLED,
  ultra: RADIO_ON,
  orchestrate: CIRCLE_FILLED,
}

const EFFORT_I18N_KEYS: Record<string, string> = {
  off: 'effort.off',
  on: 'effort.on',
  quick: 'effort.quick',
  light: 'effort.light',
  balanced: 'effort.balanced',
  thorough: 'effort.thorough',
  extreme: 'effort.extreme',
  ultra: 'effort.ultra',
  orchestrate: 'effort.orchestrate',
}

function renderContextBar(percentage: number | null): string {
  if (percentage === null) {
    return ''
  }
  const clamped = Math.min(100, Math.max(0, percentage))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  return `${bar} ${clamped}%`
}

function formatMemory(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

function withIcon(icon: string, body: string): string {
  return icon ? `${icon} ${body}` : body
}

type Renderer = (module: ModuleConfig, ctx: StatusbarContext) => Segment | null

const RENDERERS: Record<ModuleId, Renderer> = {
  directory(module, ctx) {
    const icon = effectiveIcon(module)
    let body = basename(getCwd())
    if (ctx.branch) {
      body += ` · ${FORK_GLYPH} ${ctx.branch}`
      if (ctx.gitClean === true) {
        body += ' ✓'
      } else if (ctx.gitClean === false) {
        body += ' ●'
      }
    }
    return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
  },

  model(module, ctx) {
    const icon = effectiveIcon(module)
    // effort 强度仅在模型真正支持 effort 档位时显示(对齐 getModelEffortLevels
    // 这一单一事实源)。dashscope 的 qwen 等只支持 enable_thinking 开关、不支持
    // effort 强度的模型,即便 thinking 已开启也只显示模型名,不显示假的 high 档。
    // 不依赖 ctx.thinkingEnabled：effort 档位本身编码了 thinking 开关状态
    // （off=关闭, balanced=开启均衡等），单独 checking 会导致 thinkingEnabled
    // 因其他路径（如 /clear）变成 false 后 effort 被错误隐藏。
    if (modelSupportsEffort(ctx.mainLoopModel)) {
      const level = getDisplayedEffortLevel(ctx.mainLoopModel, ctx.effortValue as never)
      const effortGlyph = EFFORT_ICONS[level] ?? CIRCLE_RIGHT_HALF
      const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.balanced'
      const levelName = tSync(i18nKey as never)
      const body = `${ctx.mainLoopModel} · ${effortGlyph} ${levelName}`
      return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
    }
    return { text: withIcon(icon, String(ctx.mainLoopModel)), colorToken: effectiveColor(module) }
  },

  context(module, ctx) {
    const icon = effectiveIcon(module)
    // 必须用 getDisplayContextUsage：压缩后 full messages 仍含边界前旧 usage，
    // 直接 getCurrentUsage 会导致 statusline 比例「压缩后不变」。
    const currentUsage = getDisplayContextUsage(ctx.messages)
    const contextWindowSize = getContextWindowForModel(ctx.mainLoopModel)
    if (!currentUsage) {
      return {
        text: withIcon(icon, formatTokens(contextWindowSize)),
        colorToken: effectiveColor(module),
      }
    }
    const percentages = calculateContextPercentages(currentUsage, contextWindowSize)
    const usedTokens =
      currentUsage.inputTokens +
      currentUsage.cacheCreationInputTokens +
      currentUsage.cacheReadInputTokens
    const usedPct = percentages.used ?? 0
    const bar = renderContextBar(usedPct)
    // Dynamic color override: context warning levels take precedence over
    // user-configured color so the user notices when nearing the limit.
    const dynamicColor =
      usedPct >= 75 ? 'error' : usedPct >= 50 ? 'warning' : effectiveColor(module)
    return {
      text: withIcon(icon, `${formatTokens(usedTokens)}/${formatTokens(contextWindowSize)} ${bar}`),
      colorToken: dynamicColor,
    }
  },

  tokens(module) {
    const totalIn = getTotalInputTokens()
    const totalOut = getTotalOutputTokens()
    if (totalIn === 0 && totalOut === 0) {
      return null
    }
    const icon = effectiveIcon(module)
    let body = `↑ ${formatTokens(totalIn)}  ↓ ${formatTokens(totalOut)}`
    const durationMs = getTotalAPIDuration()
    if (totalOut > 0 && durationMs > 0) {
      const tps = totalOut / (durationMs / 1000)
      body += `  » ${tps >= 1000 ? `${(tps / 1000).toFixed(1)}k` : `${Math.round(tps)}`} tok/s`
    }
    return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
  },

  cost(module) {
    const costsByCurrency = getTotalCostByCurrency()
    const parts: string[] = []
    // 按金额降序排列，只显示已定义的货币种类
    const entries = Object.entries(costsByCurrency)
      .filter(([k, v]) => v > 0 && k in CURRENCY_SYMBOLS)
      .sort(([, a], [, b]) => b - a)
    for (const [currency, amount] of entries) {
      const symbol = getCurrencySymbol(currency as Currency)
      parts.push(`${symbol}${amount.toFixed(2)}`)
    }
    if (parts.length === 0) {
      return null
    }
    const body = parts.join('+')
    return { text: body, colorToken: effectiveColor(module) }
  },

  memory(module, ctx) {
    if (ctx.memoryRss <= 0) {
      return null
    }
    const icon = effectiveIcon(module)
    return {
      text: withIcon(icon, formatMemory(ctx.memoryRss)),
      colorToken: effectiveColor(module),
    }
  },
}

/**
 * Render the full segment list for the status bar given user-configured
 * modules. Returns segments in user-specified order; null entries (modules
 * with no data) are filtered out.
 */
export function renderStatusbarSegments(
  modules: readonly ModuleConfig[],
  ctx: StatusbarContext,
): Segment[] {
  const out: Segment[] = []
  for (const module of modules) {
    if (!module.visible) {
      continue
    }
    const renderer = RENDERERS[module.id]
    if (!renderer) {
      continue
    }
    const seg = renderer(module, ctx)
    if (seg) {
      out.push(seg)
    }
  }
  return out
}
