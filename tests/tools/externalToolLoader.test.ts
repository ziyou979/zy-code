import { describe, expect, test } from 'bun:test'

import { hasExternalToolOverride } from '../../src/tools/externalToolLoader.js'

describe('externalToolLoader', () => {
  describe('hasExternalToolOverride', () => {
    test('returns false for non-existent tool name', () => {
      expect(hasExternalToolOverride('NonExistentTool')).toBe(false)
    })

    test('returns false for WebSearch when no external tool is loaded', () => {
      // 在没有加载外部工具的测试环境中，应该返回 false
      expect(hasExternalToolOverride('WebSearch')).toBe(false)
    })

    test('is case-sensitive', () => {
      expect(hasExternalToolOverride('websearch')).toBe(false)
      expect(hasExternalToolOverride('WEBSEARCH')).toBe(false)
    })
  })
})
