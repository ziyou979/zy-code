/**
 * Vim 操作符函数
 *
 * 用于执行 vim 操作符（删除、更改、复制等）的纯函数
 */

import { Cursor } from '../terminal-ui/cursor.js'
import { firstGrapheme, lastGrapheme } from '../utils/intl.js'
import { countCharInString } from '../utils/stringUtils.js'
import { isInclusiveMotion, isLinewiseMotion, resolveMotion } from './motions.js'
import { findTextObject } from './textObjects.js'
import type { FindType, Operator, RecordedChange, TextObjScope } from './types.js'

/**
 * 执行 operator 时使用的上下文。
 */
export type OperatorContext = {
  cursor: Cursor
  text: string
  setText: (text: string) => void
  setOffset: (offset: number) => void
  enterInsert: (offset: number) => void
  getRegister: () => string
  setRegister: (content: string, linewise: boolean) => void
  getLastFind: () => { type: FindType; char: string } | null
  setLastFind: (type: FindType, char: string) => void
  recordChange: (change: RecordedChange) => void
}

/**
 * 使用简单 motion 执行 operator。
 */
export function executeOperatorMotion(
  op: Operator,
  motion: string,
  count: number,
  ctx: OperatorContext,
): void {
  const target = resolveMotion(motion, ctx.cursor, count)
  if (target.equals(ctx.cursor)) {
    return
  }

  const range = getOperatorRange(ctx.cursor, target, motion, op, count)
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion, count })
}

/**
 * 使用 find motion 执行 operator。
 */
export function executeOperatorFind(
  op: Operator,
  findType: FindType,
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  const targetOffset = ctx.cursor.findCharacter(char, findType, count)
  if (targetOffset === null) {
    return
  }

  const target = new Cursor(ctx.cursor.measuredText, targetOffset)
  const range = getOperatorRangeForFind(ctx.cursor, target, findType)

  applyOperator(op, range.from, range.to, ctx)
  ctx.setLastFind(findType, char)
  ctx.recordChange({ type: 'operatorFind', op, find: findType, char, count })
}

/**
 * 使用 text object 执行 operator。
 */
export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  const range = findTextObject(ctx.text, ctx.cursor.offset, objType, scope === 'inner')
  if (!range) {
    return
  }

  applyOperator(op, range.start, range.end, ctx)
  ctx.recordChange({ type: 'operatorTextObj', op, objType, scope, count })
}

/**
 * 执行整行操作（dd、cc、yy）。
 */
export function executeLineOp(op: Operator, count: number, ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  // 统计光标 offset 前的换行符来计算逻辑行；cursor.getPosition() 返回折行后的行，
  // 不适用于这里。
  const currentLine = countCharInString(text.slice(0, ctx.cursor.offset), '\n')
  const linesToAffect = Math.min(count, lines.length - currentLine)
  const lineStart = ctx.cursor.startOfLogicalLine().offset
  let lineEnd = lineStart
  for (let i = 0; i < linesToAffect; i++) {
    const nextNewline = text.indexOf('\n', lineEnd)
    lineEnd = nextNewline === -1 ? text.length : nextNewline + 1
  }

  let content = text.slice(lineStart, lineEnd)
  // 确保 linewise 内容以换行结尾，便于粘贴时识别。
  if (!content.endsWith('\n')) {
    content = `${content}\n`
  }
  ctx.setRegister(content, true)

  if (op === 'yank') {
    ctx.setOffset(lineStart)
  } else if (op === 'delete') {
    let deleteStart = lineStart
    const deleteEnd = lineEnd

    // 删除到文件末尾时若前面有换行则一并包含，避免删除末行后留下尾随换行。
    if (deleteEnd === text.length && deleteStart > 0 && text[deleteStart - 1] === '\n') {
      deleteStart -= 1
    }

    const newText = text.slice(0, deleteStart) + text.slice(deleteEnd)
    ctx.setText(newText || '')
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1))
    ctx.setOffset(Math.min(deleteStart, maxOff))
  } else if (op === 'change') {
    // 只有一行时直接清空。
    if (lines.length === 1) {
      ctx.setText('')
      ctx.enterInsert(0)
    } else {
      // 删除所有受影响的行，以单个空行替代并进入 insert 模式。
      const beforeLines = lines.slice(0, currentLine)
      const afterLines = lines.slice(currentLine + linesToAffect)
      const newText = [...beforeLines, '', ...afterLines].join('\n')
      ctx.setText(newText)
      ctx.enterInsert(lineStart)
    }
  }

  ctx.recordChange({ type: 'operator', op, motion: op[0]!, count })
}

/**
 * 执行删除字符操作（x 命令）。
 */
export function executeX(count: number, ctx: OperatorContext): void {
  const from = ctx.cursor.offset

  if (from >= ctx.text.length) {
    return
  }

  // 按 grapheme 而不是 code unit 前进。
  let endCursor = ctx.cursor
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) {
    endCursor = endCursor.right()
  }
  const to = endCursor.offset

  const deleted = ctx.text.slice(from, to)
  const newText = ctx.text.slice(0, from) + ctx.text.slice(to)

  ctx.setRegister(deleted, false)
  ctx.setText(newText)
  const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1))
  ctx.setOffset(Math.min(from, maxOff))
  ctx.recordChange({ type: 'x', count })
}

/**
 * 执行替换字符操作（r 命令）。
 */
export function executeReplace(char: string, count: number, ctx: OperatorContext): void {
  let offset = ctx.cursor.offset
  let newText = ctx.text

  for (let i = 0; i < count && offset < newText.length; i++) {
    const graphemeLen = firstGrapheme(newText.slice(offset)).length || 1
    newText = newText.slice(0, offset) + char + newText.slice(offset + graphemeLen)
    offset += char.length
  }

  ctx.setText(newText)
  ctx.setOffset(Math.max(0, offset - char.length))
  ctx.recordChange({ type: 'replace', char, count })
}

/**
 * 执行大小写切换操作（~ 命令）。
 */
export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const startOffset = ctx.cursor.offset

  if (startOffset >= ctx.text.length) {
    return
  }

  let newText = ctx.text
  let offset = startOffset
  let toggled = 0

  while (offset < newText.length && toggled < count) {
    const grapheme = firstGrapheme(newText.slice(offset))
    const graphemeLen = grapheme.length

    const toggledGrapheme =
      grapheme === grapheme.toUpperCase() ? grapheme.toLowerCase() : grapheme.toUpperCase()

    newText = newText.slice(0, offset) + toggledGrapheme + newText.slice(offset + graphemeLen)
    offset += toggledGrapheme.length
    toggled++
  }

  ctx.setText(newText)
  // 光标移动到最后一个切换字符之后；位于行尾时可处在“end”位置。
  ctx.setOffset(offset)
  ctx.recordChange({ type: 'toggleCase', count })
}

/**
 * 执行合并行操作（J 命令）。
 */
export function executeJoin(count: number, ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()

  if (currentLine >= lines.length - 1) {
    return
  }

  const linesToJoin = Math.min(count, lines.length - currentLine - 1)
  let joinedLine = lines[currentLine]!
  const cursorPos = joinedLine.length

  for (let i = 1; i <= linesToJoin; i++) {
    const nextLine = (lines[currentLine + i] ?? '').trimStart()
    if (nextLine.length > 0) {
      if (!joinedLine.endsWith(' ') && joinedLine.length > 0) {
        joinedLine += ' '
      }
      joinedLine += nextLine
    }
  }

  const newLines = [
    ...lines.slice(0, currentLine),
    joinedLine,
    ...lines.slice(currentLine + linesToJoin + 1),
  ]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(newLines, currentLine) + cursorPos)
  ctx.recordChange({ type: 'join', count })
}

/**
 * 执行粘贴操作（p/P 命令）。
 */
export function executePaste(after: boolean, count: number, ctx: OperatorContext): void {
  const register = ctx.getRegister()
  if (!register) {
    return
  }

  const isLinewise = register.endsWith('\n')
  const content = isLinewise ? register.slice(0, -1) : register

  if (isLinewise) {
    const text = ctx.text
    const lines = text.split('\n')
    const { line: currentLine } = ctx.cursor.getPosition()

    const insertLine = after ? currentLine + 1 : currentLine
    const contentLines = content.split('\n')
    const repeatedLines: string[] = []
    for (let i = 0; i < count; i++) {
      repeatedLines.push(...contentLines)
    }

    const newLines = [...lines.slice(0, insertLine), ...repeatedLines, ...lines.slice(insertLine)]

    const newText = newLines.join('\n')
    ctx.setText(newText)
    ctx.setOffset(getLineStartOffset(newLines, insertLine))
  } else {
    const textToInsert = content.repeat(count)
    const insertPoint =
      after && ctx.cursor.offset < ctx.text.length
        ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset)
        : ctx.cursor.offset

    const newText = ctx.text.slice(0, insertPoint) + textToInsert + ctx.text.slice(insertPoint)
    const lastGr = lastGrapheme(textToInsert)
    const newOffset = insertPoint + textToInsert.length - (lastGr.length || 1)

    ctx.setText(newText)
    ctx.setOffset(Math.max(insertPoint, newOffset))
  }
}

/**
 * 执行缩进操作（>> 命令）。
 */
export function executeIndent(dir: '>' | '<', count: number, ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()
  const linesToAffect = Math.min(count, lines.length - currentLine)
  const indent = '  ' // Two spaces

  for (let i = 0; i < linesToAffect; i++) {
    const lineIdx = currentLine + i
    const line = lines[lineIdx] ?? ''

    if (dir === '>') {
      lines[lineIdx] = indent + line
    } else if (line.startsWith(indent)) {
      lines[lineIdx] = line.slice(indent.length)
    } else if (line.startsWith('\t')) {
      lines[lineIdx] = line.slice(1)
    } else {
      // 尽量删除行首空白，但不超过缩进长度。
      let removed = 0
      let idx = 0
      while (idx < line.length && removed < indent.length && /\s/.test(line[idx]!)) {
        removed++
        idx++
      }
      lines[lineIdx] = line.slice(idx)
    }
  }

  const newText = lines.join('\n')
  const currentLineText = lines[currentLine] ?? ''
  const firstNonBlank = (currentLineText.match(/^\s*/)?.[0] ?? '').length

  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank)
  ctx.recordChange({ type: 'indent', dir, count })
}

/**
 * 执行新开一行操作（o/O 命令）。
 */
export function executeOpenLine(direction: 'above' | 'below', ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()

  const insertLine = direction === 'below' ? currentLine + 1 : currentLine
  const newLines = [...lines.slice(0, insertLine), '', ...lines.slice(insertLine)]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.enterInsert(getLineStartOffset(newLines, insertLine))
  ctx.recordChange({ type: 'openLine', direction })
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 计算行首位置的 offset。
 */
function getLineStartOffset(lines: string[], lineIndex: number): number {
  return lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0)
}

function getOperatorRange(
  cursor: Cursor,
  target: Cursor,
  motion: string,
  op: Operator,
  count: number,
): { from: number; to: number; linewise: boolean } {
  let from = Math.min(cursor.offset, target.offset)
  let to = Math.max(cursor.offset, target.offset)
  let linewise = false

  // 特殊情况：cw/cW 修改到单词末尾，而不是下一个单词开头。
  if (op === 'change' && (motion === 'w' || motion === 'W')) {
    // cw 带 count 时先前进 count-1 个单词，再查找该单词末尾。
    let wordCursor = cursor
    for (let i = 0; i < count - 1; i++) {
      wordCursor = motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD()
    }
    const wordEnd = motion === 'w' ? wordCursor.endOfVimWord() : wordCursor.endOfWORD()
    to = cursor.measuredText.nextOffset(wordEnd.offset)
  } else if (isLinewiseMotion(motion)) {
    // linewise motion 扩展到包含完整行。
    linewise = true
    const text = cursor.text
    const nextNewline = text.indexOf('\n', to)
    if (nextNewline === -1) {
      // 删除到文件末尾时，若前面有换行则一并包含。
      to = text.length
      if (from > 0 && text[from - 1] === '\n') {
        from -= 1
      }
    } else {
      to = nextNewline + 1
    }
  } else if (isInclusiveMotion(motion) && cursor.offset <= target.offset) {
    to = cursor.measuredText.nextOffset(to)
  }

  // word motion 可能落在 [Image #N] chip 内；扩展范围以覆盖整个 chip，
  // 避免 dw/cw/yw 留下残缺占位符。
  from = cursor.snapOutOfImageRef(from, 'start')
  to = cursor.snapOutOfImageRef(to, 'end')

  return { from, to, linewise }
}

/**
 * 获取基于 find 的 operator 范围。
 * 注意：_findType 未使用，因为 Cursor.findCharacter 已为 t/T motion 调整 offset；
 * 此处所有 find 类型都按包含目标位置处理。
 */
function getOperatorRangeForFind(
  cursor: Cursor,
  target: Cursor,
  _findType: FindType,
): { from: number; to: number } {
  const from = Math.min(cursor.offset, target.offset)
  const maxOffset = Math.max(cursor.offset, target.offset)
  const to = cursor.measuredText.nextOffset(maxOffset)
  return { from, to }
}

function applyOperator(
  op: Operator,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise: boolean = false,
): void {
  let content = ctx.text.slice(from, to)
  // 确保 linewise 内容以换行结尾，便于粘贴时识别。
  if (linewise && !content.endsWith('\n')) {
    content = `${content}\n`
  }
  ctx.setRegister(content, linewise)

  if (op === 'yank') {
    ctx.setOffset(from)
  } else if (op === 'delete') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1))
    ctx.setOffset(Math.min(from, maxOff))
  } else if (op === 'change') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to)
    ctx.setText(newText)
    ctx.enterInsert(from)
  }
}

/**
 * 在 visual mode 中对选区执行操作符。
 * 选区由 anchor（按 v 时的偏移量）和当前光标位置定义。
 */
export function executeVisualOperator(
  op: Operator,
  anchor: number,
  cursorOffset: number,
  ctx: OperatorContext,
): void {
  if (anchor === cursorOffset) {
    return
  }

  const from = Math.min(anchor, cursorOffset)
  const to = Math.max(anchor, cursorOffset)
  // 选区包含结束字符（vim visual mode inclusive）
  const inclusiveTo = ctx.cursor.measuredText.nextOffset(to)

  applyOperator(op, from, inclusiveTo, ctx)
}

/**
 * 在 visual mode 中对选区中的每一行执行缩进。
 */
export function executeVisualIndent(
  dir: '>' | '<',
  anchor: number,
  cursorOffset: number,
  ctx: OperatorContext,
): void {
  const from = Math.min(anchor, cursorOffset)
  const to = Math.max(anchor, cursorOffset)

  let lineStart = from
  while (lineStart > 0 && ctx.text[lineStart - 1] !== '\n') {
    lineStart--
  }

  let lineEnd = to
  while (lineEnd < ctx.text.length && ctx.text[lineEnd] !== '\n') {
    lineEnd++
  }

  const affectedText = ctx.text.slice(lineStart, lineEnd)
  const lines = affectedText.split('\n')
  const indent = '  '

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (dir === '>') {
      lines[i] = indent + line
    } else if (line.startsWith(indent)) {
      lines[i] = line.slice(indent.length)
    } else if (line.startsWith('\t')) {
      lines[i] = line.slice(1)
    } else {
      let removed = 0
      let idx = 0
      while (idx < line.length && removed < indent.length && /\s/.test(line[idx]!)) {
        removed++
        idx++
      }
      lines[i] = line.slice(idx)
    }
  }

  const newText = ctx.text.slice(0, lineStart) + lines.join('\n') + ctx.text.slice(lineEnd)
  ctx.setText(newText)
  ctx.setOffset(lineStart)
  ctx.recordChange({ type: 'indent', dir, count: 1 })
}

/**
 * 在 visual mode 中对选区中的每个字符切换大小写。
 */
export function executeVisualToggleCase(
  anchor: number,
  cursorOffset: number,
  ctx: OperatorContext,
): void {
  const from = Math.min(anchor, cursorOffset)
  const to = Math.max(anchor, cursorOffset)
  const inclusiveTo = ctx.cursor.measuredText.nextOffset(to)

  let newText = ctx.text
  let offset = from

  while (offset < inclusiveTo && offset < newText.length) {
    const grapheme = firstGrapheme(newText.slice(offset))
    const graphemeLen = grapheme.length
    const toggled =
      grapheme === grapheme.toUpperCase() ? grapheme.toLowerCase() : grapheme.toUpperCase()
    newText = newText.slice(0, offset) + toggled + newText.slice(offset + graphemeLen)
    offset += toggled.length
  }

  ctx.setText(newText)
  ctx.setOffset(from)
  ctx.recordChange({ type: 'toggleCase', count: 1 })
}

export function executeOperatorG(op: Operator, count: number, ctx: OperatorContext): void {
  // count=1 表示未指定计数，目标为文件末尾；否则目标为第 N 行。
  const target = count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count)

  if (target.equals(ctx.cursor)) {
    return
  }

  const range = getOperatorRange(ctx.cursor, target, 'G', op, count)
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion: 'G', count })
}

export function executeOperatorGg(op: Operator, count: number, ctx: OperatorContext): void {
  // count=1 表示未指定计数，目标为首行；否则目标为第 N 行。
  const target = count === 1 ? ctx.cursor.startOfFirstLine() : ctx.cursor.goToLine(count)

  if (target.equals(ctx.cursor)) {
    return
  }

  const range = getOperatorRange(ctx.cursor, target, 'gg', op, count)
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion: 'gg', count })
}
