import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { useDeclaredCursor } from '../../src/ink/hooks/useDeclaredCursor.js'
import Ink from '../../src/ink/ink.js'
import { getImeSafeTextColumns, shouldUseNativeCursor } from '../../src/ink/nativeCursor.js'
import { eraseToEndOfLine } from '../../src/ink/termio/csi.js'
import { resetTerminalFocusState, setTerminalFocused } from '../../src/ink/terminalFocusState.js'
import { HIDE_CURSOR, SHOW_CURSOR, BLINKING_BAR_CURSOR } from '../../src/ink/termio/dec.js'

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

function CursorTarget({
  active,
  column = 1,
  eraseToEnd = false,
}: {
  active: boolean
  column?: number
  eraseToEnd?: boolean
}): React.ReactNode {
  const cursorRef = useDeclaredCursor({
    line: 0,
    column,
    active,
    visible: true,
    eraseToEnd,
  })
  return (
    <Box ref={cursorRef}>
      <Text>x</Text>
    </Box>
  )
}

describe('原生光标状态', () => {
  test('焦点返回及空闲恢复时重新声明样式，下一帧恢复零写入', () => {
    const { stdout, chunks } = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })
    const renderFrame = () => (ink as unknown as { onRender: () => void }).onRender()
    try {
      ink.render(<CursorTarget active={true} />)
      renderFrame()
      for (const restore of [
        () => {
          setTerminalFocused(false)
          setTerminalFocused(true)
        },
        () => ink.reassertTerminalModes(),
      ]) {
        chunks.length = 0
        restore()
        renderFrame()
        expect(chunks.join('')).toContain(BLINKING_BAR_CURSOR)
        expect(chunks.join('')).toContain(SHOW_CURSOR)
        expect(chunks.join('')).not.toContain(HIDE_CURSOR)
        chunks.length = 0
        renderFrame()
        expect(chunks.join('')).toBe('')
      }
    } finally {
      ink.unmount()
      resetTerminalFocusState()
    }
  })

  test('连续移动仅发送位置变化，不重置闪烁或切换可见性', () => {
    const { stdout, chunks } = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })
    try {
      ink.render(<CursorTarget active={true} />)
      ;(ink as unknown as { onRender: () => void }).onRender()
      expect(chunks.join('')).toContain(BLINKING_BAR_CURSOR)
      for (const column of [0, 1, 0, 1]) {
        chunks.length = 0
        ink.render(<CursorTarget active={true} column={column} />)
        ;(ink as unknown as { onRender: () => void }).onRender()
        const output = chunks.join('')
        expect(output).not.toBe('')
        expect(output).not.toContain(BLINKING_BAR_CURSOR)
        expect(output).not.toContain(HIDE_CURSOR)
        expect(output).not.toContain(SHOW_CURSOR)
      }
    } finally {
      ink.unmount()
    }
  })

  test('默认启用，支持显式回退和无障碍覆盖', () => {
    const keys = [
      'TERM',
      'TERMINAL_EMULATOR',
      'ZY_CODE_NATIVE_CURSOR',
      'ZY_CODE_ACCESSIBILITY',
    ] as const
    const previous = keys.map((key) => process.env[key])
    try {
      process.env.TERM = 'xterm-256color'
      delete process.env.TERMINAL_EMULATOR
      delete process.env.ZY_CODE_NATIVE_CURSOR
      delete process.env.ZY_CODE_ACCESSIBILITY
      expect(shouldUseNativeCursor()).toBe(true)
      process.env.TERM = 'dumb'
      expect(shouldUseNativeCursor()).toBe(false)
      process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'
      expect(shouldUseNativeCursor()).toBe(true)
      process.env.ZY_CODE_NATIVE_CURSOR = '1'
      expect(shouldUseNativeCursor()).toBe(true)
      process.env.ZY_CODE_NATIVE_CURSOR = '0'
      expect(shouldUseNativeCursor()).toBe(false)
      process.env.ZY_CODE_ACCESSIBILITY = '1'
      expect(shouldUseNativeCursor()).toBe(true)
    } finally {
      keys.forEach((key, index) => {
        const value = previous[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    }
  })

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
    expect(chunks.join('')).toContain(BLINKING_BAR_CURSOR)

    // 内容和停靠位置不变时，不应重复写入光标控制序列。
    chunks.length = 0
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toBe('')

    // 外部编辑器可能在光标仍标记可见时改回方块，完整重绘必须恢复竖线。
    chunks.length = 0
    ink.repaint()
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toContain(BLINKING_BAR_CURSOR)
    expect(chunks.join('')).toContain(SHOW_CURSOR)

    chunks.length = 0
    ink.render(<CursorTarget active={false} />)
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toContain(HIDE_CURSOR)

    chunks.length = 0
    ink.render(<CursorTarget active={true} />)
    ;(ink as unknown as { onRender: () => void }).onRender()
    expect(chunks.join('')).toContain(BLINKING_BAR_CURSOR)
    expect(chunks.join('')).toContain(SHOW_CURSOR)

    ink.unmount()
  })

  test('文本末尾停靠时使用 EL 截断 JediTerm 保留的旧逻辑行宽', () => {
    const { stdout, chunks } = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      nativeCursor: true,
    })

    ink.render(<CursorTarget active={true} eraseToEnd={true} />)
    ;(ink as unknown as { onRender: () => void }).onRender()

    expect(chunks.join('')).toContain(eraseToEndOfLine())
    ink.unmount()
  })

  test('Windows JediTerm 为较长 IME 预编辑串提前换行', () => {
    const previousTerminal = process.env.TERMINAL_EMULATOR
    const previousNativeCursor = process.env.ZY_CODE_NATIVE_CURSOR
    try {
      process.env.TERMINAL_EMULATOR = 'JetBrains-JediTerm'
      process.env.ZY_CODE_NATIVE_CURSOR = '1'
      expect(getImeSafeTextColumns(40)).toBe(process.platform === 'win32' ? 28 : 40)
    } finally {
      if (previousTerminal === undefined) {
        delete process.env.TERMINAL_EMULATOR
      } else {
        process.env.TERMINAL_EMULATOR = previousTerminal
      }
      if (previousNativeCursor === undefined) {
        delete process.env.ZY_CODE_NATIVE_CURSOR
      } else {
        process.env.ZY_CODE_NATIVE_CURSOR = previousNativeCursor
      }
    }
  })
})
