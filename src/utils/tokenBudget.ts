// 简写形式（+500k）锚定在开头/结尾，避免在自然语言中产生误匹配。
// 完整形式（use/spend 2M tokens）可在任意位置匹配。
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
// 避免使用后行断言 (?<=\s) —— 它会使 JSC 中的 YARR JIT 失效，
// 即使有 $ 锚点，解释器仍然会进行 O(n) 扫描。改为捕获空白字符；
// 在需要精确位置时，调用方将 match.index 偏移 1。
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
const VERBOSE_RE_G = new RegExp(VERBOSE_RE.source, 'gi')

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

function parseBudgetMatch(value: string, suffix: string): number {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!
}

export function parseTokenBudget(text: string): number | null {
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    return parseBudgetMatch(startMatch[1]!, startMatch[2]!)
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    return parseBudgetMatch(endMatch[1]!, endMatch[2]!)
  }
  const verboseMatch = text.match(VERBOSE_RE)
  if (verboseMatch) {
    return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!)
  }
  return null
}

export function findTokenBudgetPositions(text: string): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    const offset = startMatch.index! + startMatch[0].length - startMatch[0].trimStart().length
    positions.push({
      start: offset,
      end: startMatch.index! + startMatch[0].length,
    })
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    // 避免重复计数，例如输入仅为 "+500k" 时
    const endStart = endMatch.index! + 1 // +1: 正则包含前导 \s
    const alreadyCovered = positions.some((p) => endStart >= p.start && endStart < p.end)
    if (!alreadyCovered) {
      positions.push({
        start: endStart,
        end: endMatch.index! + endMatch[0].length,
      })
    }
  }
  for (const match of text.matchAll(VERBOSE_RE_G)) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}

export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working \u2014 do not summarize.`
}
