import { describe, expect, test } from 'bun:test'
import { isKeybindingBlockArray } from '../../src/keybindings/types.js'

describe('isKeybindingBlockArray', () => {
  test('接受结构正确的快捷键配置块', () => {
    expect(
      isKeybindingBlockArray([{ context: 'Chat', bindings: { 'ctrl+k': 'chat:clear' } }]),
    ).toBe(true)
  })

  test('拒绝 bindings 缺失或为空值的配置块', () => {
    expect(isKeybindingBlockArray([{ context: 'Chat' }])).toBe(false)
    expect(isKeybindingBlockArray([{ context: 'Chat', bindings: null }])).toBe(false)
  })
})
