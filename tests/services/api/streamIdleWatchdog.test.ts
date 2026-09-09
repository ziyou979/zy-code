import { describe, expect, spyOn, test } from 'bun:test'
import { createStreamIdleWatchdog } from '../../../src/services/api/llm-orchestrator/streamIdleWatchdog.js'

describe('streamIdleWatchdog', () => {
  test('连续事件复用两个计时器，清理后可重新启动', () => {
    const watchdog = createStreamIdleWatchdog({
      model: 'test',
      getRequestId: () => null,
      releaseStreamResources: () => {},
    })
    const timers = spyOn(globalThis, 'setTimeout')
    try {
      for (let i = 0; i < 10000; i++) watchdog.reset()
      expect(timers).toHaveBeenCalledTimes(2)
      watchdog.clear()
      watchdog.reset()
      expect(timers).toHaveBeenCalledTimes(4)
    } finally {
      watchdog.clear()
      timers.mockRestore()
    }
  })

  test('事件刷新空闲期限，超时仍释放资源，clear 阻止后续超时', async () => {
    const enabled = process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    const timeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '300'
    let releases = 0
    const watchdog = createStreamIdleWatchdog({
      model: 'test',
      getRequestId: () => null,
      releaseStreamResources: () => {
        releases++
      },
    })
    try {
      watchdog.reset()
      await Bun.sleep(180)
      watchdog.reset()
      await Bun.sleep(180)
      expect(watchdog.aborted).toBe(false)
      await Bun.sleep(180)
      expect(watchdog.aborted).toBe(true)
      expect(releases).toBe(1)
      watchdog.reset()
      watchdog.clear()
      await Bun.sleep(350)
      expect(releases).toBe(1)
    } finally {
      watchdog.clear()
      if (enabled === undefined) delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
      else process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = enabled
      if (timeout === undefined) delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      else process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = timeout
    }
  })
})
