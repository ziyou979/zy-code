// 纯展示格式化函数 — 叶节点安全（不依赖 Ink）。宽度感知的截断逻辑位于 ./truncate.ts。

import { getUiLanguage } from '../i18n/index.js'
import { getRelativeTimeFormat, getTimeZone } from './intl.js'

/**
 * 将字节数格式化为人类可读的字符串（KB、MB、GB）。
 * @example formatFileSize(1536) → "1.5KB"
 */
export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024
  if (kb < 1) {
    return `${sizeInBytes} bytes`
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  }
  const mb = kb / 1024
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  }
  const gb = mb / 1024
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`
}

/**
 * 将毫秒数格式化为带 1 位小数的秒数（例如 `1234` → `"1.2s"`）。
 * 与 formatDuration 不同，始终保留小数 — 适用于亚分钟级计时场景，
 * 其中小数秒有实际意义（TTFT、hook 耗时等）。
 */
export function formatSecondsShort(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 将毫秒数格式化为人类可读的时长字符串。
 * 英文风格："1m 8s"、"48s"
 */
export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    // 特殊情况：值为 0
    if (ms === 0) {
      return '0s'
    }
    // 时长 < 1s 时，显示 1 位小数（例如 0.5s）
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s}s`
    }
    const s = Math.floor(ms / 1000).toString()
    return `${s}s`
  }

  let days = Math.floor(ms / 86400000)
  let hours = Math.floor((ms % 86400000) / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)
  let seconds = Math.round((ms % 60000) / 1000)

  // 处理四舍五入进位（例如 59.5s 进位为 60s）
  if (seconds === 60) {
    seconds = 0
    minutes++
  }
  if (minutes === 60) {
    minutes = 0
    hours++
  }
  if (hours === 24) {
    hours = 0
    days++
  }

  const hide = options?.hideTrailingZeros

  if (options?.mostSignificantOnly) {
    if (days > 0) {
      return `${days}d`
    }
    if (hours > 0) {
      return `${hours}h`
    }
    if (minutes > 0) {
      return `${minutes}m`
    }
    return `${seconds}s`
  }

  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) {
      return `${days}d`
    }
    if (hide && minutes === 0) {
      return `${days}d ${hours}h`
    }
    return `${days}d ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) {
      return `${hours}h`
    }
    if (hide && seconds === 0) {
      return `${hours}h ${minutes}m`
    }
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    if (hide && seconds === 0) {
      return `${minutes}m`
    }
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

/**
 * 将毫秒数格式化为人类可读的中文风格时长字符串。
 * 中文风格："1分8秒"、"48秒"
 */
export function formatDurationZh(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    if (ms === 0) {
      return '0 秒'
    }
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s} 秒`
    }
    const s = Math.floor(ms / 1000).toString()
    return `${s} 秒`
  }

  let days = Math.floor(ms / 86400000)
  let hours = Math.floor((ms % 86400000) / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)
  let seconds = Math.round((ms % 60000) / 1000)

  if (seconds === 60) {
    seconds = 0
    minutes++
  }
  if (minutes === 60) {
    minutes = 0
    hours++
  }
  if (hours === 24) {
    hours = 0
    days++
  }

  const hide = options?.hideTrailingZeros

  if (options?.mostSignificantOnly) {
    if (days > 0) {
      return `${days} 天`
    }
    if (hours > 0) {
      return `${hours} 小时`
    }
    if (minutes > 0) {
      return `${minutes} 分`
    }
    return `${seconds} 秒`
  }

  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) {
      return `${days} 天`
    }
    if (hide && minutes === 0) {
      return `${days} 天 ${hours} 小时`
    }
    return `${days} 天 ${hours} 小时 ${minutes} 分`
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) {
      return `${hours} 小时`
    }
    if (hide && seconds === 0) {
      return `${hours} 小时 ${minutes} 分`
    }
    return `${hours} 小时 ${minutes} 分 ${seconds} 秒`
  }
  if (minutes > 0) {
    if (hide && seconds === 0) {
      return `${minutes} 分钟`
    }
    return `${minutes} 分 ${seconds} 秒`
  }
  return `${seconds} 秒`
}

/**
 * 根据当前 UI 语言返回对应的时长格式化函数。
 * 集中管理语言到格式化器的映射，后续新增语言只需在此扩展。
 */
export function getLocalizedDurationFormatter(): typeof formatDuration {
  switch (getUiLanguage()) {
    case 'zh-CN':
      return formatDurationZh
    default:
      return formatDuration
  }
}

// `new Intl.NumberFormat` 开销较大，因此缓存格式化器以复用
let numberFormatterForConsistentDecimals: Intl.NumberFormat | null = null
let numberFormatterForInconsistentDecimals: Intl.NumberFormat | null = null
const getNumberFormatter = (useConsistentDecimals: boolean): Intl.NumberFormat => {
  if (useConsistentDecimals) {
    if (!numberFormatterForConsistentDecimals) {
      numberFormatterForConsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      })
    }
    return numberFormatterForConsistentDecimals
  } else {
    if (!numberFormatterForInconsistentDecimals) {
      numberFormatterForInconsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      })
    }
    return numberFormatterForInconsistentDecimals
  }
}

export function formatNumber(number: number): string {
  // 仅对将以紧凑记数法显示的数字使用 minimumFractionDigits
  const shouldUseConsistentDecimals = number >= 1000

  return getNumberFormatter(shouldUseConsistentDecimals)
    .format(number) // 例如 "1321" => "1.3K", "900" => "900"
    .toLowerCase() // 例如 "1.3K" => "1.3k", "1.0K" => "1.0k"
}

export function formatTokens(count: number): string {
  return formatNumber(count).replace('.0', '')
}

type RelativeTimeStyle = 'long' | 'short' | 'narrow'

type RelativeTimeOptions = {
  style?: RelativeTimeStyle
  numeric?: 'always' | 'auto'
}

export function formatRelativeTime(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { style = 'narrow', numeric = 'always', now = new Date() } = options
  const diffInMs = date.getTime() - now.getTime()
  // 使用 Math.trunc 对正值和负值均向零截断
  const diffInSeconds = Math.trunc(diffInMs / 1000)

  // 定义带自定义短单位的时间区间
  const intervals = [
    { unit: 'year', seconds: 31536000, shortUnit: 'y' },
    { unit: 'month', seconds: 2592000, shortUnit: 'mo' },
    { unit: 'week', seconds: 604800, shortUnit: 'w' },
    { unit: 'day', seconds: 86400, shortUnit: 'd' },
    { unit: 'hour', seconds: 3600, shortUnit: 'h' },
    { unit: 'minute', seconds: 60, shortUnit: 'm' },
    { unit: 'second', seconds: 1, shortUnit: 's' },
  ] as const

  // 查找合适的时间单位
  for (const { unit, seconds: intervalSeconds, shortUnit } of intervals) {
    if (Math.abs(diffInSeconds) >= intervalSeconds) {
      const value = Math.trunc(diffInSeconds / intervalSeconds)
      // 对 narrow 风格使用自定义格式
      if (style === 'narrow') {
        return diffInSeconds < 0 ? `${Math.abs(value)}${shortUnit} ago` : `in ${value}${shortUnit}`
      }
      // 对天及更长的单位，无论 style 参数如何都使用 long 风格
      return getRelativeTimeFormat('long', numeric).format(value, unit)
    }
  }

  // 不足 1 秒的情况
  if (style === 'narrow') {
    return diffInSeconds <= 0 ? '0s ago' : 'in 0s'
  }
  return getRelativeTimeFormat(style, numeric).format(0, 'second')
}

export function formatRelativeTimeAgo(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { now = new Date(), ...restOptions } = options
  if (date > now) {
    // 对未来日期，直接返回相对时间（不带 "ago"）
    return formatRelativeTime(date, { ...restOptions, now })
  }

  // 对过去日期，强制 numeric: 'always' 以确保输出 "X units ago" 格式
  return formatRelativeTime(date, { ...restOptions, numeric: 'always', now })
}

/**
 * 格式化日志元数据用于展示（时间、大小或消息数、分支、标签、PR）
 */
export function formatLogMetadata(log: {
  modified: Date
  messageCount: number
  fileSize?: number
  gitBranch?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prRepository?: string
}): string {
  const sizeOrCount =
    log.fileSize !== undefined ? formatFileSize(log.fileSize) : `${log.messageCount} messages`
  const parts = [
    formatRelativeTimeAgo(log.modified, { style: 'short' }),
    ...(log.gitBranch ? [log.gitBranch] : []),
    sizeOrCount,
  ]
  if (log.tag) {
    parts.push(`#${log.tag}`)
  }
  if (log.agentSetting) {
    parts.push(`@${log.agentSetting}`)
  }
  if (log.prNumber) {
    parts.push(log.prRepository ? `${log.prRepository}#${log.prNumber}` : `#${log.prNumber}`)
  }
  return parts.join(' · ')
}

export function formatResetTime(
  timestampInSeconds: number | undefined,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string | undefined {
  if (!timestampInSeconds) {
    return undefined
  }

  const date = new Date(timestampInSeconds * 1000)
  const now = new Date()
  const minutes = date.getMinutes()

  // 计算距离重置还有多少小时
  const hoursUntilReset = (date.getTime() - now.getTime()) / (1000 * 60 * 60)

  // 如果重置时间超过 24 小时，同时显示日期
  if (hoursUntilReset > 24) {
    // 对超过一天的重置时间，显示日期和时间
    const dateOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: showTime ? 'numeric' : undefined,
      minute: !showTime || minutes === 0 ? undefined : '2-digit',
      hour12: showTime ? true : undefined,
    }

    // 如果不是当前年份，添加年份显示
    if (date.getFullYear() !== now.getFullYear()) {
      dateOptions.year = 'numeric'
    }

    const dateString = date.toLocaleString('en-US', dateOptions)

    // 移除 AM/PM 前的空格并转为小写
    return (
      dateString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
      (showTimezone ? ` (${getTimeZone()})` : '')
    )
  }

  // 24 小时内的重置，仅显示时间（保持已有行为）
  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  })

  // 移除 AM/PM 前的空格并转为小写，然后添加时区
  return (
    timeString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
    (showTimezone ? ` (${getTimeZone()})` : '')
  )
}

export function formatResetText(
  resetsAt: string,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string {
  const dt = new Date(resetsAt)
  return `${formatResetTime(Math.floor(dt.getTime() / 1000), showTimezone, showTime)}`
}

// 向后兼容：截断辅助函数已移至 ./truncate.ts（依赖 ink/stringWidth）
export {
  truncate,
  truncatePathMiddle,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
  wrapText,
} from './truncate.js'
