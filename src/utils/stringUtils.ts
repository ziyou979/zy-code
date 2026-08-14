/**
 * 通用字符串工具函数，以及用于安全累积字符串的类。
 */

/**
 * 转义字符串中的正则特殊字符，使其可在 RegExp 构造函数中作为字面模式使用。
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 将字符串首字符转为大写，其余部分保持不变。
 * 与 lodash `capitalize` 不同，本函数不会把剩余字符转为小写。
 *
 * @example capitalize('fooBar') → 'FooBar'
 * @example capitalize('hello world') → 'Hello world'
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * 根据数量返回单数或复数形式，用于替代内联的 `word${n === 1 ? '' : 's'}` 写法。
 *
 * @example plural(1, 'file') → 'file'
 * @example plural(3, 'file') → 'files'
 * @example plural(2, 'entry', 'entries') → 'entries'
 */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return n === 1 ? word : pluralWord
}

/**
 * 返回字符串首行且不分配 split 数组，用于 diff 渲染中的 shebang 检测。
 */
export function firstLineOf(s: string): string {
  const nl = s.indexOf('\n')
  return nl === -1 ? s : s.slice(0, nl)
}

/**
 * 通过 indexOf 跳转统计 `char` 在 `str` 中出现的次数，避免逐字符迭代。
 * 采用结构类型，因此也适用于 Buffer。
 * (Buffer.indexOf accepts string needles).
 */
export function countCharInString(
  str: { indexOf(search: string, start?: number): number },
  char: string,
  start = 0,
): number {
  let count = 0
  let i = str.indexOf(char, start)
  while (i !== -1) {
    count++
    i = str.indexOf(char, i + 1)
  }
  return count
}

/**
 * 将全角（zenkaku）数字归一化为半角数字，便于接受日语/CJK IME 输入。
 */
export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * 将全角（zenkaku）空格归一化为半角空格，便于接受日语/CJK IME 输入
 *（U+3000 → U+0020）。
 */
export function normalizeFullWidthSpace(input: string): string {
  return input.replace(/\u3000/g, ' ')
}

// 限制内存内累积量，避免 RSS 急剧增长；超过上限的内容由 ShellCommand 写入磁盘。
const MAX_STRING_LENGTH = 2 ** 25

/**
 * 使用分隔符安全拼接字符串数组，结果超过 maxSize 时截断。
 *
 * @param lines Array of strings to join
 * @param delimiter Delimiter to use between strings (default: ',')
 * @param maxSize Maximum size of the resulting string
 * @returns The joined string, truncated if necessary
 */
export function safeJoinLines(
  lines: string[],
  delimiter: string = ',',
  maxSize: number = MAX_STRING_LENGTH,
): string {
  const truncationMarker = '...[truncated]'
  let result = ''

  for (const line of lines) {
    const delimiterToAdd = result ? delimiter : ''
    const fullAddition = delimiterToAdd + line

    if (result.length + fullAddition.length <= maxSize) {
      // 整行均可容纳
      result += fullAddition
    } else {
      // 需要截断
      const remainingSpace =
        maxSize - result.length - delimiterToAdd.length - truncationMarker.length

      if (remainingSpace > 0) {
        // 添加分隔符及该行能够容纳的部分
        result += delimiterToAdd + line.slice(0, remainingSpace) + truncationMarker
      } else {
        // 该行已无任何可用空间，仅添加截断标记
        result += truncationMarker
      }
      return result
    }
  }
  return result
}

/**
 * 安全处理大输出的字符串累加器。超过大小限制时截断尾部，在保留输出开头的同时
 * 避免 RangeError 崩溃。
 */
export class EndTruncatingAccumulator {
  private content: string = ''
  private isTruncated = false
  private totalBytesReceived = 0

  /**
   * 创建 EndTruncatingAccumulator。
   * @param maxSize Maximum size in characters before truncation occurs
   */
  constructor(private readonly maxSize: number = MAX_STRING_LENGTH) {}

  /**
   * 向累加器追加数据。总大小超过 maxSize 时截断尾部，以维持大小限制。
   * @param data The string data to append
   */
  append(data: string | Buffer): void {
    const str = typeof data === 'string' ? data : data.toString()
    this.totalBytesReceived += str.length

    // 已达到容量且发生过截断时，不再修改内容
    if (this.isTruncated && this.content.length >= this.maxSize) {
      return
    }

    // 检查追加字符串后是否超过限制
    if (this.content.length + str.length > this.maxSize) {
      // 只追加能够容纳的部分
      const remainingSpace = this.maxSize - this.content.length
      if (remainingSpace > 0) {
        this.content += str.slice(0, remainingSpace)
      }
      this.isTruncated = true
    } else {
      this.content += str
    }
  }

  /**
   * 返回累积字符串；发生截断时包含截断标记。
   */
  toString(): string {
    if (!this.isTruncated) {
      return this.content
    }

    const truncatedBytes = this.totalBytesReceived - this.maxSize
    const truncatedKB = Math.round(truncatedBytes / 1024)
    return `${this.content}\n... [output truncated - ${truncatedKB}KB removed]`
  }

  /**
   * 清除所有累积数据。
   */
  clear(): void {
    this.content = ''
    this.isTruncated = false
    this.totalBytesReceived = 0
  }

  /**
   * 返回当前累积数据大小。
   */
  get length(): number {
    return this.content.length
  }

  /**
   * 返回是否发生过截断。
   */
  get truncated(): boolean {
    return this.isTruncated
  }

  /**
   * 返回截断前收到的总字节数。
   */
  get totalBytes(): number {
    return this.totalBytesReceived
  }
}

/**
 * 将文本截断到最大行数，并在截断时添加省略号。
 *
 * @param text The text to truncate
 * @param maxLines Maximum number of lines to keep
 * @returns The truncated text with ellipsis if truncated
 */
export function truncateToLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return text
  }
  return `${lines.slice(0, maxLines).join('\n')}…`
}
