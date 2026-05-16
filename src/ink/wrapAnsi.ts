import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function' ? Bun.wrapAnsi : null

const wrapAnsiInner: (input: string, columns: number, options?: WrapAnsiOptions) => string =
  wrapAnsiBun ?? wrapAnsiNpm

// 匹配行尾不完整的 CSI 序列前缀：\x1b[ 后跟可选的数字和分号参数，但缺少终止字符（如 m）
const INCOMPLETE_CSI_AT_EOL = /\x1b\[[0-9;]*$/

/**
 * 修复 wrapAnsi 换行时截断 ANSI 转义序列的问题。
 * 当 Bun.wrapAnsi 或 wrap-ansi 在 CSI 序列中间插入换行时，
 * 行尾会残留不完整的 \x1b[38;5;，下一行开头变成 153m 这样的明文。
 * 修复策略：将行尾的不完整前缀移到下一行开头拼接，恢复完整序列。
 */
function repairTruncatedAnsiSequences(text: string): string {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const match = lines[i]!.match(INCOMPLETE_CSI_AT_EOL)
    if (match) {
      // 将不完整的前缀从当前行尾移除，拼接到下一行开头
      lines[i] = lines[i]!.slice(0, -match[0].length)
      lines[i + 1] = match[0] + lines[i + 1]!
    }
  }
  return lines.join('\n')
}

function wrapAnsi(input: string, columns: number, options?: WrapAnsiOptions): string {
  return repairTruncatedAnsiSequences(wrapAnsiInner(input, columns, options))
}

export { wrapAnsi }
