/**
 * bashCommandDetection 命令检测测试。
 *
 * 覆盖范围：
 *   - isNormalizedGitCommand：git 命令检测
 *   - isNormalizedCdCommand：cd/pushd/popd 命令检测
 *   - commandHasAnyCd：复合命令中的 cd 检测
 *
 * 依赖 mock：stripSafeWrappers 在无 wrapper 时返回原值，
 * shell parser 在简单命令下正常工作。
 */
import { describe, expect, test } from 'bun:test'

const { isNormalizedGitCommand, isNormalizedCdCommand, commandHasAnyCd } = await import(
  '../../../src/tools/BashTool/bashCommandDetection.js'
)

// ============================================================================
// isNormalizedGitCommand
// ============================================================================
describe('isNormalizedGitCommand', () => {
  test('git status 识别为 git 命令', () => {
    expect(isNormalizedGitCommand('git status')).toBe(true)
  })

  test('git 单独识别为 git 命令', () => {
    expect(isNormalizedGitCommand('git')).toBe(true)
  })

  test('ls 不是 git 命令', () => {
    expect(isNormalizedGitCommand('ls')).toBe(false)
  })

  test('空字符串不是 git 命令', () => {
    expect(isNormalizedGitCommand('')).toBe(false)
  })

  test('cd 不是 git 命令', () => {
    expect(isNormalizedGitCommand('cd /tmp')).toBe(false)
  })
})

// ============================================================================
// isNormalizedCdCommand
// ============================================================================
describe('isNormalizedCdCommand', () => {
  test('cd /tmp 识别为 cd 命令', () => {
    expect(isNormalizedCdCommand('cd /tmp')).toBe(true)
  })

  test('pushd 识别为 cd 命令', () => {
    expect(isNormalizedCdCommand('pushd /tmp')).toBe(true)
  })

  test('popd 识别为 cd 命令', () => {
    expect(isNormalizedCdCommand('popd')).toBe(true)
  })

  test('ls 不是 cd 命令', () => {
    expect(isNormalizedCdCommand('ls')).toBe(false)
  })

  test('git 不是 cd 命令', () => {
    expect(isNormalizedCdCommand('git status')).toBe(false)
  })

  test('空字符串不是 cd 命令', () => {
    expect(isNormalizedCdCommand('')).toBe(false)
  })
})

// ============================================================================
// commandHasAnyCd
// ============================================================================
describe('commandHasAnyCd', () => {
  test('简单 cd 命令包含 cd', () => {
    expect(commandHasAnyCd('cd /tmp')).toBe(true)
  })

  test('复合命令中的 cd 被检测到', () => {
    expect(commandHasAnyCd('ls && cd /tmp')).toBe(true)
  })

  test('仅 ls 不包含 cd', () => {
    expect(commandHasAnyCd('ls -la')).toBe(false)
  })

  test('多命令中的 cd 被检测到', () => {
    expect(commandHasAnyCd('echo a; cd /tmp; echo b')).toBe(true)
  })
})
