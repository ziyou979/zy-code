import { describe, expect, test } from 'bun:test'
import type { Key } from '../../src/ink/index.js'
import { invokeFirstMatchingHandler } from '../../src/keybindings/dispatch.js'
import { getSyncLoadErrorWarnings } from '../../src/keybindings/loadUserBindings.js'
import { parseBindings } from '../../src/keybindings/parser.js'
import {
  getBindingDisplayText,
  resolveKey,
  resolveKeyWithChordState,
} from '../../src/keybindings/resolver.js'
import { KEYBINDING_CONTEXTS } from '../../src/keybindings/types.js'
import { validateUserConfig } from '../../src/keybindings/validate.js'

const plainKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
}

describe('快捷键回归', () => {
  test('context 唯一名单包含默认绑定使用的 Scroll 与 MessageActions', () => {
    expect(KEYBINDING_CONTEXTS).toContain('Scroll')
    expect(KEYBINDING_CONTEXTS).toContain('MessageActions')
    expect(validateUserConfig([{ context: 'Scroll', bindings: {} }])).toEqual([])
    expect(validateUserConfig([{ context: 'MessageActions', bindings: {} }])).toEqual([])
  })

  test('按 activeContexts 顺序解析，并让具体 context 优先于 Global', () => {
    const bindings = parseBindings([
      { context: 'Global', bindings: { x: 'global' } },
      { context: 'Chat', bindings: { x: 'chat' } },
      { context: 'Scroll', bindings: { x: 'scroll' } },
    ])

    expect(resolveKey('x', plainKey, ['Global', 'Scroll', 'Chat'], bindings)).toEqual({
      type: 'match',
      action: 'scroll',
    })
    expect(resolveKey('x', plainKey, ['Chat', 'Scroll', 'Global'], bindings)).toEqual({
      type: 'match',
      action: 'chat',
    })
    expect(resolveKeyWithChordState('x', plainKey, ['Global', 'Chat'], bindings, null)).toEqual({
      type: 'match',
      action: 'chat',
    })
  })

  test('null 覆盖解绑后不再展示原快捷键', () => {
    const bindings = parseBindings([
      { context: 'Chat', bindings: { 'ctrl+k': 'chat:submit' } },
      { context: 'Chat', bindings: { 'ctrl+k': null } },
    ])
    expect(getBindingDisplayText('chat:submit', 'Chat', bindings)).toBeUndefined()
  })

  test.each(['ctrl', 'shift', 'alt', 'meta', 'super'])('拒绝裸修饰键 %s', (keystroke) => {
    const warnings = validateUserConfig([
      { context: 'Global', bindings: { [keystroke]: 'app:exit' } },
    ])
    expect(warnings.some((warning) => warning.type === 'parse_error')).toBeTrue()
  })

  test('正式 chord parser 接受正常的多段 chord', () => {
    expect(
      validateUserConfig([{ context: 'Global', bindings: { 'ctrl+k ctrl+s': 'app:exit' } }]),
    ).toEqual([])
  })

  test('chord handler 返回 false 时允许事件继续传播', () => {
    const handlers = new Set([
      { action: 'chat:submit', context: 'Chat' as const, handler: () => false as const },
    ])
    expect(invokeFirstMatchingHandler(handlers, ['Chat', 'Global'])).toBeFalse()
  })

  test('同步读取错误会形成警告，文件尚不存在除外', () => {
    expect(
      getSyncLoadErrorWarnings(Object.assign(new Error('denied'), { code: 'EACCES' })),
    ).toEqual([expect.objectContaining({ type: 'parse_error', severity: 'error' })])
    expect(
      getSyncLoadErrorWarnings(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    ).toEqual([])
  })

  test('旧配置里已移除的 voice:pushToTalk 被忽略并警告，不会报错', () => {
    const blocks = [
      {
        context: 'Chat' as const,
        bindings: { space: 'voice:pushToTalk', 'ctrl+t': 'app:toggleTodos' },
      },
    ]
    // 解析：不生成该绑定，space 不会被拦截
    const parsed = parseBindings(blocks)
    expect(parsed.map((b) => b.action)).toEqual(['app:toggleTodos'])
    expect(resolveKey(' ', plainKey, ['Chat'], parsed)).toEqual({ type: 'none' })
    // 校验：只有一条 warning 级别的提示，没有 error
    const warnings = validateUserConfig(blocks)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      type: 'invalid_action',
      severity: 'warning',
      key: 'space',
      action: 'voice:pushToTalk',
    })
  })
})
