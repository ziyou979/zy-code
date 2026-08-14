/**
 * ideCatalog 纯函数测试。
 *
 * 覆盖范围：
 *   - isVSCodeIde / isJetBrainsIde：IDE 类型判断
 *   - toIDEDisplayName：IDE 展示名称解析
 */
import { describe, expect, test } from 'bun:test'

import type { IdeType } from '../../../src/services/ide/ideTypes.js'

const { isVSCodeIde, isJetBrainsIde, toIDEDisplayName } = await import(
  '../../../src/services/ide/ideCatalog.js'
)

describe('isVSCodeIde', () => {
  test('null 返回 false', () => {
    expect(isVSCodeIde(null)).toBe(false)
  })

  test('cursor 属于 vscode 系', () => {
    expect(isVSCodeIde('cursor' as IdeType)).toBe(true)
  })

  test('windsurf 属于 vscode 系', () => {
    expect(isVSCodeIde('windsurf' as IdeType)).toBe(true)
  })

  test('vscode 自身属于 vscode 系', () => {
    expect(isVSCodeIde('vscode' as IdeType)).toBe(true)
  })

  test('intellij 不属于 vscode 系', () => {
    expect(isVSCodeIde('intellij' as IdeType)).toBeFalsy()
  })
})

describe('isJetBrainsIde', () => {
  test('null 返回 false', () => {
    expect(isJetBrainsIde(null)).toBe(false)
  })

  test('intellij 属于 jetbrains 系', () => {
    expect(isJetBrainsIde('intellij' as IdeType)).toBe(true)
  })

  test('pycharm 属于 jetbrains 系', () => {
    expect(isJetBrainsIde('pycharm' as IdeType)).toBe(true)
  })

  test('cursor 不属于 jetbrains 系', () => {
    expect(isJetBrainsIde('cursor' as IdeType)).toBeFalsy()
  })

  test('vscode 不属于 jetbrains 系', () => {
    expect(isJetBrainsIde('vscode' as IdeType)).toBeFalsy()
  })
})

describe('toIDEDisplayName', () => {
  test('null 返回 IDE', () => {
    expect(toIDEDisplayName(null)).toBe('IDE')
  })

  test('空字符串视为 falsy 返回 IDE', () => {
    expect(toIDEDisplayName('')).toBe('IDE')
  })

  // supportedIdeConfigs 匹配（精确的 IDE 类型名）
  test('cursor 返回 Cursor', () => {
    expect(toIDEDisplayName('cursor')).toBe('Cursor')
  })

  test('vscode 返回 VS Code', () => {
    expect(toIDEDisplayName('vscode')).toBe('VS Code')
  })

  test('intellij 返回 IntelliJ IDEA', () => {
    expect(toIDEDisplayName('intellij')).toBe('IntelliJ IDEA')
  })

  // EDITOR_DISPLAY_NAMES 匹配（编辑器命令行名）
  test('code 返回 VS Code', () => {
    expect(toIDEDisplayName('code')).toBe('VS Code')
  })

  test('vim 返回 Vim', () => {
    expect(toIDEDisplayName('vim')).toBe('Vim')
  })

  test('nano 返回 nano', () => {
    expect(toIDEDisplayName('nano')).toBe('nano')
  })

  test('subl 返回 Sublime Text', () => {
    expect(toIDEDisplayName('subl')).toBe('Sublime Text')
  })

  // 回退为首字母大写
  test('不认识的字符串 fallback 为 capitalize', () => {
    expect(toIDEDisplayName('myeditor')).toBe('Myeditor')
  })
})
