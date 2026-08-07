import { describe, expect, test } from 'bun:test'
import { createReadRuleSuggestion } from 'src/services/permissions/permissionUpdate.js'

describe('createReadRuleSuggestion', () => {
  test('应规范化目录末尾的分隔符', () => {
    const withoutTrailingSlash = createReadRuleSuggestion('/tmp/debug')
    const withTrailingSlash = createReadRuleSuggestion('/tmp/debug/')

    expect(withTrailingSlash).toEqual(withoutTrailingSlash)
    expect(withTrailingSlash?.type).toBe('addRules')
    if (withTrailingSlash?.type !== 'addRules') {
      throw new Error('预期生成新增权限规则')
    }
    expect(withTrailingSlash.rules[0]?.ruleContent).toBe('//tmp/debug/**')
  })

  test('根目录即使包含多个分隔符也不应生成规则', () => {
    expect(createReadRuleSuggestion('///')).toBeUndefined()
  })
})
