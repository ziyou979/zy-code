import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

describe('getUltraplanModel', () => {
  let advancedModel: string | undefined = undefined
  let mainLoopModel: string | undefined = undefined

  beforeEach(() => {
    advancedModel = undefined
    mainLoopModel = undefined

    mock.module('src/services/model/model.js', () => ({
      getDefaultAdvancedModel: () => advancedModel,
      getDefaultMainLoopModel: () => mainLoopModel,
    }))

    mock.module('src/services/analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: (_feature: string, defaultValue: string) => defaultValue,
    }))

    mock.module('src/i18n/index.js', () => ({
      tSync: (key: string) => key,
      t: (key: string) => key,
    }))
  })

  afterEach(() => {
    mock.restore()
  })

  test('优先使用 advanced 模型', () => {
    advancedModel = 'claude-opus-4'
    mainLoopModel = 'claude-sonnet-4'
    const { getUltraplanModel } = require('../../../src/services/ultraplan/model')
    expect(getUltraplanModel()).toBe('claude-opus-4')
  })

  test('advanced 缺失时 fallback 到标准模型', () => {
    mainLoopModel = 'claude-sonnet-4'
    const { getUltraplanModel } = require('../../../src/services/ultraplan/model')
    expect(getUltraplanModel()).toBe('claude-sonnet-4')
  })

  test('未配置任何模型时抛出错误', () => {
    const { getUltraplanModel } = require('../../../src/services/ultraplan/model')
    expect(() => getUltraplanModel()).toThrow('ultraplan.noModelConfigured')
  })
})
