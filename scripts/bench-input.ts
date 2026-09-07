/**
 * 临时基准脚本 2：量化每键 regex 扫描组 + 高亮分段的耗时（跑完即删）。
 * hasCommand/getCommands 依赖配置加载，bench 中跳过（单次为 O(commands) find，
 * 微秒级）。用法：bun scripts/bench-input.ts
 */
import { findSlashCommandPositions } from '../src/services/suggestions/commandSuggestions.js'
import { findBtwTriggerPositions } from '../src/services/assistant/sideQuestion.js'
import { findThinkingTriggerPositions } from '../src/services/messages/thinking.js'
import { findTokenBudgetPositions } from '../src/services/api/tokenBudget.js'
import { findSlackChannelPositions } from '../src/services/suggestions/slackChannelSuggestions.js'
import { parseReferences } from '../src/services/session-storage/history.js'
import { segmentTextByHighlights } from '../src/terminal-ui/textHighlighting.js'

const zh130 = '这是一个测试输入的中文文本，用于测量扫描性能。'.repeat(5)
const zh520 = zh130.repeat(4)
const slashInput = '/help 帮我写一个函数 btw 重新看一下 ' + zh130

function bench(name: string, fn: () => void, iterations = 2000): void {
  for (let i = 0; i < 50; i++) {
    fn()
  }
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    fn()
  }
  const perOp = (performance.now() - start) / iterations
  console.log(`${name.padEnd(52)} ${(perOp * 1000).toFixed(1)} µs/op`)
}

for (const [label, text] of [
  ['zh 130', zh130],
  ['zh 520', zh520],
] as const) {
  console.log(`--- ${label} ---`)
  bench('findThinkingTriggerPositions', () => findThinkingTriggerPositions(text))
  bench('findBtwTriggerPositions', () => findBtwTriggerPositions(text))
  bench('findTokenBudgetPositions', () => findTokenBudgetPositions(text))
  bench('findSlackChannelPositions', () => findSlackChannelPositions(text))
  bench('findSlashCommandPositions', () => findSlashCommandPositions(text))
  bench('parseReferences', () => parseReferences(text))
}

console.log('--- slash/btw 混合输入 170 chars（6 项合并，无 hasCommand） ---')
bench('all scans combined (slash input)', () => {
  findThinkingTriggerPositions(slashInput)
  findBtwTriggerPositions(slashInput)
  findTokenBudgetPositions(slashInput)
  findSlackChannelPositions(slashInput)
  findSlashCommandPositions(slashInput)
  parseReferences(slashInput)
})

console.log('--- highlight segmentation (HighlightedInput 路径) ---')
bench('segmentTextByHighlights zh130 8 highlights', () => {
  segmentTextByHighlights(zh130, [
    { start: 0, end: 5, color: 'suggestion', priority: 5 },
    { start: 10, end: 15, color: 'warning', priority: 15 },
    { start: 20, end: 25, color: undefined, dimColor: true, priority: 1 },
    { start: 30, end: 35, color: 'suggestion', priority: 5 },
    { start: 40, end: 45, color: 'warning', priority: 15 },
    { start: 50, end: 55, color: 'suggestion', priority: 5 },
    { start: 60, end: 65, color: undefined, dimColor: true, priority: 1 },
    { start: 70, end: 75, color: 'suggestion', priority: 5 },
  ])
})
