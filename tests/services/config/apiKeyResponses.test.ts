import { describe, expect, it } from 'bun:test'
import {
  withApprovedFingerprint,
  withRejectedFingerprint,
} from '../../../src/services/config/config.js'

// 只测纯函数。approveApiKeyFingerprint / rejectApiKeyFingerprint 是
// `saveGlobalConfig((c) => ({ ...c, apiKeyResponses: with*Fingerprint(...) }))`
// 的一行薄包装，其正确性由下方纯函数保证 + tsc 类型检查。
// 依赖 TEST_GLOBAL_CONFIG_FOR_TESTING 全局单例的写入断言在 bun 全量并行
// （--parallel 复用 worker）下会与同 worker 其他测试文件共享模块实例，
// 行为不稳定，故不在此断言真实写入。

const FP = 'abcdefghijklmnopqrst' // 20 字符指纹样例

describe('withApprovedFingerprint - 幂等且互斥', () => {
  it('空 responses 时初始化 approved，rejected 为空数组', () => {
    expect(withApprovedFingerprint(undefined, FP)).toEqual({
      approved: [FP],
      rejected: [],
    })
  })

  it('已有同指纹时不重复追加', () => {
    const responses = { approved: [FP], rejected: [] }
    expect(withApprovedFingerprint(responses, FP)).toEqual({
      approved: [FP],
      rejected: [],
    })
  })

  it('指纹已在 rejected 时移动到 approved（双向迁移）', () => {
    const responses = { approved: [], rejected: [FP] }
    expect(withApprovedFingerprint(responses, FP)).toEqual({
      approved: [FP],
      rejected: [],
    })
  })

  it('保留其他指纹，只处理目标指纹', () => {
    const responses = { approved: ['other-fp-1'], rejected: ['other-fp-2'] }
    expect(withApprovedFingerprint(responses, FP)).toEqual({
      approved: ['other-fp-1', FP],
      rejected: ['other-fp-2'],
    })
  })

  it('rejected 缺省时初始化为空数组而非 undefined', () => {
    const result = withApprovedFingerprint({ approved: ['a'] }, FP)
    expect(result.rejected).toEqual([])
  })
})

describe('withRejectedFingerprint - 幂等且互斥', () => {
  it('空 responses 时初始化 rejected，approved 为空数组', () => {
    expect(withRejectedFingerprint(undefined, FP)).toEqual({
      approved: [],
      rejected: [FP],
    })
  })

  it('已有同指纹时不重复追加', () => {
    const responses = { approved: [], rejected: [FP] }
    expect(withRejectedFingerprint(responses, FP)).toEqual({
      approved: [],
      rejected: [FP],
    })
  })

  it('指纹已在 approved 时移动到 rejected（双向迁移）', () => {
    const responses = { approved: [FP], rejected: [] }
    expect(withRejectedFingerprint(responses, FP)).toEqual({
      approved: [],
      rejected: [FP],
    })
  })

  it('保留其他指纹，只处理目标指纹', () => {
    const responses = { approved: ['other-fp-1'], rejected: ['other-fp-2'] }
    expect(withRejectedFingerprint(responses, FP)).toEqual({
      approved: ['other-fp-1'],
      rejected: ['other-fp-2', FP],
    })
  })
})

describe('互斥一致性 - approved 与 rejected 不会同时包含同一指纹', () => {
  it('先拒绝再批准：rejected 中的指纹被移除', () => {
    const rejected = withRejectedFingerprint(undefined, FP)
    const approved = withApprovedFingerprint(rejected, FP)
    expect(approved.approved).toContain(FP)
    expect(approved.rejected).not.toContain(FP)
  })

  it('先批准再拒绝：approved 中的指纹被移除', () => {
    const approved = withApprovedFingerprint(undefined, FP)
    const rejected = withRejectedFingerprint(approved, FP)
    expect(rejected.rejected).toContain(FP)
    expect(rejected.approved).not.toContain(FP)
  })

  it('连点 5 次批准：列表内仅一条', () => {
    let responses = withApprovedFingerprint(undefined, FP)
    for (let i = 0; i < 4; i++) {
      responses = withApprovedFingerprint(responses, FP)
    }
    expect(responses.approved?.filter((k) => k === FP)).toHaveLength(1)
  })
})
