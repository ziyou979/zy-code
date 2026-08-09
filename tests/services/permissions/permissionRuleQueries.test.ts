import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../src/tools/tool.js'
import * as realSettings from '../../../src/services/settings/settings.js'

let classifyAllShell = false

mock.module('../../../src/services/settings/settings.js', () => ({
  ...realSettings,
  getAutoModeConfig: () => (classifyAllShell ? { classifyAllShell: true } : undefined),
}))

const { getAllowRules } = await import('../../../src/services/permissions/permissionRuleQueries.js')

function createContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {
      session: ['Bash(git status:*)', 'PowerShell(Get-Process:*)', 'FileRead'],
    },
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

describe('getAllowRules classifyAllShell', () => {
  afterEach(() => {
    classifyAllShell = false
  })

  test('默认保留 Bash 和 PowerShell allow 规则', () => {
    const rules = getAllowRules(createContext({ mode: 'auto' }))
    expect(rules.map((rule) => rule.ruleValue.toolName)).toEqual(['Bash', 'PowerShell', 'FileRead'])
  })

  test('启用后在 auto 模式暂停两类 shell allow 规则', () => {
    classifyAllShell = true
    const rules = getAllowRules(createContext({ mode: 'auto' }))
    expect(rules.map((rule) => rule.ruleValue.toolName)).toEqual(['FileRead'])
  })

  test('plan 使用 auto 语义时同样暂停 shell allow 规则', () => {
    classifyAllShell = true
    const rules = getAllowRules(createContext({ mode: 'plan', strippedDangerousRules: {} }))
    expect(rules.map((rule) => rule.ruleValue.toolName)).toEqual(['FileRead'])
  })

  test('离开 auto 语义后立即恢复原 shell allow 规则', () => {
    classifyAllShell = true
    const rules = getAllowRules(createContext({ mode: 'default' }))
    expect(rules.map((rule) => rule.ruleValue.toolName)).toEqual(['Bash', 'PowerShell', 'FileRead'])
  })
})
