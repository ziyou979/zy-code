/**
 * 远程托管设置安全同意（CC 2.1.207：非交互不得永久记录 consent）
 */
import { describe, expect, test } from 'bun:test'
import {
  type SecurityCheckResult,
  shouldPersistManagedSettingsAfterSecurityCheck,
} from '../../../src/services/remote-managed-settings/securityPolicy.js'

describe('shouldPersistManagedSettingsAfterSecurityCheck', () => {
  test('approved / no_check_needed 可落盘', () => {
    expect(shouldPersistManagedSettingsAfterSecurityCheck('approved')).toBe(true)
    expect(shouldPersistManagedSettingsAfterSecurityCheck('no_check_needed')).toBe(true)
  })

  test('deferred_non_interactive 禁止落盘为已同意', () => {
    expect(shouldPersistManagedSettingsAfterSecurityCheck('deferred_non_interactive')).toBe(false)
  })

  test('rejected 禁止落盘', () => {
    // rejected 路径本就不会应用；persist 守卫同样为 false
    const r: SecurityCheckResult = 'rejected'
    expect(shouldPersistManagedSettingsAfterSecurityCheck(r)).toBe(false)
  })
})
