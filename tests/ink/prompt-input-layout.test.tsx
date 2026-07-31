import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { useMemo } from 'react'
import { Ansi } from '../../src/ink/Ansi.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import type { DOMElement } from '../../src/ink/dom.js'
import type { Frame } from '../../src/ink/frame.js'
import Ink from '../../src/ink/ink.js'
import { nodeCache } from '../../src/ink/nodeCache.js'
import { charInCellAt } from '../../src/ink/screen.js'
import { stringWidth } from '../../src/ink/stringWidth.js'
import { Cursor } from '../../src/terminal-ui/cursor.js'

function makeStdout(columns: number, rows: number): NodeJS.WriteStream {
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = columns
  stdout.rows = rows
  stdout.isTTY = true
  return stdout
}

function frameToLines(frame: Frame): string[] {
  const lines: string[] = []
  for (let y = 0; y < frame.screen.height; y++) {
    let line = ''
    for (let x = 0; x < frame.screen.width; x++) {
      line += charInCellAt(frame.screen, x, y)
    }
    lines.push(line.trimEnd())
  }
  return lines
}

function PromptLayout({
  columns,
  value,
  inputRef,
  nativeCursor = false,
}: {
  columns: number
  value: string
  inputRef: React.RefObject<DOMElement | null>
  nativeCursor?: boolean
}): React.ReactNode {
  const textInputColumns = columns - 3
  const renderedValue = useMemo(() => {
    const cursor = Cursor.fromText(value, textInputColumns, value.length)
    return cursor.render(nativeCursor ? '' : ' ', '', (text) => text)
  }, [nativeCursor, textInputColumns, value])

  return (
    <Box width={columns} flexDirection="row">
      <Text>{'❯ '}</Text>
      <Box ref={inputRef} width={textInputColumns + 1} flexShrink={0} minHeight={1}>
        <Box minHeight={1}>
          <Box>
            <Text wrap="truncate-end">
              <Text aria-preserve-whitespace={true}>
                <Ansi>{renderedValue}</Ansi>
              </Text>
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

describe('提示输入框布局', () => {
  test('长中文跨行后输入区宽度不收缩，清空后仍保持一致', () => {
    const columns = 40
    const stdout = makeStdout(columns, 12)
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
    const inputRef = React.createRef<DOMElement>()

    ink.render(<PromptLayout columns={columns} value={'中文输入'.repeat(20)} inputRef={inputRef} />)

    const longRect = nodeCache.get(inputRef.current!)
    expect(longRect).toMatchObject({ x: 2, width: columns - 2 })
    const longLines = frameToLines(frames.at(-1)!)
    expect(stringWidth(longLines[0]!)).toBe(columns - 2)
    expect(stringWidth(longLines[1]!)).toBe(columns - 2)

    ink.render(<PromptLayout columns={columns} value="" inputRef={inputRef} />)

    const emptyRect = nodeCache.get(inputRef.current!)
    expect(emptyRect).toMatchObject({ x: 2, width: columns - 2, height: 1 })
    ink.unmount()
  })

  test('光标进入第二行时不应为输入区增加空白行', () => {
    const columns = 40
    const stdout = makeStdout(columns, 12)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })
    ink.frameSink = () => true
    const inputRef = React.createRef<DOMElement>()
    const value = '中文输入'.repeat(5)

    ink.render(
      <PromptLayout columns={columns} value={value} inputRef={inputRef} nativeCursor={true} />,
    )

    expect(nodeCache.get(inputRef.current!)).toMatchObject({
      x: 2,
      width: columns - 2,
      height: 2,
    })
    ink.unmount()
  })

  test('原生光标不向空输入行写入可能触发 IME 软换行的尾随空格', () => {
    const columns = 40
    const stdout = makeStdout(columns, 12)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })
    const frames: Frame[] = []
    ink.frameSink = (frame) => {
      frames.push(frame)
      return true
    }
    const inputRef = React.createRef<DOMElement>()

    ink.render(<PromptLayout columns={columns} value="" inputRef={inputRef} nativeCursor={true} />)

    expect(nodeCache.get(inputRef.current!)).toMatchObject({ height: 1 })
    expect(frameToLines(frames.at(-1)!)[0]).toBe('❯')
    ink.unmount()
  })

  test('嵌套文本从三行缩短到两行时应使所有文本祖先重新测量', () => {
    const columns = 40
    const stdout = makeStdout(columns, 12)
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    ink.frameSink = () => true
    const inputRef = React.createRef<DOMElement>()

    ink.render(<PromptLayout columns={columns} value={'中文输入'.repeat(10)} inputRef={inputRef} />)
    expect(nodeCache.get(inputRef.current!)).toMatchObject({ height: 3 })

    ink.render(<PromptLayout columns={columns} value={'中文输入'.repeat(5)} inputRef={inputRef} />)
    expect(nodeCache.get(inputRef.current!)).toMatchObject({ height: 2 })
    ink.unmount()
  })
})
