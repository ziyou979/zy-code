import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import Text from '../../src/ink/components/Text.js'
import Ink from '../../src/ink/ink.js'

function makeStdout(columns = 120, rows = 40): NodeJS.WriteStream {
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

type TerminalSizeState = {
  terminalColumns: number
  terminalRows: number
}

function terminalSizeOf(ink: Ink): TerminalSizeState {
  return ink as unknown as TerminalSizeState
}

describe('终端尺寸同步', () => {
  test('运行期的零值和异常值沿用上一份有效尺寸', () => {
    const stdout = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    stdout.columns = 0
    stdout.rows = 0
    stdout.emit('resize')
    expect(terminalSizeOf(ink)).toMatchObject({
      terminalColumns: 120,
      terminalRows: 40,
    })

    stdout.columns = Number.POSITIVE_INFINITY
    stdout.rows = Number.NaN
    stdout.emit('resize')
    expect(terminalSizeOf(ink)).toMatchObject({
      terminalColumns: 120,
      terminalRows: 40,
    })

    ink.unmount()
  })

  test('布局提交前可补偿漏发或延迟到达的 resize 事件', () => {
    const stdout = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    stdout.columns = 100
    stdout.rows = 32
    ink.render(<Text>resize</Text>)

    expect(terminalSizeOf(ink)).toMatchObject({
      terminalColumns: 100,
      terminalRows: 32,
    })

    ink.unmount()
  })
})
