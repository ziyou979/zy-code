import { describe, expect, test } from 'bun:test'
import { getWindowsShellInfoLine } from '../../src/constants/prompts.js'

describe('getWindowsShellInfoLine', () => {
  test('Git Bash 可用且未选择 PowerShell 时以实际 Bash 路由为主', () => {
    expect(
      getWindowsShellInfoLine({
        bashAvailable: true,
        defaultShell: 'bash',
        powerShellToolEnabled: true,
        shellName: 'unknown',
      }),
    ).toBe(
      'Shell: bash (primary); PowerShell tool also available for PowerShell scripts — each takes its own syntax.',
    )
  })

  test('显式选择 PowerShell 时仍提示 Bash 是可用的辅助工具', () => {
    expect(
      getWindowsShellInfoLine({
        bashAvailable: true,
        defaultShell: 'powershell',
        powerShellToolEnabled: true,
        shellName: 'bash',
      }),
    ).toBe(
      'Shell: PowerShell (primary); Bash tool also available for POSIX scripts — each takes its own syntax.',
    )
  })
})
