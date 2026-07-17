import chalk from 'chalk'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { DailyActivity } from '../analytics/stats.js'
import { toDateString } from './statsCache.js'

export type HeatmapOptions = {
  terminalWidth?: number // Terminal width in characters
  showMonthLabels?: boolean
}

type Percentiles = {
  p25: number
  p50: number
  p75: number
}

/**
 * Pre-calculates percentiles from activity data for use in intensity calculations
 */
function calculatePercentiles(dailyActivity: DailyActivity[]): Percentiles | null {
  const counts = dailyActivity
    .map((a) => a.messageCount)
    .filter((c) => c > 0)
    .sort((a, b) => a - b)

  if (counts.length === 0) {
    return null
  }

  return {
    p25: counts[Math.floor(counts.length * 0.25)]!,
    p50: counts[Math.floor(counts.length * 0.5)]!,
    p75: counts[Math.floor(counts.length * 0.75)]!,
  }
}

/**
 * Generates a GitHub-style activity heatmap for the terminal
 */
export function generateHeatmap(
  dailyActivity: DailyActivity[],
  options: HeatmapOptions = {},
): string {
  const { terminalWidth = 80, showMonthLabels = true } = options

  // 星期标签（i18n），提前计算以确定列宽
  const dayLabels = [
    tSync('heatmap.sun'),
    tSync('heatmap.mon'),
    tSync('heatmap.tue'),
    tSync('heatmap.wed'),
    tSync('heatmap.thu'),
    tSync('heatmap.fri'),
    tSync('heatmap.sat'),
  ]
  const dayLabelColWidth = Math.max(...dayLabels.map((l) => stringWidth(l))) + 1
  const dayLabelPad = ' '.repeat(dayLabelColWidth)
  const availableWidth = terminalWidth - dayLabelColWidth
  const width = Math.min(52, Math.max(10, availableWidth))

  // Build activity map by date
  const activityMap = new Map<string, DailyActivity>()
  for (const activity of dailyActivity) {
    activityMap.set(activity.date, activity)
  }

  // Pre-calculate percentiles once for all intensity lookups
  const percentiles = calculatePercentiles(dailyActivity)

  // Calculate date range - end at today, go back N weeks
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Find the Sunday of the current week (start of the week containing today)
  const currentWeekStart = new Date(today)
  currentWeekStart.setDate(today.getDate() - today.getDay())

  // Go back (width - 1) weeks from the current week start
  const startDate = new Date(currentWeekStart)
  startDate.setDate(startDate.getDate() - (width - 1) * 7)

  // Generate grid (7 rows for days of week, width columns for weeks)
  // Also track which week each month starts for labels
  const grid: string[][] = Array.from({ length: 7 }, () => Array(width).fill(''))
  const monthStarts: { month: number; week: number }[] = []
  let lastMonth = -1

  const currentDate = new Date(startDate)
  for (let week = 0; week < width; week++) {
    for (let day = 0; day < 7; day++) {
      // Don't show future dates
      if (currentDate > today) {
        grid[day]![week] = ' '
        currentDate.setDate(currentDate.getDate() + 1)
        continue
      }

      const dateStr = toDateString(currentDate)
      const activity = activityMap.get(dateStr)

      // Track month changes (on day 0 = Sunday of each week)
      if (day === 0) {
        const month = currentDate.getMonth()
        if (month !== lastMonth) {
          monthStarts.push({ month, week })
          lastMonth = month
        }
      }

      // Determine intensity level based on message count
      const intensity = getIntensity(activity?.messageCount || 0, percentiles)
      grid[day]![week] = getHeatmapChar(intensity)

      currentDate.setDate(currentDate.getDate() + 1)
    }
  }

  // Build output
  const lines: string[] = []

  // Month labels - evenly spaced across the grid
  if (showMonthLabels) {
    const monthNames = [
      tSync('heatmap.jan'),
      tSync('heatmap.feb'),
      tSync('heatmap.mar'),
      tSync('heatmap.apr'),
      tSync('heatmap.may'),
      tSync('heatmap.jun'),
      tSync('heatmap.jul'),
      tSync('heatmap.aug'),
      tSync('heatmap.sep'),
      tSync('heatmap.oct'),
      tSync('heatmap.nov'),
      tSync('heatmap.dec'),
    ]

    const uniqueMonths = monthStarts.map((m) => m.month)
    const labelWidth = Math.floor(width / Math.max(uniqueMonths.length, 1))
    const monthLabels = uniqueMonths
      .map((month) => {
        const name = monthNames[month]!
        const w = stringWidth(name)
        return name + ' '.repeat(Math.max(0, labelWidth - w))
      })
      .join('')

    lines.push(`${dayLabelPad}${monthLabels}`)
  }

  // Grid
  for (let day = 0; day < 7; day++) {
    let label: string
    if ([1, 3, 5].includes(day)) {
      const dayName = dayLabels[day]!
      const w = stringWidth(dayName)
      label = dayName + ' '.repeat(Math.max(0, dayLabelColWidth - w))
    } else {
      label = dayLabelPad
    }
    const row = `${label}${grid[day]!.join('')}`
    lines.push(row)
  }

  // Legend
  const lessLabel = tSync('heatmap.less')
  const moreLabel = tSync('heatmap.more')
  lines.push('')
  lines.push(
    `${dayLabelPad}${lessLabel} ${[ZyBlue('░'), ZyBlue('▒'), ZyBlue('▓'), ZyBlue('█')].join(' ')} ${moreLabel}`,
  )

  return lines.join('\n')
}

export function generateHeatmapLines(
  dailyActivity: DailyActivity[],
  options: HeatmapOptions = {},
): string[] {
  const result = generateHeatmap(dailyActivity, options)
  return result.split('\n')
}

function getIntensity(messageCount: number, percentiles: Percentiles | null): number {
  if (messageCount === 0 || !percentiles) {
    return 0
  }

  if (messageCount >= percentiles.p75) {
    return 4
  }
  if (messageCount >= percentiles.p50) {
    return 3
  }
  if (messageCount >= percentiles.p25) {
    return 2
  }
  return 1
}

// Zy blue color (hex #5b9bd5)
let ZyBlue: ReturnType<typeof chalk.hex>
ZyBlue = chalk.hex('#5b9bd5')

function getHeatmapChar(intensity: number): string {
  switch (intensity) {
    case 0:
      return chalk.gray('·')
    case 1:
      return ZyBlue('░')
    case 2:
      return ZyBlue('▒')
    case 3:
      return ZyBlue('▓')
    case 4:
      return ZyBlue('█')
    default:
      return chalk.gray('·')
  }
}

// 纯字符（无 ANSI）+ 强度值，供 Ink 原生渲染
const INTENSITY_CHARS = ['·', '░', '▒', '▓', '█']
function getPlainChar(intensity: number): string {
  return INTENSITY_CHARS[intensity] ?? INTENSITY_CHARS[0]!
}

export type HeatmapCell = { char: string; intensity: number }
export type HeatmapLine = { label: string; cells: HeatmapCell[] }
export type HeatmapData = {
  monthLabel: string
  lines: HeatmapLine[]
  legendLabel: string
  dayLabelColWidth: number
}

export function generateHeatmapData(
  dailyActivity: DailyActivity[],
  options: HeatmapOptions = {},
): HeatmapData {
  const { terminalWidth = 80, showMonthLabels = true } = options

  const dayLabels = [
    tSync('heatmap.sun'),
    tSync('heatmap.mon'),
    tSync('heatmap.tue'),
    tSync('heatmap.wed'),
    tSync('heatmap.thu'),
    tSync('heatmap.fri'),
    tSync('heatmap.sat'),
  ]
  const colWidth = Math.max(...dayLabels.map((l) => stringWidth(l))) + 1
  const pad = ' '.repeat(colWidth)
  const availableWidth = terminalWidth - colWidth
  const width = Math.min(52, Math.max(10, availableWidth))

  const activityMap = new Map<string, DailyActivity>()
  for (const activity of dailyActivity) {
    activityMap.set(activity.date, activity)
  }
  const percentiles = calculatePercentiles(dailyActivity)

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const currentWeekStart = new Date(today)
  currentWeekStart.setDate(today.getDate() - today.getDay())
  const startDate = new Date(currentWeekStart)
  startDate.setDate(startDate.getDate() - (width - 1) * 7)

  const grid: number[][] = Array.from({ length: 7 }, () => Array(width).fill(0))
  const monthStarts: { month: number; week: number }[] = []
  let lastMonth = -1
  const currentDate = new Date(startDate)
  for (let week = 0; week < width; week++) {
    for (let day = 0; day < 7; day++) {
      if (currentDate > today) {
        grid[day]![week] = -1
        currentDate.setDate(currentDate.getDate() + 1)
        continue
      }
      const dateStr = toDateString(currentDate)
      const activity = activityMap.get(dateStr)
      if (day === 0) {
        const month = currentDate.getMonth()
        if (month !== lastMonth) {
          monthStarts.push({ month, week })
          lastMonth = month
        }
      }
      grid[day]![week] = getIntensity(activity?.messageCount || 0, percentiles)
      currentDate.setDate(currentDate.getDate() + 1)
    }
  }

  // 月份标签行
  let monthLabel = ''
  if (showMonthLabels) {
    const monthNames = [
      tSync('heatmap.jan'),
      tSync('heatmap.feb'),
      tSync('heatmap.mar'),
      tSync('heatmap.apr'),
      tSync('heatmap.may'),
      tSync('heatmap.jun'),
      tSync('heatmap.jul'),
      tSync('heatmap.aug'),
      tSync('heatmap.sep'),
      tSync('heatmap.oct'),
      tSync('heatmap.nov'),
      tSync('heatmap.dec'),
    ]
    const uniqueMonths = monthStarts.map((m) => m.month)
    const labelW = Math.floor(width / Math.max(uniqueMonths.length, 1))
    monthLabel =
      pad +
      uniqueMonths
        .map((month) => {
          const name = monthNames[month]!
          const w = stringWidth(name)
          return name + ' '.repeat(Math.max(0, labelW - w))
        })
        .join('')
  }

  // 数据行
  const heatmapLines: HeatmapLine[] = []
  for (let day = 0; day < 7; day++) {
    let label: string
    if ([1, 3, 5].includes(day)) {
      const dayName = dayLabels[day]!
      const w = stringWidth(dayName)
      label = dayName + ' '.repeat(Math.max(0, colWidth - w))
    } else {
      label = pad
    }
    const cells: HeatmapCell[] = grid[day]!.map((intensity) => ({
      char: intensity < 0 ? ' ' : getPlainChar(intensity),
      intensity: Math.max(0, intensity),
    }))
    heatmapLines.push({ label, cells })
  }

  const lessLabel = tSync('heatmap.less')
  const moreLabel = tSync('heatmap.more')
  const legendLabel = `${pad}${lessLabel} ░ ▒ ▓ █ ${moreLabel}`

  return { monthLabel, lines: heatmapLines, legendLabel, dayLabelColWidth: colWidth }
}
