/**
 * 共享 Intl 对象实例，延迟初始化。
 *
 * Intl 构造器开销较大（约 0.05-0.1ms 每次），因此缓存实例以便全仓复用，
 * 而非每次都新建。延迟初始化确保仅在真正需要时才付出该开销。
 */

// Unicode 文本分割器（延迟初始化）
let graphemeSegmenter: Intl.Segmenter | null = null
let wordSegmenter: Intl.Segmenter | null = null

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    })
  }
  return graphemeSegmenter
}

/**
 * 提取字符串的第一个 grapheme 簇。
 * 空字符串返回 ''。
 */
export function firstGrapheme(text: string): string {
  if (!text) {
    return ''
  }
  const segments = getGraphemeSegmenter().segment(text)
  const first = segments[Symbol.iterator]().next().value
  return first?.segment ?? ''
}

/**
 * 提取字符串的最后一个 grapheme 簇。
 * 空字符串返回 ''。
 */
export function lastGrapheme(text: string): string {
  if (!text) {
    return ''
  }
  let last = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    last = segment
  }
  return last
}

export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  }
  return wordSegmenter
}

// RelativeTimeFormat 缓存（键为 style:numeric）
const rtfCache = new Map<string, Intl.RelativeTimeFormat>()

export function getRelativeTimeFormat(
  style: 'long' | 'short' | 'narrow',
  numeric: 'always' | 'auto',
): Intl.RelativeTimeFormat {
  const key = `${style}:${numeric}`
  let rtf = rtfCache.get(key)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat('en', { style, numeric })
    rtfCache.set(key, rtf)
  }
  return rtf
}

// 时区在进程生命周期内是常量
let cachedTimeZone: string | null = null

export function getTimeZone(): string {
  if (!cachedTimeZone) {
    cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  return cachedTimeZone
}

// 系统 locale 语言子标签（如 'en'、'ja'）在进程生命周期内是常量。
// null = 尚未计算；undefined = 计算过但不可用（避免剥离 ICU 的环境每次调用都重试）。
let cachedSystemLocaleLanguage: string | undefined | null = null

export function getSystemLocaleLanguage(): string | undefined {
  if (cachedSystemLocaleLanguage === null) {
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale
      cachedSystemLocaleLanguage = new Intl.Locale(locale).language
    } catch {
      cachedSystemLocaleLanguage = undefined
    }
  }
  return cachedSystemLocaleLanguage
}

/**
 * 从 POSIX 环境变量（LC_ALL/LC_TIME/LANG）推导 BCP 47 语言标签。
 */
export function getLocale(): string | undefined {
  const raw = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''
  if (!raw || raw === 'C' || raw === 'POSIX') {
    return undefined
  }
  const base = raw.split('.')[0]!.split('@')[0]!
  if (!base) {
    return undefined
  }
  const tag = base.replaceAll('_', '-')
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
