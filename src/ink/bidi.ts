/**
 * 用于终端渲染的双向文本重排序。
 *
 * Windows 上的终端没有实现 Unicode 双向算法，
 * 因此 RTL 文本（希伯来语、阿拉伯语等）会显示为反向。本模块
 * 在 Ink 的 LTR 单元格放置循环之前，对 ClusteredChar 数组
 * 应用双向算法，将其从逻辑顺序重排为视觉顺序。
 *
 * macOS 终端（Terminal.app、iTerm2）原生支持双向算法。
 * Windows Terminal（包括 WSL）没有实现双向算法
 * (https://github.com/microsoft/terminal/issues/538)。
 *
 * 检测：Windows Terminal 会设置 WT_SESSION 环境变量；原生 Windows
 * cmd/conhost 同样不支持双向算法。当运行在 Windows 或
 * Windows Terminal 内时（覆盖 WSL），我们启用双向重排序。
 */
import bidiFactory from 'bidi-js'

type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

let bidiInstance: ReturnType<typeof bidiFactory> | undefined
let needsSoftwareBidi: boolean | undefined

function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    needsSoftwareBidi =
      process.platform === 'win32' ||
      typeof process.env.WT_SESSION === 'string' || // WSL in Windows Terminal
      process.env.TERM_PROGRAM === 'vscode' // VS Code integrated terminal (xterm.js)
  }
  return needsSoftwareBidi
}

function getBidi() {
  if (!bidiInstance) {
    bidiInstance = bidiFactory()
  }
  return bidiInstance
}

/**
 * 使用 Unicode 双向算法将 ClusteredChar 数组从逻辑顺序
 * 重排为视觉顺序。在缺乏原生双向支持的终端上生效
 *（Windows Terminal、conhost、WSL）。
 *
 * 在支持双向的终端上直接返回原数组（无操作）。
 */
export function reorderBidi(characters: ClusteredChar[]): ClusteredChar[] {
  if (!needsBidi() || characters.length === 0) {
    return characters
  }

  // 从 ClusteredChar 构建纯字符串，交给 bidi 处理
  const plainText = characters.map((c) => c.value).join('')

  // 检查是否包含 RTL 字符 — 纯 LTR 文本跳过 bidi
  if (!hasRTLCharacters(plainText)) {
    return characters
  }

  const bidi = getBidi()
  const { levels } = bidi.getEmbeddingLevels(plainText, 'auto')

  // 将 bidi 级别映射回 ClusteredChar 索引。
  // 每个 ClusteredChar 在拼接后的字符串中可能对应多个 code unit。
  const charLevels: number[] = []
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    charLevels.push(levels[offset]!)
    offset += characters[i]!.value.length
  }

  // 从 bidi-js 获取重排序片段，但我们需要在
  // ClusteredChar 级别操作，而不是字符串级别。我们实现
  // 标准的双向重排序：找到最大级别，然后从最大到 1
  // 逐级反转所有连续的 >= 该级别的区间。
  const reordered = [...characters]
  const maxLevel = Math.max(...charLevels)

  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < reordered.length) {
      if (charLevels[i]! >= level) {
        // 找到这个区间的末尾
        let j = i + 1
        while (j < reordered.length && charLevels[j]! >= level) {
          j++
        }
        // 在两个数组中同时反转该区间
        reverseRange(reordered, i, j - 1)
        reverseRangeNumbers(charLevels, i, j - 1)
        i = j
      } else {
        i++
      }
    }
  }

  return reordered
}

function reverseRange<T>(arr: T[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

function reverseRangeNumbers(arr: number[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

/**
 * 快速检测 RTL 字符（希伯来语、阿拉伯语及相关文字）。
 * 避免在纯 LTR 文本上运行完整的双向算法。
 */
function hasRTLCharacters(text: string): boolean {
  // 希伯来语: U+0590-U+05FF, U+FB1D-U+FB4F
  // 阿拉伯语: U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF, U+FB50-U+FDFF, U+FE70-U+FEFF
  // 塔纳文: U+0780-U+07BF
  // 叙利亚文: U+0700-U+074F
  return /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/u.test(
    text,
  )
}
