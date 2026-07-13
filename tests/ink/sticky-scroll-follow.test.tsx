/**
 * stickyScroll 触底跟随 + 高度 HWM（CC 2.1.207 transcript 不回跳）
 * + StreamingMarkdown 多帧长内容渲染时限回归
 */
import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import Box from '../../src/ink/components/Box.js'
import Ink from '../../src/ink/ink.js'
import { computeScrollFollow } from '../../src/ink/scrollFollow.js'

function makeStdout(cols: number, rows: number): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stream.columns = cols
  stream.rows = rows
  stream.isTTY = true
  return stream
}

describe('computeScrollFollow 触底跟随', () => {
  test('sticky 时内容增高 → scrollTop 钉在新 maxScroll', () => {
    const r1 = computeScrollFollow({
      scrollHeight: 20,
      prevScrollHeight: 10,
      innerHeight: 8,
      prevInnerHeight: 8,
      scrollTop: 2,
      sticky: true,
    })
    expect(r1.atBottom).toBe(true)
    expect(r1.maxScroll).toBe(12)
    expect(r1.nextScrollTop).toBe(12)
    expect(r1.scrollHeightHwm).toBe(20)
  })

  test('高度短暂回落（布局抖动）时 HWM 保持触底，不回跳到顶部', () => {
    // 曾触底，高度 30→峰值 HWM 30，然后短暂掉到 27
    const r = computeScrollFollow({
      scrollHeight: 27,
      prevScrollHeight: 30,
      innerHeight: 8,
      prevInnerHeight: 8,
      scrollTop: 22, // 上一帧 maxScroll=22
      sticky: false,
      scrollHeightHwm: 30,
    })
    // 仍接近 HWM 且曾触底 → 继续跟随，钉在新 maxScroll=19
    expect(r.grew).toBe(true)
    expect(r.atBottom).toBe(true)
    expect(r.nextScrollTop).toBe(19)
    expect(r.nextScrollTop).toBeGreaterThan(0)
  })

  test('用户上滚离开底部后不再自动跟随', () => {
    const r = computeScrollFollow({
      scrollHeight: 40,
      prevScrollHeight: 30,
      innerHeight: 8,
      prevInnerHeight: 8,
      scrollTop: 5, // 远未触底
      sticky: false,
      scrollHeightHwm: 30,
    })
    expect(r.atBottom).toBe(false)
    expect(r.nextScrollTop).toBe(5)
  })

  test('流式多帧：sticky 始终钉在 maxScroll，高度回落不跳回顶部', () => {
    let scrollTop = 0
    let hwm: number | undefined
    let prevH = 8
    const tops: number[] = []
    for (const h of [12, 20, 28, 36, 34, 40]) {
      // 模拟流式结束时一次高度回落 36→34 再涨到 40
      const r = computeScrollFollow({
        scrollHeight: h,
        prevScrollHeight: prevH,
        innerHeight: 8,
        prevInnerHeight: 8,
        scrollTop,
        sticky: true,
        scrollHeightHwm: hwm,
      })
      scrollTop = r.nextScrollTop
      hwm = r.scrollHeightHwm
      prevH = h
      tops.push(scrollTop)
      // sticky 应始终等于当前 maxScroll
      expect(scrollTop).toBe(r.maxScroll)
    }
    // 终态不在顶部
    expect(tops.at(-1)!).toBe(32) // 40-8
    // 回落帧 maxScroll=26，钉在 26 而非 0（「答案起点以上」回跳）
    expect(tops[4]!).toBe(26)
    expect(tops[4]!).toBeGreaterThan(0)
  })
})

describe('StreamingMarkdown 长内容渲染时限', () => {
  test('多帧长列表/表格/代码块渲染在时限内完成', async () => {
    const { StreamingMarkdown } = await import('../../src/components/Markdown.js')
    const { AppStateProvider } = await import('../../src/state/AppState.js')

    const stdout = makeStdout(80, 24)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    ink.setAltScreenActive(true, false)
    ink.frameSink = () => true

    const t0 = performance.now()
    let content = 'Intro paragraph.\n\n'
    for (let batch = 0; batch < 15; batch++) {
      for (let i = 0; i < 10; i++) {
        content += `- list item ${batch}-${i} with padding\n`
      }
      if (batch % 4 === 0) {
        content += '\n```ts\nconst n = ' + batch + '\n```\n\n'
      }
      if (batch % 5 === 0) {
        content += '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n'
      }
      ink.render(
        <AppStateProvider>
          <Box width={80} flexDirection="column">
            <StreamingMarkdown>{content}</StreamingMarkdown>
          </Box>
        </AppStateProvider>,
      )
    }
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(8000)
    ink.unmount()
  })
})
