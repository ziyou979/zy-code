import chalk from 'chalk'
import { ctrlOToExpand } from '../components/CtrlOToExpand.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from '../terminal-ui/sliceAnsi.js'

// 终端文本渲染工具。
const MAX_LINES_TO_SHOW = 3
// 为 MessageResponse 前缀（“  ⎿ ”占 5 个字符）及父级宽度缩减留出空间；
// 工具结果渲染时使用 columns - 5。
const PADDING_TO_PREVENT_OVERFLOW = 10

/**
 * 在字符串中插入换行，使其按指定宽度折行。
 * 使用能识别 ANSI 的切片方式，避免拆断转义序列。
 * @param text 要折行的文本
 * @param wrapWidth 折行宽度，以可见字符计
 * @returns 折行后的文本
 */
function wrapText(
  text: string,
  wrapWidth: number,
): { aboveTheFold: string; remainingLines: number } {
  const lines = text.split('\n')
  const wrappedLines: string[] = []

  for (const line of lines) {
    const visibleWidth = stringWidth(line)
    if (visibleWidth <= wrapWidth) {
      wrappedLines.push(line.trimEnd())
    } else {
      // 使用能识别 ANSI 的切片方式，将长行拆成 wrapWidth 个可见字符的片段，
      // 同时保留转义序列。
      let position = 0
      while (position < visibleWidth) {
        const chunk = sliceAnsi(line, position, position + wrapWidth)
        wrappedLines.push(chunk.trimEnd())
        position += wrapWidth
      }
    }
  }

  const remainingLines = wrappedLines.length - MAX_LINES_TO_SHOW

  // 折叠后只剩一行时直接显示，不提示“... +1 line (ctrl+o to expand)”。
  if (remainingLines === 1) {
    return {
      aboveTheFold: wrappedLines
        .slice(0, MAX_LINES_TO_SHOW + 1)
        .join('\n')
        .trimEnd(),
      remainingLines: 0, // All lines are shown, nothing remaining
    }
  }

  // 否则按标准的 MAX_LINES_TO_SHOW 显示。
  return {
    aboveTheFold: wrappedLines.slice(0, MAX_LINES_TO_SHOW).join('\n').trimEnd(),
    remainingLines: Math.max(0, remainingLines),
  }
}

/**
 * 为终端显示按行截断并渲染内容。
 * 内容超过最大行数时进行截断，并补充提示说明剩余行数。
 * @param content 要渲染的内容
 * @param terminalWidth 用于折行的终端宽度
 * @returns 必要时经过截断的渲染内容
 */
export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint = false,
): string {
  const trimmedContent = content.trimEnd()
  if (!trimmedContent) {
    return ''
  }

  const wrapWidth = Math.max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW, 10)

  // 只处理足以填满可见行的内容，避免对超大输出做 O(n) 折行；
  // 例如 64MB 二进制 dump 可能产生 38.2 万行屏幕内容。
  const maxChars = MAX_LINES_TO_SHOW * wrapWidth * 4
  const preTruncated = trimmedContent.length > maxChars
  const contentForWrapping = preTruncated ? trimmedContent.slice(0, maxChars) : trimmedContent

  const { aboveTheFold, remainingLines } = wrapText(contentForWrapping, wrapWidth)

  const estimatedRemaining = preTruncated
    ? Math.max(remainingLines, Math.ceil(trimmedContent.length / wrapWidth) - MAX_LINES_TO_SHOW)
    : remainingLines

  return [
    aboveTheFold,
    estimatedRemaining > 0
      ? chalk.dim(
          `… +${estimatedRemaining} lines${suppressExpandHint ? '' : ` ${ctrlOToExpand()}`}`,
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 快速检查 OutputLine 是否会截断此内容。这里只统计原始换行，不考虑终端宽度折行，
 *  因此一条超长行折成超过 3 个可视行时可能返回 false；常见情况是多行输出，故可接受。 */
export function isOutputLineTruncated(content: string): boolean {
  let pos = 0
  // 换行数必须超过 MAX_LINES_TO_SHOW，即内容占用超过 3 行。
  // +1 是因为 remainingLines==1 时 wrapText 会额外显示一行。
  for (let i = 0; i <= MAX_LINES_TO_SHOW; i++) {
    pos = content.indexOf('\n', pos)
    if (pos === -1) {
      return false
    }
    pos++
  }
  // 尾随换行是终止符，不代表新增一行；与 renderTruncatedContent 的 trimEnd() 行为保持一致。
  return pos < content.length
}
