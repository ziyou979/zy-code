import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from 'react'
import { useInputBuffer, type UseInputBufferResult } from '../../src/hooks/useInputBuffer.js'
import Ink from '../../src/ink/ink.js'

function makeStdout(): NodeJS.WriteStream {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as unknown as NodeJS.WriteStream
  stream.columns = 80
  stream.rows = 24
  stream.isTTY = true
  return stream
}

describe('useInputBuffer', () => {
  test('重复文本不新增时不推进当前索引', async () => {
    let buffer: UseInputBufferResult | undefined
    function Probe(): React.ReactNode {
      buffer = useInputBuffer({ maxBufferSize: 10, debounceMs: 0 })
      return null
    }

    const stdout = makeStdout()
    const ink = new Ink({
      stdout,
      stderr: stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    ink.render(<Probe />)

    buffer!.pushToBuffer('first', 0)
    await Bun.sleep(10)
    buffer!.pushToBuffer('second', 0)
    await Bun.sleep(10)
    expect(buffer!.undo()?.text).toBe('first')
    await Bun.sleep(10)

    buffer!.pushToBuffer('first', 0)
    await Bun.sleep(10)
    expect(buffer!.canUndo).toBeFalse()

    ink.unmount()
  })
})
