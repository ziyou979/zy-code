import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../../src/bootstrap/runtime/runtimeContext.js'
import { modelSupportsStructuredOutputs } from '../../../src/services/feature-flags/betas.js'
import { getProviderForModel } from '../../../src/services/model/model.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'

let configDir: string
let previousConfig: string | undefined
let previousSources: ReturnType<typeof getAllowedSettingSources>

beforeEach(() => {
  previousConfig = process.env.ZY_CONFIG_DIR
  previousSources = getAllowedSettingSources()
  configDir = mkdtempSync(join(tmpdir(), 'zy-beta-model-'))
  process.env.ZY_CONFIG_DIR = configDir
  setAllowedSettingSources(['userSettings'])
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({
      provider: 'anthropic',
      models: { standard: { provider: 'generic-personal', model: 'glm-5.3-flash' } },
    }),
  )
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      'generic-personal': { provider: 'generic', apiFormat: 'openai-chat', apiKey: 'fixture-key' },
    }),
  )
  writeFileSync(
    join(configDir, 'model-capabilities.json'),
    JSON.stringify({
      models: [
        {
          pattern: 'glm-5.3-flash',
          provider: 'generic',
          apiFormat: 'openai-chat',
          capabilities: { structured_outputs: true },
        },
      ],
    }),
  )
  resetSettingsCache()
})

afterEach(() => {
  if (previousConfig === undefined) {
    delete process.env.ZY_CONFIG_DIR
  } else {
    process.env.ZY_CONFIG_DIR = previousConfig
  }
  setAllowedSettingSources(previousSources)
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

describe('betas model capabilities', () => {
  test('能力检查跟随当前模型命名连接，不受全局 provider 影响', () => {
    // 使用真实配置而非全局模块 mock，避免把 fake 模型 getter 泄漏给同进程测试。
    expect(getProviderForModel('glm-5.3-flash')).toBe('generic')
    expect(modelSupportsStructuredOutputs('glm-5.3-flash')).toBe(true)
  })
})
