import { stringWidth } from '../ink/stringWidth.js'
import { wrapAnsi } from '../ink/wrapAnsi.js'
import { firstGrapheme, getGraphemeSegmenter, getWordSegmenter } from '../utils/intl.js'

/**
 * Kill ring 用于保存被 kill（剪切）的文本，可通过 Ctrl+Y yank（粘贴）。
 * 这是全局状态，所有输入框共享同一个 kill ring。
 *
 * 连续 kill 会累积到 kill ring 中，直到用户输入其他按键。yank 后可用 Alt+Y
 * 循环切换此前 kill 的内容。
 */
const KILL_RING_MAX_SIZE = 10
let killRing: string[] = []
let killRingIndex = 0
let lastActionWasKill = false

// 跟踪 yank-pop（Alt+Y）状态。
let lastYankStart = 0
let lastYankLength = 0
let lastActionWasYank = false

export function pushToKillRing(text: string, direction: 'prepend' | 'append' = 'append'): void {
  if (text.length > 0) {
    if (lastActionWasKill && killRing.length > 0) {
      // 与最近一次 kill 的内容合并。
      if (direction === 'prepend') {
        killRing[0] = text + killRing[0]
      } else {
        killRing[0] = killRing[0] + text
      }
    } else {
      // 在 ring 前端加入新条目。
      killRing.unshift(text)
      if (killRing.length > KILL_RING_MAX_SIZE) {
        killRing.pop()
      }
    }
    lastActionWasKill = true
    // kill 新文本时重置 yank 状态。
    lastActionWasYank = false
  }
}

export function getLastKill(): string {
  return killRing[0] ?? ''
}

export function getKillRingItem(index: number): string {
  if (killRing.length === 0) {
    return ''
  }
  const normalizedIndex = ((index % killRing.length) + killRing.length) % killRing.length
  return killRing[normalizedIndex] ?? ''
}

export function getKillRingSize(): number {
  return killRing.length
}

export function clearKillRing(): void {
  killRing = []
  killRingIndex = 0
  lastActionWasKill = false
  lastActionWasYank = false
  lastYankStart = 0
  lastYankLength = 0
}

export function resetKillAccumulation(): void {
  lastActionWasKill = false
}

// yank-pop 使用的 yank 状态跟踪。
export function recordYank(start: number, length: number): void {
  lastYankStart = start
  lastYankLength = length
  lastActionWasYank = true
  killRingIndex = 0
}

export function canYankPop(): boolean {
  return lastActionWasYank && killRing.length > 1
}

export function yankPop(): {
  text: string
  start: number
  length: number
} | null {
  if (!lastActionWasYank || killRing.length <= 1) {
    return null
  }
  // 循环切换到 kill ring 的下一项。
  killRingIndex = (killRingIndex + 1) % killRing.length
  const text = killRing[killRingIndex] ?? ''
  return { text, start: lastYankStart, length: lastYankLength }
}

export function updateYankLength(length: number): void {
  lastYankLength = length
}

export function resetYankState(): void {
  lastActionWasYank = false
}

/**
 * Unicode 规范化的文本处理流程：
 *
 * 用户输入（可能混合 NFD/NFC 的原始文本）
 *     ↓
 * MeasuredText（规范化为 NFC，并构建 grapheme 信息）
 *     ↓
 * 所有光标操作都使用规范化后的文本与 offset
 *     ↓
 * 显示时使用 wrappedLines 中的规范化文本
 *
 * 此流程确保 Unicode 处理保持一致：
 * - NFD/NFC 规范化差异不会破坏光标移动
 * - grapheme cluster（如 👨‍👩‍👧‍👦）被视为单个单元
 * - CJK 字符的显示宽度计算准确
 *
 * 规则：文本进入 MeasuredText 后，所有操作都基于规范化版本。
 */

// 预编译 Vim 单词检测 regex，避免在热点循环中反复创建。
export const VIM_WORD_CHAR_REGEX = /^[\p{L}\p{N}\p{M}_]$/u
export const WHITESPACE_REGEX = /\s/

// 导出的 Vim 字符分类辅助函数。
export const isVimWordChar = (ch: string): boolean => VIM_WORD_CHAR_REGEX.test(ch)
export const isVimWhitespace = (ch: string): boolean => WHITESPACE_REGEX.test(ch)
export const isVimPunctuation = (ch: string): boolean =>
  ch.length > 0 && !isVimWhitespace(ch) && !isVimWordChar(ch)

type WrappedText = string[]
type Position = {
  line: number
  column: number
}

export class Cursor {
  readonly offset: number
  constructor(
    readonly measuredText: MeasuredText,
    offset: number = 0,
    readonly selection: number = 0,
  ) {
    // 允许光标位于字符串末尾后一位。
    this.offset = Math.max(0, Math.min(this.text.length, offset))
  }

  static fromText(
    text: string,
    columns: number,
    offset: number = 0,
    selection: number = 0,
  ): Cursor {
    // 创建 MeasuredText 时宽度比 columns 少一列，为光标留出空间。
    return new Cursor(new MeasuredText(text, columns - 1), offset, selection)
  }

  getViewportStartLine(maxVisibleLines?: number): number {
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) {
      return 0
    }
    const { line } = this.getPosition()
    const allLines = this.measuredText.getWrappedText()
    if (allLines.length <= maxVisibleLines) {
      return 0
    }
    const half = Math.floor(maxVisibleLines / 2)
    let startLine = Math.max(0, line - half)
    const endLine = Math.min(allLines.length, startLine + maxVisibleLines)
    if (endLine - startLine < maxVisibleLines) {
      startLine = Math.max(0, endLine - maxVisibleLines)
    }
    return startLine
  }

  getViewportCharOffset(maxVisibleLines?: number): number {
    const startLine = this.getViewportStartLine(maxVisibleLines)
    if (startLine === 0) {
      return 0
    }
    const wrappedLines = this.measuredText.getWrappedLines()
    return wrappedLines[startLine]?.startOffset ?? 0
  }

  getViewportCharEnd(maxVisibleLines?: number): number {
    const startLine = this.getViewportStartLine(maxVisibleLines)
    const allLines = this.measuredText.getWrappedLines()
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) {
      return this.text.length
    }
    const endLine = Math.min(allLines.length, startLine + maxVisibleLines)
    if (endLine >= allLines.length) {
      return this.text.length
    }
    return allLines[endLine]?.startOffset ?? this.text.length
  }

  render(
    cursorChar: string,
    mask: string,
    invert: (text: string) => string,
    ghostText?: { text: string; dim: (text: string) => string },
    maxVisibleLines?: number,
  ) {
    const { line, column } = this.getPosition()
    const allLines = this.measuredText.getWrappedText()

    const startLine = this.getViewportStartLine(maxVisibleLines)
    const endLine =
      maxVisibleLines !== undefined && maxVisibleLines > 0
        ? Math.min(allLines.length, startLine + maxVisibleLines)
        : allLines.length

    return allLines
      .slice(startLine, endLine)
      .map((text, i) => {
        const currentLine = i + startLine
        let displayText = text
        if (mask) {
          const graphemes = Array.from(getGraphemeSegmenter().segment(text))
          if (currentLine === allLines.length - 1) {
            // 最后一行：除末尾 6 个字符外全部遮蔽，使用户能确认粘贴内容是否正确，
            // 同时不暴露完整 token
            const visibleCount = Math.min(6, graphemes.length)
            const maskCount = graphemes.length - visibleCount
            const splitOffset = graphemes.length > visibleCount ? graphemes[maskCount]!.index : 0
            displayText = mask.repeat(maskCount) + text.slice(splitOffset)
          } else {
            // 前面的折行全部遮蔽。此前只遮蔽最后一行，窄终端中 OAuth code 跨多行折行时，
            // 会泄漏 token 开头。
            displayText = mask.repeat(graphemes.length)
          }
        }
        // 查找光标所在行
        if (line !== currentLine) {
          return displayText.trimEnd()
        }

        // 单次遍历 grapheme，把行拆成光标前、光标处和光标后三部分，并累积显示宽度，
        // 直到抵达光标列。替代原先两次遍历的方式（displayWidthToStringIndex 加第二次
        // segmenter 遍历）；旧方式产生的中间 stringIndex 始终位于 grapheme 边界，
        // 因此“光标处于多 codepoint 字符中间”的分支永远无法到达。
        let beforeCursor = ''
        let atCursor = cursorChar
        let afterCursor = ''
        let currentWidth = 0
        let cursorFound = false

        for (const { segment } of getGraphemeSegmenter().segment(displayText)) {
          if (cursorFound) {
            afterCursor += segment
            continue
          }
          const nextWidth = currentWidth + stringWidth(segment)
          if (nextWidth > column) {
            atCursor = segment
            cursorFound = true
          } else {
            currentWidth = nextWidth
            beforeCursor += segment
          }
        }

        // 只有存在可显示的光标字符时才反色；有 ghost text 且光标在末尾时，
        // 在光标中显示首个 ghost 字符
        let renderedCursor: string
        let ghostSuffix = ''
        if (
          ghostText &&
          currentLine === allLines.length - 1 &&
          this.isAtEnd() &&
          ghostText.text.length > 0
        ) {
          // 首个 ghost 字符放入反色光标，且保持 grapheme 安全
          const firstGhostChar = firstGrapheme(ghostText.text) || ghostText.text[0]!
          renderedCursor = cursorChar ? invert(firstGhostChar) : firstGhostChar
          // 剩余 ghost text 在光标后以暗色显示
          const ghostRest = ghostText.text.slice(firstGhostChar.length)
          if (ghostRest.length > 0) {
            ghostSuffix = ghostText.dim(ghostRest)
          }
        } else {
          renderedCursor = cursorChar ? invert(atCursor) : atCursor
        }

        return beforeCursor + renderedCursor + ghostSuffix + afterCursor.trimEnd()
      })
      .join('\n')
  }

  left(): Cursor {
    if (this.offset === 0) {
      return this
    }

    const chip = this.imageRefEndingAt(this.offset)
    if (chip) {
      return new Cursor(this.measuredText, chip.start)
    }

    const prevOffset = this.measuredText.prevOffset(this.offset)
    return new Cursor(this.measuredText, prevOffset)
  }

  right(): Cursor {
    if (this.offset >= this.text.length) {
      return this
    }

    const chip = this.imageRefStartingAt(this.offset)
    if (chip) {
      return new Cursor(this.measuredText, chip.end)
    }

    const nextOffset = this.measuredText.nextOffset(this.offset)
    return new Cursor(this.measuredText, Math.min(nextOffset, this.text.length))
  }

  /**
   * 若某个 [Image #N] chip 在 `offset` 结束，则返回其边界。供 left() 让光标跨过
   * 整个 chip，而不是进入内部。
   */
  imageRefEndingAt(offset: number): { start: number; end: number } | null {
    const m = this.text.slice(0, offset).match(/\[Image #\d+\]$/)
    return m ? { start: offset - m[0].length, end: offset } : null
  }

  imageRefStartingAt(offset: number): { start: number; end: number } | null {
    const m = this.text.slice(offset).match(/^\[Image #\d+\]/)
    return m ? { start: offset, end: offset + m[0].length } : null
  }

  /**
   * offset 严格落在 [Image #N] chip 内部时，将其吸附到指定边界。
   * 供单词移动方法使用，确保 Ctrl+W / Alt+D 不会留下残缺 chip。
   */
  snapOutOfImageRef(offset: number, toward: 'start' | 'end'): number {
    const re = /\[Image #\d+\]/g
    let m
    while ((m = re.exec(this.text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (offset > start && offset < end) {
        return toward === 'start' ? start : end
      }
    }
    return offset
  }

  up(): Cursor {
    const { line, column } = this.getPosition()
    if (line === 0) {
      return this
    }

    const prevLine = this.measuredText.getWrappedText()[line - 1]
    if (prevLine === undefined) {
      return this
    }

    const prevLineDisplayWidth = stringWidth(prevLine)
    if (column > prevLineDisplayWidth) {
      const newOffset = this.getOffset({
        line: line - 1,
        column: prevLineDisplayWidth,
      })
      return new Cursor(this.measuredText, newOffset, 0)
    }

    const newOffset = this.getOffset({ line: line - 1, column })
    return new Cursor(this.measuredText, newOffset, 0)
  }

  down(): Cursor {
    const { line, column } = this.getPosition()
    if (line >= this.measuredText.lineCount - 1) {
      return this
    }

    // 没有下一行时停留在当前行，由调用方处理；例如 prompt 输入会移到下一条历史记录
    const nextLine = this.measuredText.getWrappedText()[line + 1]
    if (nextLine === undefined) {
      return this
    }

    // 当前列超过下一行末尾时，移动到下一行末尾
    const nextLineDisplayWidth = stringWidth(nextLine)
    if (column > nextLineDisplayWidth) {
      const newOffset = this.getOffset({
        line: line + 1,
        column: nextLineDisplayWidth,
      })
      return new Cursor(this.measuredText, newOffset, 0)
    }

    // 否则移动到下一行的相同列
    const newOffset = this.getOffset({
      line: line + 1,
      column,
    })
    return new Cursor(this.measuredText, newOffset, 0)
  }

  /**
   * 移动到当前行开头（第 0 列），这是 startOfLine 内部使用的原始版本。
   */
  private startOfCurrentLine(): Cursor {
    const { line } = this.getPosition()
    return new Cursor(
      this.measuredText,
      this.getOffset({
        line,
        column: 0,
      }),
      0,
    )
  }

  startOfLine(): Cursor {
    const { line, column } = this.getPosition()

    // 已在行首且不是第一行时，移动到上一行
    if (column === 0 && line > 0) {
      return new Cursor(
        this.measuredText,
        this.getOffset({
          line: line - 1,
          column: 0,
        }),
        0,
      )
    }

    return this.startOfCurrentLine()
  }

  firstNonBlankInLine(): Cursor {
    const { line } = this.getPosition()
    const lineText = this.measuredText.getWrappedText()[line] || ''

    const match = lineText.match(/^\s*\S/)
    const column = match?.index ? match.index + match[0].length - 1 : 0
    const offset = this.getOffset({ line, column })

    return new Cursor(this.measuredText, offset, 0)
  }

  endOfLine(): Cursor {
    const { line } = this.getPosition()
    const column = this.measuredText.getLineLength(line)
    const offset = this.getOffset({ line, column })
    return new Cursor(this.measuredText, offset, 0)
  }

  // 查找逻辑行边界的辅助方法
  private findLogicalLineStart(fromOffset: number = this.offset): number {
    const prevNewline = this.text.lastIndexOf('\n', fromOffset - 1)
    return prevNewline === -1 ? 0 : prevNewline + 1
  }

  private findLogicalLineEnd(fromOffset: number = this.offset): number {
    const nextNewline = this.text.indexOf('\n', fromOffset)
    return nextNewline === -1 ? this.text.length : nextNewline
  }

  // 获取当前位置逻辑行边界的 helper
  private getLogicalLineBounds(): { start: number; end: number } {
    return {
      start: this.findLogicalLineStart(),
      end: this.findLogicalLineEnd(),
    }
  }

  // 创建保留列位置且限制在线长范围内的光标，并吸附到 grapheme 边界，
  // 避免落在 grapheme 中间
  private createCursorWithColumn(lineStart: number, lineEnd: number, targetColumn: number): Cursor {
    const lineLength = lineEnd - lineStart
    const clampedColumn = Math.min(targetColumn, lineLength)
    const rawOffset = lineStart + clampedColumn
    const offset = this.measuredText.snapToGraphemeBoundary(rawOffset)
    return new Cursor(this.measuredText, offset, 0)
  }

  endOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.findLogicalLineEnd(), 0)
  }

  startOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.findLogicalLineStart(), 0)
  }

  firstNonBlankInLogicalLine(): Cursor {
    const { start, end } = this.getLogicalLineBounds()
    const lineText = this.text.slice(start, end)
    const match = lineText.match(/\S/)
    const offset = start + (match?.index ?? 0)
    return new Cursor(this.measuredText, offset, 0)
  }

  upLogicalLine(): Cursor {
    const { start: currentStart } = this.getLogicalLineBounds()

    // 位于第一行时停在开头
    if (currentStart === 0) {
      return new Cursor(this.measuredText, 0, 0)
    }

    // 计算目标列位置
    const currentColumn = this.offset - currentStart

    // 查找上一行边界
    const prevLineEnd = currentStart - 1
    const prevLineStart = this.findLogicalLineStart(prevLineEnd)

    return this.createCursorWithColumn(prevLineStart, prevLineEnd, currentColumn)
  }

  downLogicalLine(): Cursor {
    const { start: currentStart, end: currentEnd } = this.getLogicalLineBounds()

    // 位于最后一行时停在末尾
    if (currentEnd >= this.text.length) {
      return new Cursor(this.measuredText, this.text.length, 0)
    }

    // 计算目标列位置
    const currentColumn = this.offset - currentStart

    // 查找下一行边界
    const nextLineStart = currentEnd + 1
    const nextLineEnd = this.findLogicalLineEnd(nextLineStart)

    return this.createCursorWithColumn(nextLineStart, nextLineEnd, currentColumn)
  }

  // Vim 的 word 与 WORD 移动：
  // - word (lowercase w/b/e): sequences of letters, digits, and underscores
  // - WORD (uppercase W/B/E): sequences of non-whitespace characters
  // 例如在 "hello-world!" 中，word 移动会识别 "hello"、"world" 等独立部分，
  // 而 WORD 移动把整个 "hello-world!" 视为一个 WORD

  nextWord(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    // 使用 Intl.Segmenter 正确检测包括 CJK 在内的单词边界
    const wordBoundaries = this.measuredText.getWordBoundaries()

    // 查找当前位置之后的下一个单词起始边界
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.start)
      }
    }

    // 找不到下一个单词时移到末尾
    return new Cursor(this.measuredText, this.text.length)
  }

  endOfWord(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    // 使用 Intl.Segmenter 正确检测包括 CJK 在内的单词边界
    const wordBoundaries = this.measuredText.getWordBoundaries()

    // 查找当前所在的单词边界
    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) {
        continue
      }

      // 位于此单词内部但不在最后一个字符时
      if (this.offset >= boundary.start && this.offset < boundary.end - 1) {
        // 移到此单词末尾，即最后一个字符位置
        return new Cursor(this.measuredText, boundary.end - 1)
      }

      // 位于单词最后一个字符（end - 1）时，查找下一个单词末尾
      if (this.offset === boundary.end - 1) {
        // 查找下一个单词
        for (const nextBoundary of wordBoundaries) {
          if (nextBoundary.isWordLike && nextBoundary.start > this.offset) {
            return new Cursor(this.measuredText, nextBoundary.end - 1)
          }
        }
        return this
      }
    }

    // 不在单词中时，查找下一个单词并移到其末尾
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.end - 1)
      }
    }

    return this
  }

  prevWord(): Cursor {
    if (this.isAtStart()) {
      return this
    }

    // 使用 Intl.Segmenter 正确检测包括 CJK 在内的单词边界
    const wordBoundaries = this.measuredText.getWordBoundaries()

    // 查找当前位置之前的上一个单词起始边界，需要反向迭代
    let prevWordStart: number | null = null

    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) {
        continue
      }

      // 位于此单词开头或之后，且该单词起点在当前位置之前时
      if (boundary.start < this.offset) {
        // 位于此单词内部而非开头时，移到其开头
        if (this.offset > boundary.start && this.offset <= boundary.end) {
          return new Cursor(this.measuredText, boundary.start)
        }
        // 否则将其记为上一个单词候选
        prevWordStart = boundary.start
      }
    }

    if (prevWordStart !== null) {
      return new Cursor(this.measuredText, prevWordStart)
    }

    return new Cursor(this.measuredText, 0)
  }

  // Vim 专用单词方法
  // Vim 中的“word”可以是：
  // 1. A sequence of word characters (letters, digits, underscore) - including Unicode
  // 2. A sequence of non-blank, non-word characters (punctuation/symbols)

  nextVimWord(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    let pos = this.offset
    const advance = (p: number): number => this.measuredText.nextOffset(p)

    const currentGrapheme = this.graphemeAt(pos)
    if (!currentGrapheme) {
      return this
    }

    if (isVimWordChar(currentGrapheme)) {
      while (pos < this.text.length && isVimWordChar(this.graphemeAt(pos))) {
        pos = advance(pos)
      }
    } else if (isVimPunctuation(currentGrapheme)) {
      while (pos < this.text.length && isVimPunctuation(this.graphemeAt(pos))) {
        pos = advance(pos)
      }
    }

    while (pos < this.text.length && WHITESPACE_REGEX.test(this.graphemeAt(pos))) {
      pos = advance(pos)
    }

    return new Cursor(this.measuredText, pos)
  }

  endOfVimWord(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    const text = this.text
    let pos = this.offset
    const advance = (p: number): number => this.measuredText.nextOffset(p)

    if (this.graphemeAt(pos) === '') {
      return this
    }

    pos = advance(pos)

    while (pos < text.length && WHITESPACE_REGEX.test(this.graphemeAt(pos))) {
      pos = advance(pos)
    }

    if (pos >= text.length) {
      return new Cursor(this.measuredText, text.length)
    }

    const charAtPos = this.graphemeAt(pos)
    if (isVimWordChar(charAtPos)) {
      while (pos < text.length) {
        const nextPos = advance(pos)
        if (nextPos >= text.length || !isVimWordChar(this.graphemeAt(nextPos))) {
          break
        }
        pos = nextPos
      }
    } else if (isVimPunctuation(charAtPos)) {
      while (pos < text.length) {
        const nextPos = advance(pos)
        if (nextPos >= text.length || !isVimPunctuation(this.graphemeAt(nextPos))) {
          break
        }
        pos = nextPos
      }
    }

    return new Cursor(this.measuredText, pos)
  }

  prevVimWord(): Cursor {
    if (this.isAtStart()) {
      return this
    }

    let pos = this.offset
    const retreat = (p: number): number => this.measuredText.prevOffset(p)

    pos = retreat(pos)

    while (pos > 0 && WHITESPACE_REGEX.test(this.graphemeAt(pos))) {
      pos = retreat(pos)
    }

    // 在位置 0 遇到空白表示不存在上一个单词，移到开头
    if (pos === 0 && WHITESPACE_REGEX.test(this.graphemeAt(0))) {
      return new Cursor(this.measuredText, 0)
    }

    const charAtPos = this.graphemeAt(pos)
    if (isVimWordChar(charAtPos)) {
      while (pos > 0) {
        const prevPos = retreat(pos)
        if (!isVimWordChar(this.graphemeAt(prevPos))) {
          break
        }
        pos = prevPos
      }
    } else if (isVimPunctuation(charAtPos)) {
      while (pos > 0) {
        const prevPos = retreat(pos)
        if (!isVimPunctuation(this.graphemeAt(prevPos))) {
          break
        }
        pos = prevPos
      }
    }

    return new Cursor(this.measuredText, pos)
  }

  nextWORD(): Cursor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let nextCursor: Cursor = this
    // 当前位于非空白字符时，移到下一个空白字符
    while (!nextCursor.isOverWhitespace() && !nextCursor.isAtEnd()) {
      nextCursor = nextCursor.right()
    }
    // 再移到下一个非空白字符
    while (nextCursor.isOverWhitespace() && !nextCursor.isAtEnd()) {
      nextCursor = nextCursor.right()
    }
    return nextCursor
  }

  endOfWORD(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cursor: Cursor = this

    // 检查是否已经位于 WORD 末尾
    // (current character is non-whitespace, but next character is whitespace or we're at the end)
    const atEndOfWORD =
      !cursor.isOverWhitespace() && (cursor.right().isOverWhitespace() || cursor.right().isAtEnd())

    if (atEndOfWORD) {
      // 已位于 WORD 末尾，移到下一个 WORD
      cursor = cursor.right()
      return cursor.endOfWORD()
    }

    // 当前位于空白字符时，查找下一个 WORD
    if (cursor.isOverWhitespace()) {
      cursor = cursor.nextWORD()
    }

    // 移到当前 WORD 末尾
    while (!cursor.right().isOverWhitespace() && !cursor.isAtEnd()) {
      cursor = cursor.right()
    }

    return cursor
  }

  prevWORD(): Cursor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cursor: Cursor = this

    // 已位于 WORD 开头时，先向左移出该 WORD
    if (cursor.left().isOverWhitespace()) {
      cursor = cursor.left()
    }

    // 向左越过所有空白字符
    while (cursor.isOverWhitespace() && !cursor.isAtStart()) {
      cursor = cursor.left()
    }

    // 位于非空白字符时，移到此 WORD 开头
    if (!cursor.isOverWhitespace()) {
      while (!cursor.left().isOverWhitespace() && !cursor.isAtStart()) {
        cursor = cursor.left()
      }
    }

    return cursor
  }

  modifyText(end: Cursor, insertString: string = ''): Cursor {
    const startOffset = this.offset
    const endOffset = end.offset

    const newText = this.text.slice(0, startOffset) + insertString + this.text.slice(endOffset)

    return Cursor.fromText(
      newText,
      this.columns,
      startOffset + insertString.normalize('NFC').length,
    )
  }

  insert(insertString: string): Cursor {
    const newCursor = this.modifyText(this, insertString)
    return newCursor
  }

  del(): Cursor {
    if (this.isAtEnd()) {
      return this
    }
    return this.modifyText(this.right())
  }

  backspace(): Cursor {
    if (this.isAtStart()) {
      return this
    }
    return this.left().modifyText(this)
  }

  deleteToLineStart(): { cursor: Cursor; killed: string } {
    // 光标紧跟换行符（位于行首）时只删除该换行符，与 deleteToLineEnd 对换行的处理对称，
    // 使重复 ctrl+u 能跨行清除。
    if (this.offset > 0 && this.text[this.offset - 1] === '\n') {
      return { cursor: this.left().modifyText(this), killed: '\n' }
    }

    // 使用 startOfLine()，使光标位于折行后视觉行的第 0 列时，能移到上一视觉行开头，
    // 而不是卡住。
    const startCursor = this.startOfLine()
    const killed = this.text.slice(startCursor.offset, this.offset)
    return { cursor: startCursor.modifyText(this), killed }
  }

  deleteToLineEnd(): { cursor: Cursor; killed: string } {
    // 光标位于换行符时只删除该字符
    if (this.text[this.offset] === '\n') {
      return { cursor: this.modifyText(this.right()), killed: '\n' }
    }

    const endCursor = this.endOfLine()
    const killed = this.text.slice(this.offset, endCursor.offset)
    return { cursor: this.modifyText(endCursor), killed }
  }

  deleteToLogicalLineEnd(): Cursor {
    // 光标位于换行符时只删除该字符
    if (this.text[this.offset] === '\n') {
      return this.modifyText(this.right())
    }

    return this.modifyText(this.endOfLogicalLine())
  }

  deleteWordBefore(): { cursor: Cursor; killed: string } {
    if (this.isAtStart()) {
      return { cursor: this, killed: '' }
    }
    const target = this.snapOutOfImageRef(this.prevWord().offset, 'start')
    const prevWordCursor = new Cursor(this.measuredText, target)
    const killed = this.text.slice(prevWordCursor.offset, this.offset)
    return { cursor: prevWordCursor.modifyText(this), killed }
  }

  /**
   * 删除光标前存在的 token。支持粘贴文本引用：[Pasted text #1]、
   * [Pasted text #1 +10 lines]、
   * [...Truncated text #1 +10 lines...]
   *
   * 注意：@mention 不会 token 化，因为用户可能需要修正文件路径中的拼写错误。
   * 对 mention 使用 Ctrl/Cmd+Backspace 进行单词删除。
   *
   * 光标位置找不到 token 时返回 null。仅当光标位于 token 末尾，且后接空白或 EOL 时触发。
   */
  deleteTokenBefore(): Cursor | null {
    // 光标位于 chip.start 表示“已选中”状态；Backspace 会向前删除整个 chip，
    // 而非删除它之前的字符。
    const chipAfter = this.imageRefStartingAt(this.offset)
    if (chipAfter) {
      const end = this.text[chipAfter.end] === ' ' ? chipAfter.end + 1 : chipAfter.end
      return this.modifyText(new Cursor(this.measuredText, end))
    }

    if (this.isAtStart()) {
      return null
    }

    // 仅当光标位于单词边界（光标后为空白或字符串末尾）时触发
    const charAfter = this.text[this.offset]
    if (charAfter !== undefined && !/\s/.test(charAfter)) {
      return null
    }

    const textBefore = this.text.slice(0, this.offset)

    // 检查粘贴/截断文本引用：[Pasted text #1] 或 [...Truncated text #1 +50 lines...]
    const pasteMatch = textBefore.match(
      /(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/,
    )
    if (pasteMatch) {
      const matchStart = pasteMatch.index! + pasteMatch[1]!.length
      return new Cursor(this.measuredText, matchStart).modifyText(this)
    }

    return null
  }

  deleteWordAfter(): Cursor {
    if (this.isAtEnd()) {
      return this
    }

    const target = this.snapOutOfImageRef(this.nextWord().offset, 'end')
    return this.modifyText(new Cursor(this.measuredText, target))
  }

  private graphemeAt(pos: number): string {
    if (pos >= this.text.length) {
      return ''
    }
    const nextOff = this.measuredText.nextOffset(pos)
    return this.text.slice(pos, nextOff)
  }

  private isOverWhitespace(): boolean {
    const currentChar = this.text[this.offset] ?? ''
    return /\s/.test(currentChar)
  }

  equals(other: Cursor): boolean {
    return this.offset === other.offset && this.measuredText === other.measuredText
  }

  isAtStart(): boolean {
    return this.offset === 0
  }
  isAtEnd(): boolean {
    return this.offset >= this.text.length
  }

  startOfFirstLine(): Cursor {
    // 移到文本最开头，即第一行首字符
    return new Cursor(this.measuredText, 0, 0)
  }

  startOfLastLine(): Cursor {
    // 移到最后一行开头
    const lastNewlineIndex = this.text.lastIndexOf('\n')

    if (lastNewlineIndex === -1) {
      // 没有换行符时，文本只有一行
      return this.startOfLine()
    }

    // 定位到最后一个换行符之后
    return new Cursor(this.measuredText, lastNewlineIndex + 1, 0)
  }

  goToLine(lineNumber: number): Cursor {
    // 移到指定逻辑行开头，行号从 1 开始，与 vim 相同；使用由 \n 分隔的逻辑行，
    // 而非折行后的显示行
    const lines = this.text.split('\n')
    const targetLine = Math.min(Math.max(0, lineNumber - 1), lines.length - 1)
    let offset = 0
    for (let i = 0; i < targetLine; i++) {
      offset += (lines[i]?.length ?? 0) + 1 // +1 for newline
    }
    return new Cursor(this.measuredText, offset, 0)
  }

  endOfFile(): Cursor {
    return new Cursor(this.measuredText, this.text.length, 0)
  }

  public get text(): string {
    return this.measuredText.text
  }

  private get columns(): number {
    return this.measuredText.columns + 1
  }

  getPosition(): Position {
    return this.measuredText.getPositionFromOffset(this.offset)
  }

  private getOffset(position: Position): number {
    return this.measuredText.getOffsetFromPosition(position)
  }

  /**
   * 使用 vim f/F/t/T 语义查找字符。
   *
   * @param char - The character to find
   * @param type - 'f' (forward to), 'F' (backward to), 't' (forward till), 'T' (backward till)
   * @param count - Find the Nth occurrence
   * @returns The target offset, or null if not found
   */
  findCharacter(char: string, type: 'f' | 'F' | 't' | 'T', count: number = 1): number | null {
    const text = this.text
    const forward = type === 'f' || type === 't'
    const till = type === 't' || type === 'T'
    let found = 0

    if (forward) {
      let pos = this.measuredText.nextOffset(this.offset)
      while (pos < text.length) {
        const grapheme = this.graphemeAt(pos)
        if (grapheme === char) {
          found++
          if (found === count) {
            return till ? Math.max(this.offset, this.measuredText.prevOffset(pos)) : pos
          }
        }
        pos = this.measuredText.nextOffset(pos)
      }
    } else {
      if (this.offset === 0) {
        return null
      }
      let pos = this.measuredText.prevOffset(this.offset)
      while (pos >= 0) {
        const grapheme = this.graphemeAt(pos)
        if (grapheme === char) {
          found++
          if (found === count) {
            return till ? Math.min(this.offset, this.measuredText.nextOffset(pos)) : pos
          }
        }
        if (pos === 0) {
          break
        }
        pos = this.measuredText.prevOffset(pos)
      }
    }

    return null
  }
}

class WrappedLine {
  constructor(
    public readonly text: string,
    public readonly startOffset: number,
    public readonly isPrecededByNewline: boolean,
    public readonly endsWithNewline: boolean = false,
  ) {}

  equals(other: WrappedLine): boolean {
    return this.text === other.text && this.startOffset === other.startOffset
  }

  get length(): number {
    return this.text.length + (this.endsWithNewline ? 1 : 0)
  }
}

export class MeasuredText {
  private _wrappedLines?: WrappedLine[]
  public readonly text: string
  private navigationCache: Map<string, number>
  private graphemeBoundaries?: number[]

  constructor(
    text: string,
    readonly columns: number,
  ) {
    this.text = text.normalize('NFC')
    this.navigationCache = new Map()
  }

  /**
   * 延迟计算并缓存折行；仅在实际需要时执行这项高成本操作。
   */
  private get wrappedLines(): WrappedLine[] {
    if (!this._wrappedLines) {
      this._wrappedLines = this.measureWrappedText()
    }
    return this._wrappedLines
  }

  private getGraphemeBoundaries(): number[] {
    if (!this.graphemeBoundaries) {
      this.graphemeBoundaries = []
      for (const { index } of getGraphemeSegmenter().segment(this.text)) {
        this.graphemeBoundaries.push(index)
      }
      // 将文本末尾加入边界
      this.graphemeBoundaries.push(this.text.length)
    }
    return this.graphemeBoundaries
  }

  private wordBoundariesCache?: Array<{
    start: number
    end: number
    isWordLike: boolean
  }>

  /**
   * 使用 Intl.Segmenter 获取单词边界，正确进行 Unicode 单词分段。
   * 既能处理每个字符通常各自成词的 CJK（中文、日文、韩文），也能处理以空格分词的文字。
   */
  public getWordBoundaries(): Array<{
    start: number
    end: number
    isWordLike: boolean
  }> {
    if (!this.wordBoundariesCache) {
      this.wordBoundariesCache = []
      for (const segment of getWordSegmenter().segment(this.text)) {
        this.wordBoundariesCache.push({
          start: segment.index,
          end: segment.index + segment.segment.length,
          isWordLike: segment.isWordLike ?? false,
        })
      }
    }
    return this.wordBoundariesCache
  }

  /**
   * 二分查找边界。
   * @param boundaries: Sorted array of boundaries
   * @param target: Target offset
   * @param findNext: If true, finds first boundary > target. If false, finds last boundary < target.
   * @returns The found boundary index, or appropriate default
   */
  private binarySearchBoundary(boundaries: number[], target: number, findNext: boolean): number {
    let left = 0
    let right = boundaries.length - 1
    let result = findNext ? this.text.length : 0

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const boundary = boundaries[mid]
      if (boundary === undefined) {
        break
      }

      if (findNext) {
        if (boundary > target) {
          result = boundary
          right = mid - 1
        } else {
          left = mid + 1
        }
      } else {
        if (boundary < target) {
          result = boundary
          left = mid + 1
        } else {
          right = mid - 1
        }
      }
    }

    return result
  }

  // 将字符串索引转换为显示宽度
  public stringIndexToDisplayWidth(text: string, index: number): number {
    if (index <= 0) {
      return 0
    }
    if (index >= text.length) {
      return stringWidth(text)
    }
    return stringWidth(text.substring(0, index))
  }

  // 将显示宽度转换为字符串索引
  public displayWidthToStringIndex(text: string, targetWidth: number): number {
    if (targetWidth <= 0) {
      return 0
    }
    if (!text) {
      return 0
    }

    // 文本与当前文本相同时使用预计算的 grapheme
    if (text === this.text) {
      return this.offsetAtDisplayWidth(targetWidth)
    }

    // 否则即时计算
    let currentWidth = 0
    let currentOffset = 0

    for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
      const segmentWidth = stringWidth(segment)

      if (currentWidth + segmentWidth > targetWidth) {
        // 宽字符右半边：光标应放在字符之后（与 offsetAtDisplayWidth 一致）
        if (segmentWidth > 1 && targetWidth >= currentWidth + Math.ceil(segmentWidth / 2)) {
          currentOffset = index + segment.length
        }
        break
      }

      currentWidth += segmentWidth
      currentOffset = index + segment.length
    }

    return currentOffset
  }

  /**
   * 查找目标显示宽度对应的字符串 offset。
   */
  private offsetAtDisplayWidth(targetWidth: number): number {
    if (targetWidth <= 0) {
      return 0
    }

    let currentWidth = 0
    const boundaries = this.getGraphemeBoundaries()

    // 遍历 grapheme 边界
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]
      const end = boundaries[i + 1]
      if (start === undefined || end === undefined) {
        continue
      }
      const segment = this.text.substring(start, end)
      const segmentWidth = stringWidth(segment)

      if (currentWidth + segmentWidth > targetWidth) {
        // 宽字符（如中文）占 2 列。点击右半边时（targetWidth 超过字符中点），
        // 光标应放在字符之后（end），与终端标准行为一致。
        // JediTerm 等终端报告的鼠标坐标可落在字符中间任意列，
        // 而非对齐到字符边界，因此需要此判断。
        if (segmentWidth > 1 && targetWidth >= currentWidth + Math.ceil(segmentWidth / 2)) {
          return end
        }
        return start
      }
      currentWidth += segmentWidth
    }

    return this.text.length
  }

  private measureWrappedText(): WrappedLine[] {
    const wrappedText = wrapAnsi(this.text, this.columns, {
      hard: true,
      trim: false,
    })

    const wrappedLines: WrappedLine[] = []
    let searchOffset = 0
    let lastNewLinePos = -1

    const lines = wrappedText.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!
      const isPrecededByNewline = (startOffset: number) =>
        i === 0 || (startOffset > 0 && this.text[startOffset - 1] === '\n')

      if (text.length === 0) {
        // 对空行查找上一个换行符之后的下一个换行符
        lastNewLinePos = this.text.indexOf('\n', lastNewLinePos + 1)

        if (lastNewLinePos !== -1) {
          const startOffset = lastNewLinePos
          const endsWithNewline = true

          wrappedLines.push(
            new WrappedLine(text, startOffset, isPrecededByNewline(startOffset), endsWithNewline),
          )
        } else {
          // 找不到下一个换行符时，这里必定是文本末尾
          const startOffset = this.text.length
          wrappedLines.push(
            new WrappedLine(text, startOffset, isPrecededByNewline(startOffset), false),
          )
        }
      } else {
        // 对非空行，在 this.text 中查找文本
        const startOffset = this.text.indexOf(text, searchOffset)

        if (startOffset === -1) {
          throw new Error('Failed to find wrapped line in text')
        }

        searchOffset = startOffset + text.length

        // 检查此行在 this.text 中是否以换行符结束
        const potentialNewlinePos = startOffset + text.length
        const endsWithNewline =
          potentialNewlinePos < this.text.length && this.text[potentialNewlinePos] === '\n'

        if (endsWithNewline) {
          lastNewLinePos = potentialNewlinePos
        }

        wrappedLines.push(
          new WrappedLine(text, startOffset, isPrecededByNewline(startOffset), endsWithNewline),
        )
      }
    }

    return wrappedLines
  }

  public getWrappedText(): WrappedText {
    return this.wrappedLines.map((line) =>
      line.isPrecededByNewline ? line.text : line.text.trimStart(),
    )
  }

  public getWrappedLines(): WrappedLine[] {
    return this.wrappedLines
  }

  private getLine(line: number): WrappedLine {
    const lines = this.wrappedLines
    return lines[Math.max(0, Math.min(line, lines.length - 1))]!
  }

  public getOffsetFromPosition(position: Position): number {
    const wrappedLine = this.getLine(position.line)

    // 特殊处理空行
    if (wrappedLine.text.length === 0 && wrappedLine.endsWithNewline) {
      return wrappedLine.startOffset
    }

    // 计入前导空白
    const leadingWhitespace = wrappedLine.isPrecededByNewline
      ? 0
      : wrappedLine.text.length - wrappedLine.text.trimStart().length

    // 将显示列转换为字符串索引
    const displayColumnWithLeading = position.column + leadingWhitespace
    const stringIndex = this.displayWidthToStringIndex(wrappedLine.text, displayColumnWithLeading)

    // 计算实际 offset
    const offset = wrappedLine.startOffset + stringIndex

    // 普通行
    const lineEnd = wrappedLine.startOffset + wrappedLine.text.length

    // 除非位于整个文本末尾，否则不允许越过当前行末进入下一行
    let maxOffset = lineEnd
    const lineDisplayWidth = stringWidth(wrappedLine.text)
    if (wrappedLine.endsWithNewline && position.column > lineDisplayWidth) {
      // 允许定位到换行符之后
      maxOffset = lineEnd + 1
    }

    return Math.min(offset, maxOffset)
  }

  public getLineLength(line: number): number {
    const wrappedLine = this.getLine(line)
    return stringWidth(wrappedLine.text)
  }

  public getPositionFromOffset(offset: number): Position {
    const lines = this.wrappedLines
    for (let line = 0; line < lines.length; line++) {
      const currentLine = lines[line]!
      const nextLine = lines[line + 1]
      if (offset >= currentLine.startOffset && (!nextLine || offset < nextLine.startOffset)) {
        // 计算行内字符串位置
        const stringPosInLine = offset - currentLine.startOffset

        // 处理折行的前导空白
        let displayColumn: number
        if (currentLine.isPrecededByNewline) {
          // 前面是换行符的行直接计算显示宽度
          displayColumn = this.stringIndexToDisplayWidth(currentLine.text, stringPosInLine)
        } else {
          // 折行需要计入被裁掉的空白
          const leadingWhitespace = currentLine.text.length - currentLine.text.trimStart().length
          if (stringPosInLine < leadingWhitespace) {
            // 光标位于被裁掉的空白区域，定位到开头
            displayColumn = 0
          } else {
            // 根据裁剪后的文本计算显示宽度
            const trimmedText = currentLine.text.trimStart()
            const posInTrimmed = stringPosInLine - leadingWhitespace
            displayColumn = this.stringIndexToDisplayWidth(trimmedText, posInTrimmed)
          }
        }

        return {
          line,
          column: Math.max(0, displayColumn),
        }
      }
    }

    // 超过最后一个字符时返回最后一行末尾
    const line = lines.length - 1
    const lastLine = this.wrappedLines[line]!
    return {
      line,
      column: stringWidth(lastLine.text),
    }
  }

  public get lineCount(): number {
    return this.wrappedLines.length
  }

  private withCache<T>(key: string, compute: () => T): T {
    const cached = this.navigationCache.get(key)
    if (cached !== undefined) {
      return cached as T
    }

    const result = compute()
    this.navigationCache.set(key, result as number)
    return result
  }

  nextOffset(offset: number): number {
    return this.withCache(`next:${offset}`, () => {
      const boundaries = this.getGraphemeBoundaries()
      return this.binarySearchBoundary(boundaries, offset, true)
    })
  }

  prevOffset(offset: number): number {
    if (offset <= 0) {
      return 0
    }

    return this.withCache(`prev:${offset}`, () => {
      const boundaries = this.getGraphemeBoundaries()
      return this.binarySearchBoundary(boundaries, offset, false)
    })
  }

  /**
   * 将任意 code-unit offset 吸附到其所在 grapheme 的起点；offset 已在边界时原样返回。
   */
  snapToGraphemeBoundary(offset: number): number {
    if (offset <= 0) {
      return 0
    }
    if (offset >= this.text.length) {
      return this.text.length
    }
    const boundaries = this.getGraphemeBoundaries()
    // 二分查找不大于 offset 的最大边界
    let lo = 0
    let hi = boundaries.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (boundaries[mid]! <= offset) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    return boundaries[lo]!
  }
}
