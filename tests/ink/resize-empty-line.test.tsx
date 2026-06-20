/**
 * 复现全屏模式下终端宽度变化时，工具调用内容与折叠块摘要之间出现空行的问题。
 *
 * 场景：工具调用内容（长代码）在窄宽度下换行多、行数多；变宽后换行减少、行数变少。
 * 如果下方的“思考了 X 秒”摘要没有随之上移，就会在旧位置留下空行。
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { Writable } from 'node:stream'
import Ink from '../../src/ink/ink.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import ScrollBox from '../../src/ink/components/ScrollBox.js'
import { charInCellAt } from '../../src/ink/screen.js'
import type { Frame } from '../../src/ink/frame.js'
import { useVirtualScroll } from '../../src/hooks/useVirtualScroll.js'
import type { ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'

function makeStdout(cols: number, rows: number): NodeJS.WriteStream {
  const chunks: Buffer[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stream.columns = cols
  stream.rows = rows
  stream.isTTY = true
  return stream
}

function frameToLines(frame: Frame): string[] {
  const { screen } = frame
  const lines: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      line += charInCellAt(screen, x, y)
    }
    lines.push(line.trimEnd())
  }
  return lines
}

describe('全屏 resize 空行回归', () => {
  test('代码块变窄再变宽后，思考摘要应紧跟代码块，不留空行', () => {
    const stdout = makeStdout(40, 12)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    const frames: Frame[] = []
    // 手动启用 alt-screen 逻辑状态，使 frameSink 被调用
    ink.setAltScreenActive(true, false)

    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }

    const codeLine = 'function getUltraplanModel() { return model; } '.repeat(2)
    const summary = '思考了 2 秒'
    const itemKeys = ['code', 'summary']

    function TestList({ columns }: { columns: number }) {
      const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
      const { range, topSpacer, bottomSpacer, measureRef, spacerRef } = useVirtualScroll(
        scrollRef,
        itemKeys,
        columns,
      )
      const [start, end] = range
      return (
        <Box height={12} flexDirection="column">
          <ScrollBox ref={scrollRef} stickyScroll>
            <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
            {itemKeys.slice(start, end).map((key) => (
              <Box key={key} ref={measureRef(key)} flexDirection="column">
                {key === 'code' ? <Text>{codeLine}</Text> : <Text>{summary} END</Text>}
              </Box>
            ))}
            {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
          </ScrollBox>
        </Box>
      )
    }

    ink.render(<TestList columns={40} />)

    expect(frames.length).toBeGreaterThanOrEqual(1)
    const narrowLines = frameToLines(frames[0]!)
    const narrowSummaryY = narrowLines.findIndex((l) => l.includes(summary))
    expect(narrowSummaryY).toBeGreaterThan(0)

    // 模拟窗口由窄变宽
    stdout.columns = 120
    ;(ink as any).terminalColumns = 120
    ink.render(<TestList columns={120} />)

    expect(frames.length).toBeGreaterThanOrEqual(2)
    const wideFrame = frames.at(-1)!
    const wideLines = frameToLines(wideFrame)
    const wideSummaryY = wideLines.findIndex((l) => l.includes(summary))
    expect(wideSummaryY).toBeGreaterThan(0)

    // 变宽后，摘要和代码块之间不应有空行
    for (let y = wideSummaryY - 1; y > 0; y--) {
      const line = wideLines[y]
      if (line === '') {
        // 发现空行，向上检查直到非空或到顶部
        const prev = wideLines[y - 1]
        if (prev === '') continue
        if (!prev?.includes('function') && !prev?.includes('}')) {
          throw new Error(`摘要与代码块之间出现空行：行 ${y} 为空`)
        }
      }
    }

    ink.unmount()
  })

  test('DECSTBM 快速路径下，宽度变化后摘要仍应紧跟代码块', () => {
    // 直接渲染足够多的内容，使内容高度超过固定高度的 ScrollBox，
    // sticky 跟随导致 scrollTop 变化，触发 DECSTBM 快速路径。
    const stdout = makeStdout(40, 6)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    const frames: Frame[] = []
    ink.setAltScreenActive(true, false)
    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }

    const codeLine = 'function getUltraplanModel() { return model; } '.repeat(4)
    const summary = '思考了 2 秒'

    function TestList({ columns }: { columns: number }) {
      return (
        <Box height={6} flexDirection="column">
          <ScrollBox stickyScroll>
            <Text>{codeLine}</Text>
            <Text>{summary} END</Text>
            <Text>{codeLine}</Text>
            <Text>{summary} END</Text>
            <Text>{codeLine}</Text>
            <Text>{summary} END</Text>
            <Text>{codeLine}</Text>
            <Text>{summary} END</Text>
          </ScrollBox>
        </Box>
      )
    }

    ink.render(<TestList columns={40} />)
    expect(frames.length).toBeGreaterThanOrEqual(1)

    // 由窄变宽：代码块高度减少，sticky 跟随应使 scrollTop 变化，
    // 触发 DECSTBM 快速路径。
    stdout.columns = 120
    ;(ink as any).terminalColumns = 120
    ink.render(<TestList columns={120} />)

    expect(frames.length).toBeGreaterThanOrEqual(2)
    const wideFrame = frames.at(-1)!
    const wideLines = frameToLines(wideFrame)
    const wideSummaryY = wideLines.findIndex((l) => l.includes(summary))
    expect(wideSummaryY).toBeGreaterThan(0)

    // 摘要上方紧邻代码块，不应出现空行
    for (let y = wideSummaryY - 1; y > 0; y--) {
      const line = wideLines[y]
      if (line === '') {
        const prev = wideLines[y - 1]
        if (prev === '') continue
        if (!prev?.includes('function') && !prev?.includes('}')) {
          throw new Error(`DECSTBM 路径下摘要与代码块之间出现空行：行 ${y} 为空`)
        }
      }
    }

    ink.unmount()
  })
})
