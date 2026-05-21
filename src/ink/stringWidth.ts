import emojiRegex from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

const EMOJI_REGEX = emojiRegex()

/**
 * 当 Bun.stringWidth 不可用时，回退的 JavaScript 实现。
 *
 * 获取字符串在终端中的显示宽度。
 *
 * 这是比 string-width 包更准确的替代方案，能正确处理
 * 像 ⚠ (U+26A0) 这样被 string-width 错误报告为宽度 2 的字符。
 *
 * 实现直接使用 eastAsianWidth，ambiguousAsWide 设为 false，
 * 按照 Unicode 标准对于西方语境的建议，将半角字符正确视为窄字符（宽度 1）。
 */
function stringWidthJavaScript(str: string): number {
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  // 快速路径：纯 ASCII 字符串（无 ANSI 码，无宽字符）
  let isPureAscii = true
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // 检查非 ASCII 或 ANSI 转义（0x1b）
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
  }
  if (isPureAscii) {
    // 统计可打印字符数量（排除控制字符）
    let width = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code > 0x1f) {
        width++
      }
    }
    return width
  }

  // 如果存在转义字符，先剥离 ANSI
  if (str.includes('\x1b')) {
    str = stripAnsi(str)
    if (str.length === 0) {
      return 0
    }
  }

  // 快速路径：简单 Unicode（无 emoji、变体选择器或连接符）
  if (!needsSegmentation(str)) {
    let width = 0
    for (const char of str) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
      }
    }
    return width
  }

  let width = 0

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    // 优先检查 emoji（大多数 emoji 序列宽度为 2）
    EMOJI_REGEX.lastIndex = 0
    if (EMOJI_REGEX.test(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }

    // 计算非 emoji 字素簇的宽度
    // 对于字素簇（如带 virama+ZWJ 的梵文合字），只统计第一个非零宽字符的宽度，
    // 因为整个簇会渲染为单个字形。
    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
        break
      }
    }
  }

  return width
}

function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!
    // Emoji ranges
    if (cp >= 0x1f300 && cp <= 0x1faff) {
      return true
    }
    if (cp >= 0x2600 && cp <= 0x27bf) {
      return true
    }
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
      return true
    }
    // Variation selectors, ZWJ
    if (cp >= 0xfe00 && cp <= 0xfe0f) {
      return true
    }
    if (cp === 0x200d) {
      return true
    }
  }
  return false
}

function getEmojiWidth(grapheme: string): number {
  // 区域指示符：单个 = 1，成对 = 2
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0
    for (const _ of grapheme) {
      count++
    }
    return count === 1 ? 1 : 2
  }

  // 不完整的键帽：数字/符号 + VS16 但缺少 U+20E3
  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1
    }
  }

  return 2
}

function isZeroWidth(codePoint: number): boolean {
  // 常见可打印范围的快速路径
  if (codePoint >= 0x20 && codePoint < 0x7f) {
    return false
  }
  if (codePoint >= 0xa0 && codePoint < 0x0300) {
    return codePoint === 0x00ad
  }

  // 控制字符
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return true
  }

  // 零宽和不可见字符
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // ZW space/joiner
    codePoint === 0xfeff || // BOM
    (codePoint >= 0x2060 && codePoint <= 0x2064) // Word joiner etc.
  ) {
    return true
  }

  // 变体选择器
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  // 组合附加符号
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  // 印度文字系组合标记（覆盖天城文到马拉雅拉姆文）
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    // 每个文字区块起始处的符号和元音标记
    const offset = codePoint & 0x7f
    if (offset <= 0x03) {
      return true // 区块起始处的符号
    }
    if (offset >= 0x3a && offset <= 0x4f) {
      return true // 元音符号、virama
    }
    if (offset >= 0x51 && offset <= 0x57) {
      return true // 重音符号
    }
    if (offset >= 0x62 && offset <= 0x63) {
      return true // 元音符号
    }
  }

  // 泰语/老挝语组合标记
  // 注意：U+0E32 (SARA AA)、U+0E33 (SARA AM)、U+0EB2、U+0EB3 是占位元音（宽度 1），不是组合标记
  if (
    codePoint === 0x0e31 || // 泰语 MAI HAN-AKAT
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // 泰语元音符号（跳过 U+0E32、U+0E33）
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // 泰语元音符号和标记
    codePoint === 0x0eb1 || // 老挝语 MAI KAN
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // 老挝语元音符号（跳过 U+0EB2、U+0EB3）
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // 老挝语调号
  ) {
    return true
  }

  // 阿拉伯语格式化字符
  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  // 代理对、标签字符
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return true
  }
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) {
    return true
  }

  return false
}

// 注意：复杂文字脚本的字素簇（如梵文 क्ष = ka+virama+ZWJ+ssa）会渲染为
// 单个连字字形，但占用 2 个终端单元格（wcwidth 对基础辅音求和）。
// Bun.stringWidth=2 与终端单元格分配一致，这正是光标定位所需要的——
// JS 回退的字素簇宽度 1 会导致 Ink 布局与终端不同步。
//
// Bun.stringWidth 在模块作用域只解析一次，而非每次调用时检查——
// typeof 守卫会导致属性访问降级，而这是热路径（每帧约 10 万次调用）。
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function' ? Bun.stringWidth : null

const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const

export const stringWidth: (str: string) => number = bunStringWidth
  ? (str) => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
  : stringWidthJavaScript
