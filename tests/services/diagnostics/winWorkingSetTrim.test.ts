/**
 * Windows 工作集 trim 服务单元测试
 */
import { describe, expect, test } from 'bun:test'
import {
  trimWorkingSetIfHigh,
  trimWorkingSetNow,
} from '../../../src/services/diagnostics/winWorkingSetTrim.js'

describe('winWorkingSetTrim', () => {
  test('trimWorkingSetIfHigh 当阈值高于当前 RSS 时不应触发 trim', () => {
    // 设置极大阈值（100GB），确保不触发 trim
    const result = trimWorkingSetIfHigh(100 * 1024 * 1024 * 1024, 0)
    expect(result).toBe(false)
  })

  test('trimWorkingSetNow 受冷却时间限制', () => {
    // 第一次调用（取决于平台，若 win32 且非禁用可能返回 true 或 false）
    const now = Date.now()
    trimWorkingSetNow(now, 60_000)

    // 立即再次调用，冷却时间未满，必然返回 false
    const immediateAgain = trimWorkingSetNow(now + 1000, 60_000)
    expect(immediateAgain).toBe(false)
  })
})
