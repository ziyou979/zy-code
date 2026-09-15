import { describe, expect, test } from 'bun:test'
import { MemoryMonitor } from '../../../src/services/diagnostics/memoryMonitor.js'

describe('MemoryMonitor', () => {
  test('启动时已超阈值立即抓取，未完成期间和重启监控后都不重复', async () => {
    let calls = 0
    let finish: (() => void) | undefined
    const monitor = new MemoryMonitor({
      criticalThresholdRss: 0,
      sampleIntervalMs: 5,
      autoHeapDump: true,
      onHeapDump: () => {
        calls++
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    })
    try {
      monitor.start()
      expect(calls).toBe(1)
      await Bun.sleep(25)
      expect(calls).toBe(1)
      finish?.()
      monitor.stop()
      monitor.start()
      await Bun.sleep(25)
      expect(calls).toBe(1)
      expect(monitor.getPeakRss()).toBeGreaterThan(0)
    } finally {
      finish?.()
      monitor.stop()
    }
  })

  test('未开启自动抓取或未达到阈值时不调用回调', () => {
    for (const config of [
      { autoHeapDump: false, criticalThresholdRss: 0 },
      { autoHeapDump: true, criticalThresholdRss: Number.POSITIVE_INFINITY },
    ]) {
      let calls = 0
      const monitor = new MemoryMonitor({
        ...config,
        onHeapDump: async () => {
          calls++
        },
      })
      try {
        monitor.start()
        expect(calls).toBe(0)
      } finally {
        monitor.stop()
      }
    }
  })
})
