import { lineWidth } from './lineWidthCache.js'

export function widestLine(string: string): number {
  let maxWidth = 0
  let start = 0

  while (start <= string.length) {
    const end = string.indexOf('\n', start)
    const line = end === -1 ? string.substring(start) : string.substring(start, end)

    maxWidth = Math.max(maxWidth, lineWidth(line))

    if (end === -1) {
      break
    }
    start = end + 1
  }

  return maxWidth
}

/**
 * 判断文本任一行是否超过 maxWidth。比 `widestLine(str) > maxWidth` 更高效：
 *   - 纯 ASCII 行就地计数，零分配
 *   - 任一行超宽立即短路返回
 *   - 含非 ASCII/ESC 的行才落回 substring + lineWidthCache
 * 流式输出中多数行是纯 ASCII，此函数可避免大量子串分配和测量。
 */
export function exceedsWidth(str: string, maxWidth: number): boolean {
  let start = 0
  while (start <= str.length) {
    const end = str.indexOf('\n', start)
    const lineEnd = end === -1 ? str.length : end

    // ASCII 快路径：就地计数，零分配
    let asciiWidth = 0
    let pureAscii = true
    for (let i = start; i < lineEnd; i++) {
      const code = str.charCodeAt(i)
      if (code >= 127 || code === 0x1b) {
        pureAscii = false
        break
      }
      if (code > 0x1f && ++asciiWidth > maxWidth) {
        return true
      }
    }

    if (!pureAscii) {
      // 含非 ASCII/控制字符的行：子串分配 + lineWidth（走缓存）
      if (lineWidth(str.substring(start, lineEnd)) > maxWidth) {
        return true
      }
    }

    if (end === -1) break
    start = end + 1
  }
  return false
}
