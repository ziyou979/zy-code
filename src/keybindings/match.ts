import type { Key } from '../ink/index.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'

/**
 * 匹配时关注的 Ink Key 修饰键。
 * `fn` 很少使用，终端应用通常也无法配置，因此有意排除。
 */
type InkModifiers = Pick<Key, 'ctrl' | 'shift' | 'meta' | 'super'>

/**
 * 从 Ink Key 对象中提取所需修饰键，确保只处理明确关注的字段。
 */
function getInkModifiers(key: Key): InkModifiers {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    super: key.super,
  }
}

/**
 * 从 Ink 的 Key 和 input 中提取规范化按键名。
 * 将 key.escape、key.return 等布尔标记映射为符合 ParsedKeystroke.key 格式的字符串。
 */
export function getKeyName(input: string, key: Key): string | null {
  if (key.escape) {
    return 'escape'
  }
  if (key.return) {
    return 'enter'
  }
  if (key.tab) {
    return 'tab'
  }
  if (key.backspace) {
    return 'backspace'
  }
  if (key.delete) {
    return 'delete'
  }
  if (key.upArrow) {
    return 'up'
  }
  if (key.downArrow) {
    return 'down'
  }
  if (key.leftArrow) {
    return 'left'
  }
  if (key.rightArrow) {
    return 'right'
  }
  if (key.pageUp) {
    return 'pageup'
  }
  if (key.pageDown) {
    return 'pagedown'
  }
  if (key.wheelUp) {
    return 'wheelup'
  }
  if (key.wheelDown) {
    return 'wheeldown'
  }
  if (key.home) {
    return 'home'
  }
  if (key.end) {
    return 'end'
  }
  if (input.length === 1) {
    return input.toLowerCase()
  }
  return null
}

/**
 * 检查 Ink Key 与 ParsedKeystroke 的所有修饰键是否一致。
 *
 * Alt 与 Meta：Ink 历来用 `key.meta` 表示 Alt/Option。配置中的 `meta` 视为 `alt` 的别名；
 * `key.meta` 为 true 时二者都能匹配。
 *
 * Super（Cmd/Win）与 alt/meta 不同，只有支持的终端会通过 kitty keyboard protocol 传入。
 * 不发送该修饰键的终端不会触发 `cmd`/`super` 绑定。
 */
function modifiersMatch(inkMods: InkModifiers, target: ParsedKeystroke): boolean {
  // 检查 ctrl 修饰键
  if (inkMods.ctrl !== target.ctrl) {
    return false
  }

  // 检查 shift 修饰键
  if (inkMods.shift !== target.shift) {
    return false
  }

  // 受终端限制，Alt 和 meta 在 Ink 中都映射到 key.meta，因此检查目标是否要求其中任意一个
  const targetNeedsMeta = target.alt || target.meta
  if (inkMods.meta !== targetNeedsMeta) {
    return false
  }

  // Super（cmd/win）是独立于 alt/meta 的修饰键
  if (inkMods.super !== target.super) {
    return false
  }

  return true
}

/**
 * 检查 ParsedKeystroke 是否匹配给定的 Ink input 和 Key。
 *
 * 展示文本使用适合平台的名称：macOS 为 opt，其他平台为 alt。
 */
export function matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean {
  const keyName = getKeyName(input, key)
  if (keyName !== target.key) {
    return false
  }

  const inkMods = getInkModifiers(key)

  // 特殊情况：按下 escape 时 Ink 会设置 key.meta=true（参见 input-event.ts），这是终端 escape
  // 序列处理方式遗留的行为。匹配 escape 本身时必须忽略 meta，否则不带修饰键的 "escape"
  // 绑定永远无法命中。
  if (key.escape) {
    return modifiersMatch({ ...inkMods, meta: false }, target)
  }

  return modifiersMatch(inkMods, target)
}

/**
 * 检查 Ink 的 Key 与 input 是否匹配已解析绑定的首个按键。
 * 仅用于单按键绑定（Phase 1）。
 */
export function matchesBinding(input: string, key: Key, binding: ParsedBinding): boolean {
  if (binding.chord.length !== 1) {
    return false
  }
  const keystroke = binding.chord[0]
  if (!keystroke) {
    return false
  }
  return matchesKeystroke(input, key, keystroke)
}
