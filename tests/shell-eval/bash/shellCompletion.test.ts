import { describe, expect, test } from 'bun:test'
import {
  applyShellSuggestion,
  findShellTokenStart,
} from '../../../src/hooks/typeaheadTokenUtils.js'
import {
  detectCompletionShellType,
  getShellCompletions,
  parseInputContext,
} from '../../../src/shell-eval/bash/shellCompletion.js'
import { runWithCwdOverride } from '../../../src/services/environment/cwd.js'
import { findSuitableShell, getShellConfig } from '../../../src/services/shell/shell.js'

describe('shellCompletion', () => {
  test('从 Windows Git Bash 路径识别 bash', () => {
    expect(detectCompletionShellType('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(detectCompletionShellType('/usr/bin/zsh')).toBe('zsh')
    expect(detectCompletionShellType('C:\\Windows\\System32\\cmd.exe')).toBeNull()
  })

  test('区分命令、参数路径和环境变量补全', () => {
    expect(parseInputContext('git', 3)).toEqual({ prefix: 'git', completionType: 'command' })
    expect(parseInputContext('cat package.j', 13)).toEqual({
      prefix: 'package.j',
      completionType: 'file',
    })
    expect(parseInputContext('echo $PAT', 9)).toEqual({
      prefix: '$PAT',
      completionType: 'variable',
    })
    expect(parseInputContext('echo ok|gi', 10)).toEqual({
      prefix: 'gi',
      completionType: 'command',
    })
  })

  test('找到引号路径和操作符后 token 的起点', () => {
    expect(findShellTokenStart('cat "docs/my f')).toBe(4)
    expect(findShellTokenStart('echo ok|gi')).toBe(8)
    expect(findShellTokenStart('cat foo\\ bar')).toBe(4)
  })

  test('应用候选时引用带空格路径并保留后续输入', () => {
    let value = ''
    let cursorOffset = -1
    applyShellSuggestion(
      { id: 'docs/my file.md ', displayText: 'docs/my file.md ' },
      'cat docs/my\\ f --flag',
      14,
      (nextValue) => {
        value = nextValue
      },
      (nextOffset) => {
        cursorOffset = nextOffset
      },
      'file',
    )

    expect(value).toBe("cat 'docs/my file.md' --flag")
    expect(cursorOffset).toBe(21)
  })

  test('应用管道后的命令候选只替换当前 token', () => {
    let value = ''
    applyShellSuggestion(
      { id: 'git', displayText: 'git' },
      'echo ok|gi',
      10,
      (nextValue) => {
        value = nextValue
      },
      () => {},
      'command',
    )

    expect(value).toBe('echo ok|git ')
  })

  test('通过当前配置的 shell 获取仓库文件候选', async () => {
    const shellPath = await findSuitableShell().catch(() => null)
    // 全量测试中的环境变量用例可能暂时移除 PATH；没有可用 POSIX shell 时不满足集成前提。
    if (!shellPath || !detectCompletionShellType(shellPath)) {
      return
    }
    // 其他测试可能在不同环境变量下预热过会话级 shell 配置，先清理共享缓存。
    getShellConfig.cache.clear?.()
    const input = 'cat package.j'
    const suggestions = await runWithCwdOverride(process.cwd(), () =>
      getShellCompletions(input, input.length, new AbortController().signal),
    )

    expect(suggestions.some((suggestion) => suggestion.displayText === 'package.json ')).toBe(true)
  })
})
