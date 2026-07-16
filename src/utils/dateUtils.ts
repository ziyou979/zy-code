/**
 * dateUtils — 全仓库日期/时间工具函数统一入口。
 *
 * 聚合自 formatBriefTimestamp.ts / format.ts / intl.ts，
 * 并新增常用日期格式化简写。
 */

import { getUiLanguage } from '../i18n/index.js'
import { getRelativeTimeFormat, getTimeZone } from './intl.js'

// ── 从 formatBriefTimestamp.ts 迁移 ────────────────────────────

/**
 * 从 POSIX 环境变量（LC_ALL/LC_TIME/LANG）推导 BCP 47 语言标签。
 * 转换 POSIX 格式（zh_CN.UTF-8）为 BCP 47（zh-CN）。
 */
export function getLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''
  if (!raw || raw === 'C' || raw === 'POSIX') {
    return undefined
  }
  // 仅提取前两部分（语言+地区），忽略编码和修饰符
  const base = raw.split('.')[0]!.split('@')[0]!
  if (!base) {
    return undefined
  }
  const tag = base.replaceAll('_', '-')
  // 通过尝试构造 Intl locale 进行验证
  try {
    new Intl.DateTimeFormat(tag)
    return tag
  } catch {
    return undefined
  }
}

/**
 * 返回 date 当天 00:00:00 UTC 的时间戳（ms）。
 */
export function startOfDay(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime()
}

// ── 从 formatBriefTimestamp.ts 迁移 ────────────────────────────

/**
 * 智能时间戳：同一天显示时间，6天内显示星期+时间，更早显示完整日期。
 *
 * 显示规则：
 *   - 同一天：     "1:30 PM" 或 "13:30"（依赖 locale）
 *   - 6 天内：     "Sunday, 4:15 PM"（依赖 locale）
 *   - 更早：       "Sunday, Feb 20, 4:30 PM"（依赖 locale）
 *
 * `now` 可注入用于测试。
 */
export function formatBriefTimestamp(isoString: string, now: Date = new Date()): string {
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) {
    return ''
  }

  const locale = getLocale()
  const dayDiff = startOfDay(now) - startOfDay(d)
  const daysAgo = Math.round(dayDiff / 86_400_000)

  if (daysAgo === 0) {
    return d.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  if (daysAgo > 0 && daysAgo < 7) {
    return d.toLocaleString(locale, {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return d.toLocaleString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// ── 从 format.ts 迁移日期函数 ──────────────────────────────────

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

/**
 * 相对时间（"5m ago" / "in 3h"）。
 *
 * @param options.style - 'long' | 'short' | 'narrow'（默认 'narrow'）
 * @param options.numeric - 'always' | 'auto'（默认 'always'）
 * @param options.now - 用于注入当前时间进行测试
 */
export function formatRelativeTime(
  date: Date,
  options: { style?: 'long' | 'short' | 'narrow'; numeric?: 'always' | 'auto'; now?: Date } = {},
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

/**
 * 过去时间的相对时间（始终 "X ago"）。
 *
 * @param options.style - 'long' | 'short' | 'narrow'（默认 'narrow'）
 * @param options.now - 用于注入当前时间进行测试
 */
export function formatRelativeTimeAgo(
  date: Date,
  options: { style?: 'long' | 'short' | 'narrow'; now?: Date } = {},
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
 * 格式化的重置时间。
 * 将秒级时间戳格式化为人类可读的日期/时间字符串。
 *
 * @param timestampInSeconds - UNIX 秒级时间戳
 * @param showTimezone - 是否显示时区
 * @param showTime - 是否显示时间（仅显示日期时设为 false）
 */
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

// ── 新增常用日期格式化简写 ────────────────────────────────────

/**
 * 短日期：按 locale 显示为 "Jan 5" 或 "1月5日"。
 */
export function formatShortDate(date: Date, locale?: string): string {
  const resolvedLocale = locale ?? getLocale() ?? 'en-US'
  return date.toLocaleDateString(resolvedLocale, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * 短时间：按 locale 显示为 "3:45 PM" 或 "15:45"。
 */
export function formatTimeShort(date: Date, locale?: string): string {
  const resolvedLocale = locale ?? getLocale() ?? 'en-US'
  return date.toLocaleTimeString(resolvedLocale, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * 短日期+时间：按 locale 显示为 "Jan 5, 3:45 PM" 或 "1月5日 15:45"。
 */
export function formatDateTimeShort(date: Date, locale?: string): string {
  const resolvedLocale = locale ?? getLocale() ?? 'en-US'
  return date.toLocaleString(resolvedLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * 月份+年份：按 locale 显示为 "January 2026" 或 "2026年1月"。
 */
export function formatMonthYear(date: Date, locale?: string): string {
  const resolvedLocale = locale ?? getLocale() ?? 'en-US'
  return date.toLocaleDateString(resolvedLocale, {
    year: 'numeric',
    month: 'long',
  })
}

/**
 * 星期名称：按 locale 显示为 "Monday" 或 "星期一"。
 */
export function formatWeekday(date: Date, locale?: string): string {
  const resolvedLocale = locale ?? getLocale() ?? 'en-US'
  return date.toLocaleDateString(resolvedLocale, {
    weekday: 'long',
  })
}
