import { describe, expect, jest, mock, test } from 'bun:test'
import { Writable } from 'node:stream'
import React, { act } from 'react'
import Ink from '../../src/ink/ink.js'

const fetchPrStatus = mock(async () => null)
mock.module('src/bootstrap/runtime/runtimeContext.js', () => ({
  getLastInteractionTime: () => 1,
}))
mock.module('../../src/services/github/ghPrStatus.js', () => ({
  fetchPrStatus,
}))

const { usePrStatus } = await import('../../src/hooks/usePrStatus.js')

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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

describe('usePrStatus', () => {
  test('空闲停止后 isLoading 变化会恢复轮询', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    fetchPrStatus.mockClear()

    function Probe({ isLoading }: { isLoading: boolean }): React.ReactNode {
      usePrStatus(isLoading)
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
    await act(async () => ink.render(<Probe isLoading={false} />))

    await act(async () => jest.advanceTimersByTime(60_000))
    expect(fetchPrStatus).toHaveBeenCalledTimes(1)
    await act(async () => jest.advanceTimersByTime(60 * 60_000))
    const stoppedAt = fetchPrStatus.mock.calls.length

    await act(async () => ink.render(<Probe isLoading={true} />))
    await act(async () => jest.advanceTimersByTime(1))
    expect(fetchPrStatus.mock.calls.length).toBe(stoppedAt + 1)

    await act(async () => ink.unmount())
    jest.useRealTimers()
  })
})
