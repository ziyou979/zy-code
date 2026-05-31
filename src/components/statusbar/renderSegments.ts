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
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_MINIMAL,
  FORK_GLYPH,
} from '../../constants/figures.js'
import { getTotalCost, getTotalInputTokens, getTotalOutputTokens } from '../../cost-tracker.js'
import { tSync } from '../../i18n/index.js'
import type { ModelName } from '../../services/model/model.js'
import type { Message } from '../../types/message.js'
import { calculateContextPercentages, getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { getDisplayedEffortLevel } from '../../utils/effort.js'
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
  minimal: EFFORT_MINIMAL,
  low: EFFORT_LOW,
  medium: EFFORT_MEDIUM,
  high: EFFORT_HIGH,
  max: EFFORT_MAX,
}

const EFFORT_I18N_KEYS: Record<string, string> = {
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  max: 'effort.max',
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
    const level = getDisplayedEffortLevel(ctx.mainLoopModel, ctx.effortValue as never)
    if (ctx.thinkingEnabled) {
      const effortGlyph = EFFORT_ICONS[level] ?? EFFORT_MEDIUM
      const i18nKey = EFFORT_I18N_KEYS[level] ?? 'effort.medium'
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
    const bar = renderContextBar(percentages.used)
    // Dynamic color override: context warning levels take precedence over
    // user-configured color so the user notices when nearing the limit.
    const dynamicColor =
      percentages.used >= 75 ? 'error' : percentages.used >= 50 ? 'warning' : effectiveColor(module)
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
    const body = `↑ ${formatTokens(totalIn)}  ↓ ${formatTokens(totalOut)}`
    return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
  },

  cost(module) {
    const cost = getTotalCost()
    if (cost <= 0) {
      return null
    }
    const icon = effectiveIcon(module)
    // For currency icons (¥ $ € £) no space looks nicer: "¥0.42".
    // For non-currency overrides we keep the leading space via withIcon.
    const body = `${cost.toFixed(2)}`
    const text = icon ? `${icon}${body}` : body
    return { text, colorToken: effectiveColor(module) }
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
