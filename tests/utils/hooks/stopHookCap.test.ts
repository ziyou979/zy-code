/**
 * 3.1 Stop hook 连续 block 自动熔断 —— 熔断判定（evaluateStopHookBlockCap）。
 *
 * query.ts 的 stop_hook_blocking 分支用此函数决定是否强制结束 turn。
 * count 从 1 起算，到第 cap+1 次触发；ZY_CODE_STOP_HOOK_BLOCK_CAP 覆盖默认 8，
 * 设为 0 禁用熔断（兼容老行为）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { evaluateStopHookBlockCap, getStopHookBlockCap } from '../../../src/utils/envUtils.js'

const ENV = 'ZY_CODE_STOP_HOOK_BLOCK_CAP'

describe('3.1 stop hook block cap', () => {
  afterEach(() => {
    delete process.env[ENV]
  })

  test('默认 cap=8：第 9 次连续 block 触发熔断', () => {
    delete process.env[ENV]
    expect(getStopHookBlockCap()).toBe(8)
    // 前 8 次不触发（nextCount 1..8）
    for (let prev = 0; prev < 8; prev++) {
      expect(evaluateStopHookBlockCap(prev).tripped).toBe(false)
    }
    // 第 9 次（prev=8 → nextCount=9 > 8）触发
    const r = evaluateStopHookBlockCap(8)
    expect(r.nextCount).toBe(9)
    expect(r.tripped).toBe(true)
  })

  test('ZY_CODE_STOP_HOOK_BLOCK_CAP=2：第 3 次触发', () => {
    process.env[ENV] = '2'
    expect(getStopHookBlockCap()).toBe(2)
    expect(evaluateStopHookBlockCap(0).tripped).toBe(false) // 1
    expect(evaluateStopHookBlockCap(1).tripped).toBe(false) // 2
    expect(evaluateStopHookBlockCap(2).tripped).toBe(true) // 3
  })

  test('ZY_CODE_STOP_HOOK_BLOCK_CAP=0：禁用熔断（永不触发）', () => {
    process.env[ENV] = '0'
    expect(getStopHookBlockCap()).toBe(0)
    expect(evaluateStopHookBlockCap(100).tripped).toBe(false)
    expect(evaluateStopHookBlockCap(10_000).tripped).toBe(false)
  })

  test('非数字值回退默认 8（不被误当作 0 禁用）', () => {
    process.env[ENV] = 'not-a-number'
    expect(getStopHookBlockCap()).toBe(8)
    expect(evaluateStopHookBlockCap(8).tripped).toBe(true)
  })

  test('count 从 undefined 起算视为 0', () => {
    delete process.env[ENV]
    expect(evaluateStopHookBlockCap(undefined).nextCount).toBe(1)
    expect(evaluateStopHookBlockCap(undefined).tripped).toBe(false)
  })
})
