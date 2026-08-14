// 精简的 cron 表达式解析与下次运行时间计算。
//
// 支持标准五字段 cron 的子集：
import { formatTimeShort } from './format.js'
//   分钟 小时 月中日期 月份 星期
//
// 字段语法：通配符、N、步长（star-slash-N）、范围（N-M）、列表（N,M,...）。
// 不支持 L、W、? 或名称别名。所有时间均按进程本地时区解释——
// 无论 CLI 在哪里运行，"0 9 * * *" 都表示当地上午 9 点。

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
]

// 将单个 cron 字段解析为已排序的匹配值数组。
// 支持：通配符、N、star-slash-N（步长）、N-M（范围）和逗号列表。
// 输入无效时返回 null。
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // 通配符或 star-slash-N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) {
        return null
      }
      for (let i = min; i <= max; i += step) {
        out.add(i)
      }
      continue
    }

    // N-M 或 N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // dayOfWeek：范围中接受 7 作为星期日别名（如 5-7 = 周五、周六、周日 → [5,6,0]）
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) {
        return null
      }
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // 单个 N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // dayOfWeek：接受 7 作为星期日别名 → 0
      if (min === 0 && max === 6 && n === 7) {
        n = 0
      }
      if (n < min || n > max) {
        return null
      }
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) {
    return null
  }
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * 将五字段 cron 表达式解析为展开后的数字数组。
 * 表达式无效或使用不支持的语法时返回 null。
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    return null
  }

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) {
      return null
    }
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/**
 * 使用进程本地时区，计算严格晚于 `from` 且匹配 cron 字段的下一个 Date。
 * 按分钟向前查找，最多检查 366 天；找不到时返回 null（合法 cron 不会出现，
 * 此分支用于满足类型约束）。
 *
 * 标准 cron 语义：dayOfMonth 与 dayOfWeek 同时受限（均非完整范围）时，
 * 任一字段匹配即可。
 *
 * DST：固定小时 cron 若落在春季快进缺口中（如美国时区的 `30 2 * * *`），
 * 会跳过切换当天，因为本地时间不存在该小时，小时集合检查失败后循环会继续。
 * 小时通配 cron（`30 * * * *`）会在缺口后的第一个有效分钟触发。
 * 秋季回拨产生的重复时刻只触发一次（向前推进逻辑会越过第二次出现），
 * 与 vixie-cron 的行为一致。
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  // 字段是否为通配符（完整范围）？
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  // 向上取整到下一个整分钟（严格晚于 `from`）
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      // 跳到下个月月初
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dom = t.getDate()
    const dow = t.getDay()
    // dom/dow 同时受限时，任一匹配即可（OR 语义）
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow)

    if (!dayMatches) {
      // 跳到次日开始
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

// --- cronToHuman ------------------------------------------------------------
// 有意只覆盖常见模式；其他情况直接返回原始 cron 字符串。`utc` 选项供 CCR
// 远程触发器（agents-platform.tsx）使用：它们在服务器运行，始终使用 UTC cron，
// 展示时需从 UTC 转为本地时间，星期场景还要处理跨午夜。默认的本地计划任务
// 不需要这些转换。

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatLocalTime(minute: number, hour: number): string {
  // 1 月 1 日在各时区都没有 DST 缺口。若使用 `new Date()`（当天），
  // 每年春季快进当日可能把凌晨 2 点滚到 3 点。
  const d = new Date(2000, 0, 1, hour, minute)
  return formatTimeShort(d)
}

function formatUtcTimeAsLocal(minute: number, hour: number): string {
  // 用 UTC 创建日期，再按用户本地时区格式化
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function cronToHuman(cron: string, opts?: { utc?: boolean }): string {
  const utc = opts?.utc ?? false
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) {
    return cron
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  // 每 N 分钟：step/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/)
  if (everyMinMatch && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = parseInt(everyMinMatch[1]!, 10)
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // 每小时：0 * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10)
    if (m === 0) {
      return 'Every hour'
    }
    return `Every hour at :${m.toString().padStart(2, '0')}`
  }

  // 每 N 小时：0 step/N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/)
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1]!, 10)
    const m = parseInt(minute, 10)
    const suffix = m === 0 ? '' : ` at :${m.toString().padStart(2, '0')}`
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`
  }

  // --- 其余情况均引用小时和分钟：按 utc 分支 ----------------

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) {
    return cron
  }
  const m = parseInt(minute, 10)
  const h = parseInt(hour, 10)
  const fmtTime = utc ? formatUtcTimeAsLocal : formatLocalTime

  // 每日指定时间：M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${fmtTime(m, h)}`
  }

  // 每周指定日期：M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7 // 将星期日别名 7 归一化为 0
    let dayName: string | undefined
    if (utc) {
      // UTC 日期和时间换算后可能落在不同的本地日期（跨午夜）。
      // 构造对应 UTC 时刻，以计算实际本地星期。
      const ref = new Date()
      const daysToAdd = (dayIndex - ref.getUTCDay() + 7) % 7
      ref.setUTCDate(ref.getUTCDate() + daysToAdd)
      ref.setUTCHours(h, m, 0, 0)
      dayName = DAY_NAMES[ref.getDay()]
    } else {
      dayName = DAY_NAMES[dayIndex]
    }
    if (dayName) {
      return `Every ${dayName} at ${fmtTime(m, h)}`
    }
  }

  // 工作日：M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${fmtTime(m, h)}`
  }

  return cron
}
