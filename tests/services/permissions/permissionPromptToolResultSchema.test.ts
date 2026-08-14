import { describe, expect, test } from 'bun:test'
import { outputSchema } from '../../../src/services/permissions/permissionPromptToolResultSchema.js'

describe('PermissionPromptToolResultSchema', () => {
  test('拒绝格式错误的 decisionClassification', () => {
    expect(
      outputSchema().safeParse({
        behavior: 'deny',
        message: 'no',
        decisionClassification: 'unexpected',
      }).success,
    ).toBe(false)
  })

  test('拒绝格式错误的 updatedPermissions', () => {
    expect(
      outputSchema().safeParse({
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: [{ type: 'unknown' }],
      }).success,
    ).toBe(false)
  })
})
