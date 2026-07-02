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
  EFFORT_BALANCED,
  EFFORT_EXTREME,
  EFFORT_LIGHT,
  EFFORT_OFF,
  EFFORT_ON,
  EFFORT_QUICK,
  EFFORT_THOROUGH,
  EFFORT_ULTRA,
  FORK_GLYPH,
} from '../../constants/figures.js'
import {
  getTotalAPIDuration,
  getTotalCost,
  getTotalCostByCurrency,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../../cost-tracker.js'
import { tSync } from '../../i18n/index.js'
import type { ModelName } from '../../services/model/model.js'
import type { Message } from '../../types/message.js'
import { calculateContextPercentages, getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { getDisplayedEffortLevel, modelSupportsEffort } from '../../utils/effort.js'
import { formatTokens } from '../../utils/format.js'
import { getCurrentUsage } from '../../utils/tokens.js'
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
  off: EFFORT_OFF,
  on: EFFORT_ON,
  quick: EFFORT_QUICK,
  light: EFFORT_LIGHT,
  balanced: EFFORT_BALANCED,
  thorough: EFFORT_THOROUGH,
  extreme: EFFORT_EXTREME,
  ultra: EFFORT_ULTRA,
  orchestrate: EFFORT_EXTREME,
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
    if (ctx.thinkingEnabled && modelSupportsEffort(ctx.mainLoopModel)) {
      const level = getDisplayedEffortLevel(ctx.mainLoopModel, ctx.effortValue as never)
      const effortGlyph = EFFORT_ICONS[level] ?? EFFORT_BALANCED
      const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.balanced'
      const levelName = tSync(i18nKey as never)
      const body = `${ctx.mainLoopModel} · ${effortGlyph} ${levelName}`
      return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
    }
    return { text: withIcon(icon, String(ctx.mainLoopModel)), colorToken: effectiveColor(module) }
  },

  context(module, ctx) {
    const icon = effectiveIcon(module)
    const currentUsage = getCurrentUsage(ctx.messages)
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
    if ((costsByCurrency.USD ?? 0) > 0) parts.push(`$${costsByCurrency.USD.toFixed(2)}`)
    if ((costsByCurrency.CNY ?? 0) > 0) parts.push(`¥${costsByCurrency.CNY.toFixed(2)}`)
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
