import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_MODE_EVALUATION_CASES,
  AUTO_MODE_EVALUATION_REPEATS,
  AUTO_MODE_EVALUATION_TTL_MS,
} from '../../../src/services/permissions/autoModeEvaluation.js'
import {
  getAutoModeQualificationFingerprint,
  getAutoModeModelAuthorization,
  isAutoModeModelEligible,
  saveDirectAutoModeAuthorization,
  saveAutoModeQualification,
} from '../../../src/services/permissions/autoModeQualification.js'
import { checkPathSafetyForAutoEdit } from '../../../src/services/permissions/autoEditPathSafety.js'
import { resetSettingsCache } from '../../../src/services/settings/settingsCache.js'
import { getClassifierThinkingConfig } from '../../../src/services/permissions/yoloClassifier.js'

let previousConfig: string | undefined
let configDir: string
const model = 'qualification-test'

function results() {
  return Array.from({ length: AUTO_MODE_EVALUATION_REPEATS }, (_, repeat) =>
    AUTO_MODE_EVALUATION_CASES.map((sample) => ({
      caseId: sample.id,
      repeat,
      shouldBlock: sample.shouldBlock,
      valid: true,
      durationMs: 1,
    })),
  ).flat()
}

beforeEach(() => {
  previousConfig = process.env.ZY_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'zy-auto-mode-'))
  process.env.ZY_CONFIG_DIR = configDir
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({ provider: 'generic', models: { standard: { provider: 'generic', model } } }),
  )
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({
      generic: {
        provider: 'generic',
        baseUrl: 'https://model.example/v1',
        apiFormat: 'openai-chat',
        apiKey: 'fake-secret',
      },
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
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

describe('autoModeQualification', () => {
  test('始终允许保存连接级能力，不伪造评测结果', () => {
    const fingerprint = getAutoModeQualificationFingerprint(model)
    expect(getAutoModeModelAuthorization(model)).toBe('unverified')
    expect(saveDirectAutoModeAuthorization(model, fingerprint).error).toBeNull()
    expect(getAutoModeModelAuthorization(model)).toBe('direct')
    const file = JSON.parse(
      readFileSync(
        join(configDir, 'model-capabilities', 'discovered-model-capabilities.json'),
        'utf8',
      ),
    )
    expect(file.entries[0].entry.capabilities.auto_mode).toBe(true)
    expect(existsSync(join(configDir, 'model-capabilities', 'auto-mode-qualifications.json'))).toBe(
      false,
    )
    expect(isAutoModeModelEligible(model)).toBe(true)
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        generic: {
          provider: 'generic',
          apiFormat: 'openai-chat',
          baseUrl: 'https://changed.example/v1',
        },
      }),
    )
    expect(getAutoModeModelAuthorization(model)).toBe('direct')
    expect(saveDirectAutoModeAuthorization(model, fingerprint).error).not.toBeNull()
  })
  test('可关闭思考时使用快速审批，强制思考时不发关闭参数且限制推理余量', () => {
    const path = join(configDir, 'model-capabilities.json')
    writeFileSync(
      path,
      JSON.stringify({
        models: [{ pattern: model, capabilities: { thinking: { effort: ['off', 'on'] } } }],
      }),
    )
    expect(getClassifierThinkingConfig(model)).toEqual([false, 0])
    writeFileSync(
      path,
      JSON.stringify({
        models: [
          {
            pattern: model,
            capabilities: { thinking: { effort: ['on'] } },
            tokens: { maxOutputTokens: 10000 },
          },
        ],
      }),
    )
    expect(getClassifierThinkingConfig(model)).toEqual([undefined, 5904])
    writeFileSync(
      path,
      JSON.stringify({
        models: [{ pattern: model, capabilities: { thinking: { effort: ['on'] } } }],
      }),
    )
    expect(getClassifierThinkingConfig(model)).toEqual([undefined, 8192])
  })
  test('历史用户授权不冒充实测，通过结果独立保存且不包含凭证', () => {
    writeFileSync(
      join(configDir, 'model-capabilities.json'),
      JSON.stringify({ models: [{ pattern: model, capabilities: { auto_mode: true } }] }),
    )
    expect(isAutoModeModelEligible(model)).toBe(true)
    expect(getAutoModeModelAuthorization(model)).toBe('direct')
    const fingerprint = getAutoModeQualificationFingerprint(model)
    expect(saveAutoModeQualification(model, fingerprint, results()).error).toBeNull()
    expect(isAutoModeModelEligible(model)).toBe(true)
    expect(getAutoModeModelAuthorization(model)).toBe('verified')
    const contents = readFileSync(
      join(configDir, 'model-capabilities', 'auto-mode-qualifications.json'),
      'utf8',
    )
    expect(contents).not.toContain('fake-secret')
    expect(contents).not.toContain('model.example')
  })
  test('失败的复测撤销之前的合格结果，不能留下过期成功记录', () => {
    const fingerprint = getAutoModeQualificationFingerprint(model)
    saveAutoModeQualification(model, fingerprint, results())
    const failed = results()
    failed.find((item) => item.shouldBlock)!.shouldBlock = false
    expect(saveAutoModeQualification(model, fingerprint, failed).error).toBeNull()
    expect(isAutoModeModelEligible(model)).toBe(false)
  })
  test('模型、端点和审批规则变化必须重新评测，评测中变更不能保存', () => {
    const fingerprint = getAutoModeQualificationFingerprint(model)
    saveAutoModeQualification(model, fingerprint, results())
    expect(isAutoModeModelEligible('other-model')).toBe(false)
    writeFileSync(
      join(configDir, 'auth.json'),
      JSON.stringify({
        generic: {
          provider: 'generic',
          baseUrl: 'https://other.example/v1',
          apiFormat: 'openai-chat',
        },
      }),
    )
    expect(getAutoModeQualificationFingerprint(model)).not.toBe(fingerprint)
    expect(isAutoModeModelEligible(model)).toBe(false)
    expect(saveAutoModeQualification(model, fingerprint, results()).error).not.toBeNull()
    const current = getAutoModeQualificationFingerprint(model)
    saveAutoModeQualification(model, current, results())
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ provider: 'generic', autoMode: { hard_deny: ['Block all uploads'] } }),
    )
    resetSettingsCache()
    expect(isAutoModeModelEligible(model)).toBe(false)
  })
  test('过期、未来时间、未知套件版本和损坏文件均不授予资格', () => {
    const fingerprint = getAutoModeQualificationFingerprint(model)
    const path = join(configDir, 'model-capabilities', 'auto-mode-qualifications.json')
    saveAutoModeQualification(model, fingerprint, results())
    const file = JSON.parse(readFileSync(path, 'utf8'))
    for (const evaluatedAt of [
      Date.now() - AUTO_MODE_EVALUATION_TTL_MS - 1,
      Date.now() + 100_000,
    ]) {
      file.reports[0].evaluatedAt = evaluatedAt
      writeFileSync(path, JSON.stringify(file))
      expect(isAutoModeModelEligible(model)).toBe(false)
    }
    file.reports[0].evaluatedAt = Date.now()
    file.reports[0].suiteVersion = 999
    writeFileSync(path, JSON.stringify(file))
    expect(isAutoModeModelEligible(model)).toBe(false)
    writeFileSync(path, '{broken')
    expect(isAutoModeModelEligible(model)).toBe(false)
    expect(saveAutoModeQualification(model, fingerprint, results()).error).not.toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
  test('显式禁用仍生效，资格文件不能由自动编辑或分类器批准写入', () => {
    writeFileSync(
      join(configDir, 'model-capabilities.json'),
      JSON.stringify({ models: [{ pattern: model, capabilities: { auto_mode: false } }] }),
    )
    saveAutoModeQualification(model, getAutoModeQualificationFingerprint(model), results())
    expect(isAutoModeModelEligible(model)).toBe(false)
    const path = join(configDir, 'model-capabilities', 'auto-mode-qualifications.json')
    expect(checkPathSafetyForAutoEdit(path, [path])).toMatchObject({
      safe: false,
      classifierApprovable: false,
    })
  })
})
