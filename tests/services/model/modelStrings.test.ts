import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
// Bun 的 mock.module factory 内不能 import 被 mock 的目标模块（返回空对象，
// 透传失效甚至卡死加载链），真实导出必须在 factory 外顶层加载。
import * as runtimeContextActual from '../../../src/bootstrap/runtime/runtimeContext.js'
import * as settingsActual from '../../../src/services/settings/settings.js'

interface ModelStringsState {
  modelStrings: Record<string, string> | null
}

// 可变测试状态：mock 工厂在注册表重建时求值，读取最新闭包变量。
let state: ModelStringsState = { modelStrings: null }
let settings: Record<string, unknown> = {}
let throwOnGetInitialSettings = false

// mock.module 是进程级全局替换且 mock.restore() 不撤销它：此前窄面 mock
// （runtimeContext 只给 getModelStrings/setModelStrings、settings 只给
// getInitialSettings）丢失其余导出（如 getSessionId），泄漏给同 worker 后续
// 文件报 "Export named ... not found"。改为真实快照 spread + 仅覆盖所需导出；
// fake 只在测试体内登记，afterEach 恢复真实快照、afterAll 兜底，把泄漏窗口
// 限制在本文件执行期内。
const MOCK_PATHS = {
  runtimeContext: '../../../src/bootstrap/runtime/runtimeContext.js',
  settings: '../../../src/services/settings/settings.js',
} as const

function registerMocks() {
  mock.module(MOCK_PATHS.runtimeContext, () => ({
    ...runtimeContextActual,
    getModelStrings: () => state.modelStrings,
    setModelStrings: (ms: Record<string, string>) => {
      state.modelStrings = ms
    },
  }))
  mock.module(MOCK_PATHS.settings, () => ({
    ...settingsActual,
    getInitialSettings: () => {
      if (throwOnGetInitialSettings) {
        throw new Error('Settings not loaded')
      }
      return settings
    },
  }))
}

function restoreRealModules() {
  mock.module(MOCK_PATHS.runtimeContext, () => ({ ...runtimeContextActual }))
  mock.module(MOCK_PATHS.settings, () => ({ ...settingsActual }))
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
    restoreRealModules()
  })

  afterAll(() => {
    restoreRealModules()
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
