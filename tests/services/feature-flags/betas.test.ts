import { afterAll, describe, expect, mock, test } from 'bun:test'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as growthbookActual from '../../../src/services/analytics/growthbook.js'
import * as localModelCapabilitiesActual from '../../../src/services/settings/localModelCapabilities.js'
import * as modelActual from '../../../src/services/model/model.js'

const capabilityContexts: Array<{
  capability: string
  provider: string | null | undefined
}> = []

// 跨文件污染根因（已用最小复现证实）：bun 1.3.14 的 mock.module 是进程级全局
// 注册表，mock.restore() 不撤销它；文件并发交错执行时，本文件此前在**顶层**
// fake providers.js（getEffectiveApiFormat→'openai-chat'）与 model.js 等宽面
// 模块，fake 常驻注册表并泄漏给同 worker 的 opencodeGo / modelProviderRouting /
// effortInjection 等文件。修复策略（全部落实）：
// 1) 彻底不再 fake providers.js——测试只观察 localModelHasCapability 收到的
//    context.provider；apiFormat 字段走真实解析（不影响断言）。实测只要 fake
//    过 providers.getEffectiveApiFormat（哪怕仅在同步区间内登记+finally 恢复），
//    交错中的 opencodeGo 仍会读到 'openai-chat'——静态绑定的命名空间读取会命中
//    交错窗口内的 fake 实例，因此该接缝绝不允许被触碰。
// 2) fake 收窄到 model.js / localModelCapabilities.js / growthbook.js 三个
//    spread-real 接缝，且只在测试体内登记、finally 立即恢复真实快照、afterAll
//    兜底——泄漏窗口从"整个 worker 生命周期"压缩到"单个测试体的同步区间"。
async function runWithFakes(fn: () => void) {
  mock.module('../../../src/services/model/model.js', () => ({
    ...modelActual,
    getMainLoopModel: () => 'glm-5.3-flash',
    getProviderForModel: () => 'generic',
  }))
  mock.module('../../../src/services/settings/localModelCapabilities.js', () => ({
    ...localModelCapabilitiesActual,
    getLocalModelBetaHeaders: () => undefined,
    localModelHasCapability: (
      _model: string,
      capability: string,
      context?: { provider?: string | null },
    ) => {
      capabilityContexts.push({ capability, provider: context?.provider })
      return context?.provider === 'generic'
    },
  }))
  mock.module('../../../src/services/analytics/growthbook.js', () => ({
    ...growthbookActual,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
    getFeatureValue_CACHED_MAY_BE_STALE: <T>(_feature: string, defaultValue: T) => defaultValue,
  }))
  try {
    fn()
  } finally {
    mock.module('../../../src/services/model/model.js', () => ({ ...modelActual }))
    mock.module('../../../src/services/settings/localModelCapabilities.js', () => ({
      ...localModelCapabilitiesActual,
    }))
    mock.module('../../../src/services/analytics/growthbook.js', () => ({ ...growthbookActual }))
  }
}

const { modelSupportsAutoMode, modelSupportsStructuredOutputs } = await import(
  '../../../src/services/feature-flags/betas.js'
)

afterAll(() => {
  // 兜底恢复（正常路径已在 runWithFakes 的 finally 中完成）。
  mock.module('../../../src/services/model/model.js', () => ({ ...modelActual }))
  mock.module('../../../src/services/settings/localModelCapabilities.js', () => ({
    ...localModelCapabilitiesActual,
  }))
  mock.module('../../../src/services/analytics/growthbook.js', () => ({ ...growthbookActual }))
})

describe('betas model capabilities', () => {
  test('能力检查跟随当前模型 provider，不受全局 provider 影响', () => {
    capabilityContexts.length = 0

    runWithFakes(() => {
      expect(modelSupportsAutoMode('glm-5.3-flash')).toBe(true)
      expect(modelSupportsStructuredOutputs('glm-5.3-flash')).toBe(true)
    })

    expect(capabilityContexts).toEqual([
      { capability: 'auto_mode', provider: 'generic' },
      { capability: 'structured_outputs', provider: 'generic' },
    ])
  })
})
