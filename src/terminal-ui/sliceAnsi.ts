import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '../ink/stringWidth.js'

// code 与 endCode 相同时视为“结束码”（如关闭超链接）
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// 只保留“起始码”，排除结束码
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter((c) => !isEndCode(c))
}

/**
 * 截取含 ANSI 转义码的字符串。
 *
 * 与 slice-ansi 包不同，@alcalzone/ansi-tokenize 能正确分词 OSC 8 超链接序列，
 * 因此本实现可正确处理这些序列。
 */
export default function sliceAnsi(str: string, start: number, end?: number): string {
  // 不把 `end` 传给 tokenize：它按 code unit 而非显示单元格计数，
  // 遇到含零宽组合符的文本时会过早丢弃 token。
  const tokens = tokenize(str)
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // 按显示宽度而非 code unit 推进。组合符（天城文 matra、virama、附加符号）宽度为 0；
    // 若按 .length 计数，position 会过早越过 `end` 并截断内容。调用方通过 stringWidth
    // 以显示单元格传入 start/end，因此 position 必须使用相同单位。
    const width = token.type === 'ansi' ? 0 : token.fullWidth ? 2 : stringWidth(token.value)

    // 尾随零宽符处理完成后再退出：组合符依附于前一个基础字符，因此 "भा"
    //（भ + ा，占 1 个显示单元格）在 end=1 截取时必须包含 ा。若在零宽检查前就因
    // position >= end 退出，会丢掉该符号，只渲染 भ。ANSI 码宽度虽为 0，越过 end 后
    // 仍不能纳入，否则会开启新的样式区间并泄漏到撤销序列，所以还需按字符类型限制。
    // !include 可确保空切片（start===end）即使以零宽字符（BOM、ZWJ）开头也保持为空。
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !include) {
        break
      }
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // 截取范围内输出全部 ANSI 码
        result += token.code
      }
    } else {
      if (!include && position >= start) {
        // 跳过起始边界上的前导零宽符，它们属于左半部分的前一个基础字符。
        // 否则该符号会同时出现在两半，导致 left+right ≠ original。
        // 仅在 start > 0 时适用，因为起点为 0 时不存在可归属的前置字符。
        if (start > 0 && width === 0) {
          continue
        }
        include = true
        // 归约后只保留仍然活跃的起始码
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        result += token.value
      }

      position += width
    }
  }

  // 只撤销仍然活跃的起始码
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return result
}
