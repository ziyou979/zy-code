import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import { StreamingMarkdown } from '../../src/components/Markdown.js'
import { BLACK_CIRCLE } from '../../src/constants/figures.js'
import type { Frame } from '../../src/ink/frame.js'
import Ink from '../../src/ink/ink.js'
import { charInCellAt } from '../../src/ink/screen.js'
import { Box, Text } from '../../src/ink.js'
import { AppStateProvider } from '../../src/state/AppState.js'

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

function frameToText(frame: Frame): string {
  const { screen } = frame
  const lines: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      line += charInCellAt(screen, x, y)
    }
    lines.push(line.trimEnd())
  }
  return lines.join('\n')
}

describe('StreamingMarkdown 渲染', () => {
  test('流式回复应保留 markdown 块级换行', () => {
    const stdout = makeStdout(80, 20)
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

    const content = [
      '好的，我已经追踪了整个渲染链路。下面给出分析。',
      '',
      '---',
      '',
      '## 问题分析：IME 拼音输入时光标处出现横杠',
      '',
      '### 渲染链路',
      '',
      '- 第一项',
      '- 第二项',
    ].join('\n')

    ink.render(
      <AppStateProvider>
        <Box alignItems="flex-start" flexDirection="row" width={80}>
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color="text">{BLACK_CIRCLE}</Text>
            </Box>
            <Box flexDirection="column">
              <StreamingMarkdown>{content}</StreamingMarkdown>
            </Box>
          </Box>
        </Box>
      </AppStateProvider>,
    )

    expect(frames.length).toBeGreaterThanOrEqual(1)
    const text = frameToText(frames.at(-1)!)
    expect(text).toContain('好的，我已经追踪了整个渲染链路。下面给出分析。')
    expect(text).toContain('问题分析：IME 拼音输入时光标处出现横杠')
    expect(text).toContain('- 第一项')
    expect(text).not.toContain('分析。---问题分析')

    ink.unmount()
  })
})
