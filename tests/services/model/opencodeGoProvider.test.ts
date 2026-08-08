import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEffectiveApiFormat } from '../../../src/services/model/providers.js'

describe('opencode-go provider', () => {
  let previousConfigDir: string | undefined
  let configDir: string

  beforeEach(() => {
    previousConfigDir = process.env.ZY_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), 'zy-opencode-go-provider-'))
    process.env.ZY_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.ZY_CONFIG_DIR
    } else {
      process.env.ZY_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('Go 的 OpenAI-compatible 模型走 openai-chat 格式', () => {
    expect(getEffectiveApiFormat('opencode-go', 'opencode-go/kimi-k2.7-code')).toBe('openai-chat')
    expect(getEffectiveApiFormat('opencode-go', 'glm-5.2')).toBe('openai-chat')
    expect(getEffectiveApiFormat('opencode-go', 'deepseek-v4-flash')).toBe('openai-chat')
    expect(getEffectiveApiFormat('opencode-go', 'mimo-v2.5-pro')).toBe('openai-chat')
  })

  test('Go 的 Messages 模型走 anthropic 格式', () => {
    expect(getEffectiveApiFormat('opencode-go', 'opencode-go/minimax-m3')).toBe('anthropic')
    expect(getEffectiveApiFormat('opencode-go', 'qwen3.7-max')).toBe('anthropic')
    expect(getEffectiveApiFormat('opencode-go', 'qwen3.6-plus')).toBe('anthropic')
  })
})
