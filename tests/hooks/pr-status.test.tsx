import { describe, expect, jest, spyOn, test } from 'bun:test'
import { Writable } from 'node:stream'
import type React from 'react'
import * as runtimeContext from '../../src/bootstrap/runtime/runtimeContext.js'
import { usePrStatus } from '../../src/hooks/usePrStatus.js'
import Ink from '../../src/ink/ink.js'
import * as ghPrStatus from '../../src/services/github/ghPrStatus.js'

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
    const interactionTime = spyOn(runtimeContext, 'getLastInteractionTime').mockReturnValue(1)
    const fetchPrStatus = spyOn(ghPrStatus, 'fetchPrStatus').mockResolvedValue(null)
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') })
    try {
      // Ink 同步提交；每次推进后让异步轮询完成，再推进下一分钟。
      ink.render(<Probe isLoading={false} />)
      await Promise.resolve()
      expect(fetchPrStatus).toHaveBeenCalledTimes(1)

      for (let minute = 1; minute <= 60; minute++) {
        jest.advanceTimersByTime(60_000)
        await Promise.resolve()
      }
      expect(fetchPrStatus).toHaveBeenCalledTimes(60)
      jest.advanceTimersByTime(60_000)
      expect(fetchPrStatus).toHaveBeenCalledTimes(60)

      ink.render(<Probe isLoading={true} />)
      await Promise.resolve()
      expect(fetchPrStatus).toHaveBeenCalledTimes(61)
    } finally {
      jest.useRealTimers()
      ink.unmount()
      interactionTime.mockRestore()
      fetchPrStatus.mockRestore()
    }
  })
})
