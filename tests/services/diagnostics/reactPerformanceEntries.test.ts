import { describe, expect, test } from 'bun:test'
import { installReactPerformanceEntryCleanup } from '../../../src/services/diagnostics/reactPerformanceEntries.js'

describe('reactPerformanceEntries', () => {
  test('React 测量不进入原生分配路径，也不删除同名业务记录', () => {
    const original = performance.measure
    let nativeCalls = 0
    performance.measure = function (...args) {
      nativeCalls++
      return original.apply(performance, args)
    }
    const restore = installReactPerformanceEntryCleanup()
    try {
      performance.measure('shared-probe', { start: 1, end: 2 })
      const detail = { devtools: { track: 'Components ⚛' }, props: 'x'.repeat(4096) }
      const entry = performance.measure('shared-probe', { start: 1, end: 3, detail })
      expect(nativeCalls).toBe(1)
      expect(entry.detail).toBe(detail)
      expect(entry.toJSON()).toEqual({
        name: 'shared-probe',
        entryType: 'measure',
        startTime: 1,
        duration: 2,
        detail,
      })
      expect(performance.getEntriesByName('shared-probe')).toHaveLength(1)
    } finally {
      restore()
      performance.measure = original
      performance.clearMeasures('shared-probe')
    }
  })

  test('连续组件与调度测量不积累，保留返回值及普通业务测量', () => {
    const restore = installReactPerformanceEntryCleanup()
    try {
      performance.measure('business-probe', { start: 1, end: 2 })
      for (let i = 0; i < 10000; i++) {
        const entry = performance.measure(`react-probe-${i % 4}`, {
          start: 1,
          end: 3,
          detail: {
            devtools:
              i % 2 === 0
                ? { track: 'Components ⚛' }
                : { track: 'Blocking', trackGroup: 'Scheduler ⚛' },
          },
        })
        if (i === 0) {
          expect(entry.duration).toBe(2)
          expect(entry.name).toBe('react-probe-0')
        }
      }
      expect(
        performance
          .getEntriesByType('measure')
          .filter((entry) => entry.name.startsWith('react-probe-')),
      ).toHaveLength(0)
      expect(performance.getEntriesByName('business-probe')).toHaveLength(1)
    } finally {
      restore()
      performance.clearMeasures('business-probe')
    }
  })

  test('非 React detail、mark 参数和无效参数保留原生行为，卸载恢复原方法', () => {
    const original = performance.measure
    const restore = installReactPerformanceEntryCleanup()
    try {
      performance.mark('probe-start')
      performance.measure('probe-mark', 'probe-start')
      performance.measure('probe-other', {
        start: 1,
        end: 2,
        detail: { devtools: { track: 'Business' } },
      })
      expect(performance.getEntriesByName('probe-mark')).toHaveLength(1)
      expect(performance.getEntriesByName('probe-other')).toHaveLength(1)
      expect(() => performance.measure('probe-invalid', 'missing-probe-mark')).toThrow()
    } finally {
      restore()
      performance.clearMarks('probe-start')
      performance.clearMeasures('probe-mark')
      performance.clearMeasures('probe-other')
    }
    expect(performance.measure).toBe(original)
  })
})
