/**
 * envUtils 测试：环境判断工具函数。
 *
 * 重点关注：
 * - 各类环境变量布尔值解析（isEnvTruthy / isEnvDefinedFalsy）
 * - parseEnvVars 格式校验
 * - isInternalBuild / getUserType 等构建时门控
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  hasNodeOption,
  isBareMode,
  isEnvDefinedFalsy,
  isEnvTruthy,
  parseEnvVars,
  shouldMaintainProjectWorkingDir,
} from '../../src/utils/envUtils.js'

describe('envUtils', () => {
  describe('isEnvTruthy', () => {
    test('undefined → false', () => {
      expect(isEnvTruthy(undefined)).toBe(false)
    })

    test('boolean true → true', () => {
      expect(isEnvTruthy(true)).toBe(true)
    })

    test('boolean false → false', () => {
      expect(isEnvTruthy(false)).toBe(false)
    })

    test('空字符串 → false', () => {
      expect(isEnvTruthy('')).toBe(false)
    })

    test('"1" → true', () => {
      expect(isEnvTruthy('1')).toBe(true)
    })

    test('"true" → true', () => {
      expect(isEnvTruthy('true')).toBe(true)
    })

    test('"yes" → true', () => {
      expect(isEnvTruthy('yes')).toBe(true)
    })

    test('"on" → true', () => {
      expect(isEnvTruthy('on')).toBe(true)
    })

    test('"TRUE"（大写）→ true', () => {
      expect(isEnvTruthy('TRUE')).toBe(true)
    })

    test('"0" → false', () => {
      expect(isEnvTruthy('0')).toBe(false)
    })

    test('"false" → false', () => {
      expect(isEnvTruthy('false')).toBe(false)
    })

    test('"no" → false', () => {
      expect(isEnvTruthy('no')).toBe(false)
    })
  })

  describe('isEnvDefinedFalsy', () => {
    test('undefined → false', () => {
      expect(isEnvDefinedFalsy(undefined)).toBe(false)
    })

    test('boolean false → true', () => {
      expect(isEnvDefinedFalsy(false)).toBe(true)
    })

    test('boolean true → false', () => {
      expect(isEnvDefinedFalsy(true)).toBe(false)
    })

    test('"0" → true', () => {
      expect(isEnvDefinedFalsy('0')).toBe(true)
    })

    test('"false" → true', () => {
      expect(isEnvDefinedFalsy('false')).toBe(true)
    })

    test('"no" → true', () => {
      expect(isEnvDefinedFalsy('no')).toBe(true)
    })

    test('"off" → true', () => {
      expect(isEnvDefinedFalsy('off')).toBe(true)
    })

    test('"FALSE"（大写）→ true', () => {
      expect(isEnvDefinedFalsy('FALSE')).toBe(true)
    })

    test('空字符串 → false', () => {
      expect(isEnvDefinedFalsy('')).toBe(false)
    })

    test('"1" → false', () => {
      expect(isEnvDefinedFalsy('1')).toBe(false)
    })
  })

  describe('parseEnvVars', () => {
    test('单个 K=V', () => {
      expect(parseEnvVars(['FOO=bar'])).toEqual({ FOO: 'bar' })
    })

    test('多个 K=V', () => {
      expect(parseEnvVars(['A=1', 'B=2'])).toEqual({ A: '1', B: '2' })
    })

    test('值中包含等号：只按第一个 = 分割', () => {
      expect(parseEnvVars(['SECRET=sha256=abc123'])).toEqual({ SECRET: 'sha256=abc123' })
    })

    test('值为空字符串', () => {
      expect(parseEnvVars(['EMPTY='])).toEqual({ EMPTY: '' })
    })

    test('undefined → 空对象', () => {
      expect(parseEnvVars(undefined)).toEqual({})
    })

    test('空数组 → 空对象', () => {
      expect(parseEnvVars([])).toEqual({})
    })

    test('缺少等号时抛错', () => {
      expect(() => parseEnvVars(['INVALID'])).toThrow('Invalid environment variable format')
    })

    test('键为空字符串时也抛错', () => {
      expect(() => parseEnvVars(['=value'])).toThrow('Invalid environment variable format')
    })
  })

  describe('isBareMode', () => {
    const originalArgv = process.argv
    const originalEnv = process.env.ZY_CODE_SIMPLE

    afterEach(() => {
      process.argv = originalArgv
      process.env.ZY_CODE_SIMPLE = originalEnv
    })

    test('默认模式（无标志、无环境变量）→ false', () => {
      process.argv = ['bun', 'cli.tsx']
      delete process.env.ZY_CODE_SIMPLE
      expect(isBareMode()).toBe(false)
    })

    test('环境变量 ZY_CODE_SIMPLE=1 → true', () => {
      process.argv = ['bun', 'cli.tsx']
      process.env.ZY_CODE_SIMPLE = '1'
      expect(isBareMode()).toBe(true)
    })

    test('argv 包含 --bare → true', () => {
      process.argv = ['bun', 'cli.tsx', '--bare']
      delete process.env.ZY_CODE_SIMPLE
      expect(isBareMode()).toBe(true)
    })
  })

  describe('hasNodeOption', () => {
    const originalNodeOptions = process.env.NODE_OPTIONS

    afterEach(() => {
      process.env.NODE_OPTIONS = originalNodeOptions
    })

    test('NODE_OPTIONS 未设置时返回 false', () => {
      delete process.env.NODE_OPTIONS
      expect(hasNodeOption('--experimental-strip-types')).toBe(false)
    })

    test('精确匹配返回 true', () => {
      process.env.NODE_OPTIONS = '--experimental-strip-types --no-warnings'
      expect(hasNodeOption('--experimental-strip-types')).toBe(true)
    })

    test('子串不匹配（防止误匹配）', () => {
      process.env.NODE_OPTIONS = '--experimental-strip-types'
      expect(hasNodeOption('--experimental')).toBe(false)
    })
  })

  describe('shouldMaintainProjectWorkingDir', () => {
    const originalEnv = process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR

    afterEach(() => {
      process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = originalEnv
    })

    test('未设置时返回 false', () => {
      delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
      expect(shouldMaintainProjectWorkingDir()).toBe(false)
    })

    test('设为 "true" 时返回 true', () => {
      process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = 'true'
      expect(shouldMaintainProjectWorkingDir()).toBe(true)
    })

    test('设为 "0" 时返回 false', () => {
      process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '0'
      expect(shouldMaintainProjectWorkingDir()).toBe(false)
    })
  })
})
