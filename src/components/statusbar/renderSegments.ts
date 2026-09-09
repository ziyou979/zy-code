/**
 * Module → segment renderer for the built-in status bar.
 *
 * Shared between BuiltInStatusBar (live rendering) and the /statusline
 * configuration dialog (preview). Each renderer takes a fully-resolved
 * (icon, color) pair plus the StatusbarContext and returns a Segment, or
 * null when the module has no data to display (e.g. tokens with 0 usage).
 */

import { basename } from 'node:path'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  CIRCLE_ALL_BUT_UPPER_LEFT,
  CIRCLE_FILLED,
  CIRCLE_RIGHT_HALF,
  CIRCLE_UPPER_RIGHT,
  FORK_GLYPH,
  RADIO_OFF,
  RADIO_ON,
  SLASHED_CIRCLE,
  TAU,
} from '../../constants/figures.js'
import { getAverageTTFTMs } from '../../bootstrap/runtime/runtimeContext.js'
import {
  getTotalAPIDuration,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalCostByCurrency,
  getTotalDecodeMs,
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
import { isHumanTurn } from '../../services/messages/messagePredicates.js'
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
  /** 每秒输出 token（null = 无解码数据可算） */
  tokensPerSecond: number | null
  /** 平均首 token 耗时 ms（null = 会话中还没有流式请求） */
  avgTTFTMs: number | null
}

/**
 * 汇总 speed 模块的读数。tok/s 只按解码时长（首 token 之后）计算，避免
 * TTFT/重试等待稀释读数；无解码记录时回退总 API 时长，保证非流式通道仍有参考值。
 */
export function collectTokenSpeed(): {
  tokensPerSecond: number | null
  avgTTFTMs: number | null
} {
  const totalOut = getTotalOutputTokens()
  const decodeMs = getTotalDecodeMs()
  const durationMs = decodeMs > 0 ? decodeMs : getTotalAPIDuration()
  const tokensPerSecond = totalOut > 0 && durationMs > 0 ? totalOut / (durationMs / 1000) : null
  return { tokensPerSecond, avgTTFTMs: getAverageTTFTMs() }
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

/** 会话轮数：human turn 计数（排除 meta/tool_result 派生的 user 消息）。 */
function countHumanTurns(messages: readonly Message[]): number {
  let n = 0
  for (const m of messages) {
    if (isHumanTurn(m)) {
      n++
    }
  }
  return n
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
    // 输入/输出分开统计：↑ 累计输入（含缓存读写），↓ 累计输出。
    // tok/s 拆到独立的 speed 模块，两者可分别配置显隐与位置。
    const body = `↑ ${formatTokens(totalIn)}  ↓ ${formatTokens(totalOut)}`
    return { text: withIcon(icon, body), colorToken: effectiveColor(module) }
  },

  cache(module) {
    const cacheRead = getTotalCacheReadInputTokens()
    const cacheCreation = getTotalCacheCreationInputTokens()
    // 完全没有缓存活动（provider 不支持 prompt cache / 会话刚开始）时不显示，
    // 避免用恒定的 0% 占据状态栏。
    if (cacheRead + cacheCreation === 0) {
      return null
    }
    // 总输入口径归一化：Anthropic 原生 input_tokens 不含缓存（缓存量在
    // cache_read/cache_creation 字段里），而 OpenAI/Google 的 prompt_tokens
    // 已含 cached_tokens。取 max(input, cacheRead + cacheCreation) 使两种口径
    // 都落在合理区间——OpenAI 侧不重复计入命中量，Anthropic 侧覆盖缓存主体，
    // 且命中率恒 <= 100%。
    const totalInput = Math.max(getTotalInputTokens(), cacheRead + cacheCreation)
    const hitRate = Math.round((cacheRead / totalInput) * 100)
    return {
      text: withIcon(effectiveIcon(module), `${hitRate}%`),
      colorToken: effectiveColor(module),
    }
  },

  speed(module, ctx) {
    const { tokensPerSecond, avgTTFTMs } = ctx
    if (tokensPerSecond === null && avgTTFTMs === null) {
      return null
    }
    const icon = effectiveIcon(module)
    const parts: string[] = []
    if (tokensPerSecond !== null) {
      parts.push(
        `» ${tokensPerSecond >= 1000 ? `${(tokensPerSecond / 1000).toFixed(1)}k` : `${Math.round(tokensPerSecond)}`} tok/s`,
      )
    }
    if (avgTTFTMs !== null) {
      // < 10s 显示小数秒（TTFT 常态在百毫秒级），更长时回退整秒
      parts.push(
        avgTTFTMs < 10_000
          ? `${TAU} ${tSync('statusline.ttft')} ${(avgTTFTMs / 1000).toFixed(1)}s`
          : `${TAU} ${tSync('statusline.ttft')} ${Math.round(avgTTFTMs / 1000)}s`,
      )
    }
    return { text: withIcon(icon, parts.join('  ')), colorToken: effectiveColor(module) }
  },

  turns(module, ctx) {
    // 会话轮数 = human turn 计数（压缩/resume 后随消息列表重建，口径与
    // plan-reminder 等一致）。0 表示会话还没有用户轮次，不显示。
    const turns = countHumanTurns(ctx.messages)
    if (turns === 0) {
      return null
    }
    const icon = effectiveIcon(module)
    return {
      text: withIcon(icon, `${turns} ${tSync('statusline.turns')}`),
      colorToken: effectiveColor(module),
    }
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

/** 段间分隔符 ' │ ' 的显示宽度，与渲染侧保持同一事实源。 */
export const STATUSBAR_SEPARATOR_WIDTH = 3

/**
 * 按可用宽度把段贪心装进最多 maxRows 行：一行装不下时换行继续，
 * 最后一行也装不下的尾部段丢弃（保持既有的"从末尾截断"前缀语义）。
 * 空行无条件接受超宽段（由调用方的 truncate 兜底截断），保证极窄终端
 * 下至少能渲染出首段而不是整栏消失。BuiltInStatusBar 与 /statusline
 * 预览共用此布局，保证配置预览与实际渲染一致。
 */
export function layoutStatusbarRows(
  segments: readonly Segment[],
  availableColumns: number,
  maxRows = 2,
): Segment[][] {
  const rows: Segment[][] = []
  let current: Segment[] = []
  let currentWidth = 0
  for (const seg of segments) {
    const w = stringWidth(seg.text)
    const widthWithSep = current.length > 0 ? currentWidth + STATUSBAR_SEPARATOR_WIDTH + w : w
    const canPlace =
      widthWithSep <= availableColumns ||
      // 单个超宽段：行首无条件放入（truncate 兜底截断），保证极窄终端
      // 下至少渲染出首段而不是整栏消失
      current.length === 0
    if (canPlace) {
      current.push(seg)
      currentWidth = widthWithSep
      continue
    }
    // 当前行放不下且非行首。已到最大行数则从尾部丢弃（保持既有
    // "从末尾截断"的前缀优先语义）。
    if (rows.length + 1 >= maxRows) {
      break
    }
    rows.push(current)
    current = [seg]
    currentWidth = w
  }
  if (current.length > 0) {
    rows.push(current)
  }
  return rows
}
