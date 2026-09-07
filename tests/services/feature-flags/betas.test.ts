import { describe, expect, mock, test } from 'bun:test'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as modelContextActual from '../../../src/services/context/modelContext.js'
import * as growthbookActual from '../../../src/services/analytics/growthbook.js'
import * as localModelCapabilitiesActual from '../../../src/services/settings/localModelCapabilities.js'
import * as modelActual from '../../../src/services/model/model.js'
import * as providersActual from '../../../src/services/model/providers.js'
import * as runtimeContextActual from '../../../src/bootstrap/runtime/runtimeContext.js'

const capabilityContexts: Array<{
  capability: string
  provider: string | null | undefined
}> = []

mock.module('../../../src/services/model/model.js', () => ({
  ...modelActual,
  getMainLoopModel: () => 'glm-5.3-flash',
  getProviderForModel: () => 'generic',
}))

mock.module('../../../src/services/model/providers.js', () => ({
  ...providersActual,
  getAPIProvider: () => 'xai',
  getEffectiveApiFormat: () => 'openai-chat',
  isAnthropicModel: () => false,
  providerHasCapability: () => false,
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

mock.module('../../../src/services/context/modelContext.js', () => ({
  ...modelContextActual,
  getContextWindowForModel: () => 200_000,
}))

// mock.module 是进程级全局替换：只覆盖测试关注的 getSdkBetas，
// 其余导出必须透传真实模块，否则同进程后续测试（如 effortInjection）
// 加载 runtimeContext 时会因缺导出而挂掉。
mock.module('../../../src/bootstrap/runtime/runtimeContext.js', () => ({
  ...runtimeContextActual,
  getSdkBetas: () => undefined,
}))

const { modelSupportsAutoMode, modelSupportsStructuredOutputs } = await import(
  '../../../src/services/feature-flags/betas.js'
)

describe('betas model capabilities', () => {
  test('能力检查跟随当前模型 provider，不受全局 provider 影响', () => {
    capabilityContexts.length = 0

    expect(modelSupportsAutoMode('glm-5.3-flash')).toBe(true)
    expect(modelSupportsStructuredOutputs('glm-5.3-flash')).toBe(true)
    expect(capabilityContexts).toEqual([
      { capability: 'auto_mode', provider: 'generic' },
      { capability: 'structured_outputs', provider: 'generic' },
    ])
  })
})
