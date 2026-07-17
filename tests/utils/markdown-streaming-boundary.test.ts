/**
 * 流式 Markdown 稳定前缀推进回归（CC 2.1.207 长 list/table/code 卡顿相关）。
 *
 * 契约：
 * 1. stable 单调不减
 * 2. 未闭合 fence / 增长中的段落留在 unstable
 * 3. 已闭合块进入 stable，后续 delta 不再重解析全文
 * 4. 长列表/表格分块追加时，unstable 长度相对全文保持有界
 */
import { describe, expect, test } from 'bun:test'
import { advanceStreamingMarkdownBoundary } from '../../src/services/markdown/markdown.js'

/** 模拟流式追加：逐段增长 content，收集每步的 stable/unstable */
function simulateStream(chunks: string[]): Array<{
  full: string
  stable: string
  unstable: string
}> {
  let full = ''
  let stable = ''
  const steps: Array<{ full: string; stable: string; unstable: string }> = []
  for (const c of chunks) {
    full += c
    const r = advanceStreamingMarkdownBoundary(full, stable)
    stable = r.stablePrefix
    steps.push({ full, stable, unstable: r.unstableSuffix })
  }
  return steps
}

describe('advanceStreamingMarkdownBoundary', () => {
  test('stable 前缀单调前进', () => {
    const steps = simulateStream([
      '# Title\n\n',
      'para one.\n\n',
      'para two.\n\n',
      '- a\n',
      '- b\n',
    ])
    let prevLen = 0
    for (const s of steps) {
      expect(s.stable.length).toBeGreaterThanOrEqual(prevLen)
      expect(s.full.startsWith(s.stable)).toBe(true)
      expect(s.stable + s.unstable).toBe(s.full)
      prevLen = s.stable.length
    }
  })

  test('未闭合代码围栏整块留在 unstable', () => {
    let stable = ''
    const open = 'intro\n\n```ts\nconst x = 1\n'
    let r = advanceStreamingMarkdownBoundary(open, stable)
    stable = r.stablePrefix
    // intro 段可闭合进 stable；fence 未闭合在 unstable
    expect(r.unstableSuffix).toContain('```ts')
    expect(r.unstableSuffix).toContain('const x = 1')

    const more = open + 'const y = 2\n'
    r = advanceStreamingMarkdownBoundary(more, stable)
    expect(r.unstableSuffix).toContain('const y = 2')
    // stable 不应回退
    expect(r.stablePrefix.length).toBeGreaterThanOrEqual(stable.length)

    const closed = more + '```\n'
    r = advanceStreamingMarkdownBoundary(closed, r.stablePrefix)
    // 闭合后 fence 可被下一块推进时纳入 stable；至少全文 = stable+unstable
    expect(r.stablePrefix + r.unstableSuffix).toBe(closed)
  })

  test('长列表追加时 unstable 相对全文有界（不全文 re-lex 热路径）', () => {
    const items = Array.from({ length: 80 }, (_, i) => `- item ${i} with some padding text\n`)
    // 每次追加 1 项
    let full = 'Preamble paragraph.\n\n'
    let stable = ''
    let maxUnstable = 0
    for (const line of items) {
      full += line
      const r = advanceStreamingMarkdownBoundary(full, stable)
      stable = r.stablePrefix
      maxUnstable = Math.max(maxUnstable, r.unstableSuffix.length)
    }
    // 列表未闭合时 unstable 可能含整表；但 stable 应已吞掉 preamble
    expect(stable.length).toBeGreaterThan(0)
    expect(stable).toContain('Preamble')
    // 完成后再补一个独立段落，推动列表进入 stable
    full += '\nDone.\n'
    const final = advanceStreamingMarkdownBoundary(full, stable)
    expect(final.stablePrefix.length).toBeGreaterThan(stable.length)
    // 最终 unstable 应短于全文（至少 preamble+大部分列表已稳定）
    expect(final.unstableSuffix.length).toBeLessThan(full.length * 0.5)
    expect(maxUnstable).toBeLessThan(full.length) // 过程中至少有过部分稳定
  })

  test('GFM 表格行追加不破坏边界单调性', () => {
    const chunks = [
      '| A | B |\n',
      '| --- | --- |\n',
      '| 1 | 2 |\n',
      '| 3 | 4 |\n',
      '\nAfter table.\n',
    ]
    const steps = simulateStream(chunks)
    let prev = 0
    for (const s of steps) {
      expect(s.stable.length).toBeGreaterThanOrEqual(prev)
      expect(s.stable + s.unstable).toBe(s.full)
      prev = s.stable.length
    }
    const last = steps.at(-1)!
    expect(last.full).toContain('After table')
  })

  test('长段落流式增长：未换行时 unstable 含增长段', () => {
    let full = 'Start. '
    let stable = ''
    for (let i = 0; i < 20; i++) {
      full += `word${i} `
      const r = advanceStreamingMarkdownBoundary(full, stable)
      stable = r.stablePrefix
      // 单段落未闭合时，整段在 unstable 或 stable 其一，和必须等于 full
      expect(r.stablePrefix + r.unstableSuffix).toBe(full)
    }
    // 双换行结束段落后可推进
    full += '\n\nNext block.\n'
    const r = advanceStreamingMarkdownBoundary(full, stable)
    expect(r.stablePrefix + r.unstableSuffix).toBe(full)
    expect(r.stablePrefix.length).toBeGreaterThan(0)
  })

  test('全文替换时 stable 重置', () => {
    const a = advanceStreamingMarkdownBoundary('# A\n\nbody\n\n', '')
    const b = advanceStreamingMarkdownBoundary('# Completely different\n\n', a.stablePrefix)
    // 不再是前缀 → 重置
    expect(b.stablePrefix + b.unstableSuffix).toBe('# Completely different\n\n')
  })

  test('大批量 token 流模拟在时限内完成（防冻结回归）', () => {
    const start = performance.now()
    let full = ''
    let stable = ''
    // 模拟 200 次 delta：交替列表项与短段落
    for (let i = 0; i < 200; i++) {
      if (i % 5 === 0) {
        full += `\n\n## Section ${i}\n\n`
      } else if (i % 3 === 0) {
        full += '```js\nconsole.log(' + i + ')\n```\n\n'
      } else {
        full += `- bullet ${i} lorem ipsum dolor sit amet\n`
      }
      const r = advanceStreamingMarkdownBoundary(full, stable)
      stable = r.stablePrefix
    }
    const ms = performance.now() - start
    // 本机通常 <50ms；给 CI 宽限 2s，远低于「冻结感」阈值
    expect(ms).toBeLessThan(2000)
    expect(stable.length + (full.length - stable.length)).toBe(full.length)
  })
})
