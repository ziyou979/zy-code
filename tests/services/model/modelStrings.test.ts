import { afterEach, beforeEach, describe, expect, mock, test, spyOn } from 'bun:test'
import * as runtimeContextActual from '../../../src/bootstrap/runtime/runtimeContext.js'
import * as settingsActual from '../../../src/services/settings/settings.js'

interface ModelStringsState {
  modelStrings: Record<string, string> | null
}

// 每个用例重新安装函数 spy，并在结束时恢复原始绑定。
let state: ModelStringsState = { modelStrings: null }
let settings: Record<string, unknown> = {}
let throwOnGetInitialSettings = false

// 使用可恢复 spy 保留真实模块绑定，避免恢复时重新登记模块替身。
function registerMocks() {
  spyOn(runtimeContextActual, 'getModelStrings').mockImplementation(() => state.modelStrings)
  spyOn(runtimeContextActual, 'setModelStrings').mockImplementation((value) => {
    state.modelStrings = value
  })
  spyOn(settingsActual, 'getInitialSettings').mockImplementation(() => {
    if (throwOnGetInitialSettings) {
      throw new Error('Settings not loaded')
    }
    return settings as ReturnType<typeof settingsActual.getInitialSettings>
  })
}

describe('modelStrings', () => {
  beforeEach(() => {
    state = { modelStrings: null }
    settings = {}
    throwOnGetInitialSettings = false
    registerMocks()
  })

  afterEach(() => {
    mock.restore()
  })

  describe('getModelStrings', () => {
    test('未初始化时从 settings.modelOverrides 初始化', () => {
      settings = { modelOverrides: { 'qwen3.6-plus': 'bedrock-arn' } }
      const { getModelStrings } = require('../../../src/services/model/modelStrings.js')
      expect(getModelStrings()).toEqual({ 'qwen3.6-plus': 'bedrock-arn' })
      expect(state.modelStrings).toEqual({ 'qwen3.6-plus': 'bedrock-arn' })
    })

    test('已初始化时直接返回缓存值', () => {
      state.modelStrings = { 'claude-opus-4': 'vertex-id' }
      settings = { modelOverrides: { 'qwen3.6-plus': 'bedrock-arn' } }
      const { getModelStrings } = require('../../../src/services/model/modelStrings.js')
      expect(getModelStrings()).toEqual({ 'claude-opus-4': 'vertex-id' })
    })

    test('modelOverrides 为空时返回空对象', () => {
      settings = {}
      const { getModelStrings } = require('../../../src/services/model/modelStrings.js')
      expect(getModelStrings()).toEqual({})
    })
  })

  describe('ensureModelStringsInitialized', () => {
    test('未初始化时写入 settings.modelOverrides', async () => {
      settings = { modelOverrides: { 'qwen3.6-plus': 'bedrock-arn' } }
      const {
        ensureModelStringsInitialized,
      } = require('../../../src/services/model/modelStrings.js')
      await ensureModelStringsInitialized()
      expect(state.modelStrings).toEqual({ 'qwen3.6-plus': 'bedrock-arn' })
    })

    test('已初始化时保持原值不变', async () => {
      state.modelStrings = { 'claude-opus-4': 'vertex-id' }
      settings = { modelOverrides: { 'qwen3.6-plus': 'bedrock-arn' } }
      const {
        ensureModelStringsInitialized,
      } = require('../../../src/services/model/modelStrings.js')
      await ensureModelStringsInitialized()
      expect(state.modelStrings).toEqual({ 'claude-opus-4': 'vertex-id' })
    })
  })

  describe('resolveOverriddenModel', () => {
    test('将 provider-specific ID 反向解析为 canonical ID', () => {
      settings = {
        modelOverrides: { 'qwen3.6-plus': 'bedrock-arn', 'claude-opus-4': 'vertex-id' },
      }
      const { resolveOverriddenModel } = require('../../../src/services/model/modelStrings.js')
      expect(resolveOverriddenModel('bedrock-arn')).toBe('qwen3.6-plus')
      expect(resolveOverriddenModel('vertex-id')).toBe('claude-opus-4')
    })

    test('未匹配到 override 时返回原值', () => {
      settings = { modelOverrides: { 'qwen3.6-plus': 'bedrock-arn' } }
      const { resolveOverriddenModel } = require('../../../src/services/model/modelStrings.js')
      expect(resolveOverriddenModel('unknown-id')).toBe('unknown-id')
    })

    test('settings 不可用时返回原值', () => {
      throwOnGetInitialSettings = true
      const { resolveOverriddenModel } = require('../../../src/services/model/modelStrings.js')
      expect(resolveOverriddenModel('some-id')).toBe('some-id')
    })
  })
})
