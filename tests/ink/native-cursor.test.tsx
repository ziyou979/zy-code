import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { useDeclaredCursor } from '../../src/ink/hooks/useDeclaredCursor.js'
import Ink from '../../src/ink/ink.js'
import { HIDE_CURSOR, SHOW_CURSOR } from '../../src/ink/termio/dec.js'

function makeStdout(): { stdout: NodeJS.WriteStream; chunks: string[] } {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true
  return { stdout, chunks }
}

function CursorTarget({ active }: { active: boolean }): React.ReactNode {
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active,
    visible: true,
  })
  return (
    <Box ref={cursorRef}>
      <Text>x</Text>
    </Box>
  )
}

describe('原生光标状态', () => {
  test('聚焦时显示，声明清除后隐藏', () => {
    const { stdout, chunks } = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })

    ink.render(<CursorTarget active={true} />)
    // 测试渲染器同步提交；补一次正式环境中微任务调度的帧，
    // 让 layout effect 写入的光标声明参与输出。
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toContain(SHOW_CURSOR)

    chunks.length = 0
    ink.render(<CursorTarget active={false} />)
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toContain(HIDE_CURSOR)

    ink.unmount()
  })
})
