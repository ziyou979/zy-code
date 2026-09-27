import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import { SystemTextMessage } from '../../../src/components/messages/SystemTextMessage.js'
import { ThemeProvider } from '../../../src/components/design-system/ThemeProvider.js'
import Ink from '../../../src/ink/ink.js'
import { charInCellAt } from '../../../src/ink/screen.js'
import type { Frame } from '../../../src/ink/frame.js'

describe('quiet_loop 显示', () => {
  test('普通模式可见，连续计数更新后显示新摘要', () => {
    const stdout = new Writable({
      write(_chunk, _encoding, done) {
        done()
      },
    }) as unknown as NodeJS.WriteStream
    stdout.columns = 100
    stdout.rows = 10
    stdout.isTTY = true
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const frames: Frame[] = []
    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }
    const renderSummary = (count: number) =>
      ink.render(
        <ThemeProvider>
          <SystemTextMessage
            message={{
              type: 'system',
              subtype: 'quiet_loop',
              uuid: 'quiet',
              timestamp: '2026-09-19T00:00:00Z',
              content: `${count} quiet checks`,
            }}
            addMargin={false}
            verbose={false}
          />
        </ThemeProvider>,
      )
    const frameText = () => {
      const frame = frames.at(-1)!
      let text = ''
      for (let y = 0; y < frame.screen.height; y++) {
        for (let x = 0; x < frame.screen.width; x++) {
          text += charInCellAt(frame.screen, x, y)
        }
      }
      return text
    }
    try {
      renderSummary(1)
      expect(frameText()).toContain('1 quiet checks')
      renderSummary(2)
      expect(frameText()).toContain('2 quiet checks')
    } finally {
      ink.unmount()
    }
  })
})
