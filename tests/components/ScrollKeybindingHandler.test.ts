import { afterEach, describe, expect, test } from 'bun:test'
import { getSelectionCopiedMessage } from '../../src/components/ScrollKeybindingHandler.js'
import { setLanguage } from '../../src/i18n/languageStore.js'

describe('ScrollKeybindingHandler', () => {
  afterEach(() => {
    setLanguage('en')
  })

  test('英文环境应翻译三种选区复制路径', () => {
    setLanguage('en')

    expect(getSelectionCopiedMessage('native', 12)).toBe('Copied 12 characters to clipboard')
    expect(getSelectionCopiedMessage('tmux-buffer', 12)).toBe(
      'Copied 12 characters to tmux buffer · paste with prefix + ]',
    )
    expect(getSelectionCopiedMessage('osc52', 12)).toBe(
      'Sent 12 characters via OSC 52 · check terminal clipboard settings if paste fails',
    )
  })

  test('中文环境应翻译三种选区复制路径', () => {
    setLanguage('zh-CN')

    expect(getSelectionCopiedMessage('native', 12)).toBe('已复制 12 个字符到剪贴板')
    expect(getSelectionCopiedMessage('tmux-buffer', 12)).toBe(
      '已复制 12 个字符到 tmux 缓冲区 · 使用 prefix + ] 粘贴',
    )
    expect(getSelectionCopiedMessage('osc52', 12)).toBe(
      '已通过 OSC 52 发送 12 个字符 · 若无法粘贴，请检查终端剪贴板设置',
    )
  })
})
