import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import { Message } from '../../src/components/Message.js'
import type { Frame } from '../../src/ink/frame.js'
import Ink from '../../src/ink/ink.js'
import { charInCellAt } from '../../src/ink/screen.js'
import type { AssistantMessage } from '../../src/types/message.js'
import { EMPTY_LOOKUPS } from '../../src/utils/messages.js'

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

describe('Message thinking 渲染', () => {
  test('普通模式下 assistant thinking 应隐藏', () => {
    const stdout = makeStdout(80, 8)
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

    const message: AssistantMessage = {
      uuid: 'assistant-thinking',
      timestamp: new Date(0).toISOString(),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '内部推理内容不应在普通模式展开',
            signature: '',
          },
        ],
      },
    }

    ink.render(
      <Message
        message={message}
        lookups={EMPTY_LOOKUPS}
        addMargin={false}
        tools={[]}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set()}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={false}
        isTranscriptMode={false}
        isStatic={true}
      />,
    )

    expect(frames.length).toBeGreaterThanOrEqual(1)
    const text = frameToText(frames.at(-1)!)
    // 普通模式下 thinking 应被隐藏
    expect(text).not.toContain('内部推理内容')
    expect(text).not.toContain('assistantThinking')
    expect(text).not.toContain('思考')

    ink.unmount()
  })
})
