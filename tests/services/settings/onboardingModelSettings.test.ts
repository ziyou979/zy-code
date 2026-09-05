import { describe, expect, test } from 'bun:test'
import { buildOnboardingModels } from '../../../src/services/settings/onboardingModelSettings.js'

describe('onboardingModelSettings', () => {
  test('为每个已选择档位写入认证连接 id', () => {
    expect(
      buildOnboardingModels('generic-primary', {
        standard: 'model-standard',
        advanced: 'model-advanced',
      }),
    ).toEqual({
      standard: { provider: 'generic-primary', model: 'model-standard' },
      advanced: { provider: 'generic-primary', model: 'model-advanced' },
    })
  })

  test('不为跳过的可选档位生成配置', () => {
    expect(buildOnboardingModels('dashscope', { standard: 'qwen-standard' })).toEqual({
      standard: { provider: 'dashscope', model: 'qwen-standard' },
    })
  })
})
