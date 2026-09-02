import { describe, expect, test } from 'bun:test'
import { isProcessRunning } from '../../../src/services/shell/genericProcessUtils.js'

describe('isProcessRunning', () => {
  test('拒绝进程组和 init 的保留 PID', () => {
    expect(isProcessRunning(0)).toBe(false)
    expect(isProcessRunning(1)).toBe(false)
  })

  test('识别当前进程为存活', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })
})
