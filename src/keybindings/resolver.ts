import type { Key } from '../ink/index.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToString } from './parser.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

export type ResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }

export type ChordResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }
  | { type: 'chord_started'; pending: ParsedKeystroke[] }
  | { type: 'chord_cancelled' }

/**
 * 将按键输入解析为 action。
 * 纯函数：不保存状态、没有副作用，仅执行匹配逻辑。
 *
 * @param input Ink 传入的字符
 * @param key Ink 提供的 Key 对象，包含修饰键标记
 * @param activeContexts 当前活跃的 context 数组，例如 `['Chat', 'Global']`
 * @param bindings 用于查找的全部已解析绑定
 * @returns 解析结果
 */
export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  for (const context of prioritizeContexts(activeContexts)) {
    // 同一 context 内靠后的用户绑定优先，但不能覆盖更具体 context 的匹配。
    let match: ParsedBinding | undefined
    for (const binding of bindings) {
      if (binding.context !== context || binding.chord.length !== 1) {
        continue
      }
      if (matchesBinding(input, key, binding)) {
        match = binding
      }
    }
    if (match) {
      return match.action === null ? { type: 'unbound' } : { type: 'match', action: match.action }
    }
  }
  return { type: 'none' }
}

/**
 * 从绑定中获取 action 的展示文本，例如 "app:toggleTodos" 对应的 "ctrl+t"。
 * 从后向前查找，使用户覆盖项优先。
 */
export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]
    if (!binding || binding.action !== action || binding.context !== context) {
      continue
    }
    const chord = chordToString(binding.chord)
    const winner = bindings.findLast(
      (candidate) => candidate.context === context && chordToString(candidate.chord) === chord,
    )
    if (winner?.action === action) {
      return chord
    }
  }
  return undefined
}

/** 保留具体 context 的相对顺序，并始终将 Global 放到最后。 */
function prioritizeContexts(activeContexts: KeybindingContextName[]): KeybindingContextName[] {
  const contexts: KeybindingContextName[] = [
    ...new Set<KeybindingContextName>(activeContexts.filter((context) => context !== 'Global')),
  ]
  if (activeContexts.includes('Global')) {
    contexts.push('Global')
  }
  return contexts
}

/**
 * 根据 Ink 的 input/key 构造 ParsedKeystroke。
 */
function buildKeystroke(input: string, key: Key): ParsedKeystroke | null {
  const keyName = getKeyName(input, key)
  if (!keyName) {
    return null
  }

  // 特殊情况：按下 escape 时 Ink 会设置 key.meta=true（参见 input-event.ts），这是终端的
  // 遗留行为。不能把它记录为 escape 自身的修饰键，否则 chord 匹配会失败。
  const effectiveMeta = key.escape ? false : key.meta

  return {
    key: keyName,
    ctrl: key.ctrl,
    alt: effectiveMeta,
    shift: key.shift,
    meta: effectiveMeta,
    super: key.super,
  }
}

/**
 * 比较两个 ParsedKeystroke 是否相等。旧终端无法区分 alt/meta（参见 match.ts 的
 * modifiersMatch），因此将二者合并为一个逻辑修饰键，"alt+k" 与 "meta+k" 视为同一按键。
 * Super（cmd/win）保持独立，仅通过 kitty keyboard protocol 传入。
 */
export function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  )
}

/**
 * 检查 chord 前缀是否与绑定的 chord 开头匹配。
 */
function chordPrefixMatches(prefix: ParsedKeystroke[], binding: ParsedBinding): boolean {
  if (prefix.length >= binding.chord.length) {
    return false
  }
  for (let i = 0; i < prefix.length; i++) {
    const prefixKey = prefix[i]
    const bindingKey = binding.chord[i]
    if (!prefixKey || !bindingKey) {
      return false
    }
    if (!keystrokesEqual(prefixKey, bindingKey)) {
      return false
    }
  }
  return true
}

/**
 * 检查完整 chord 是否与绑定的 chord 匹配。
 */
function chordExactlyMatches(chord: ParsedKeystroke[], binding: ParsedBinding): boolean {
  if (chord.length !== binding.chord.length) {
    return false
  }
  for (let i = 0; i < chord.length; i++) {
    const chordKey = chord[i]
    const bindingKey = binding.chord[i]
    if (!chordKey || !bindingKey) {
      return false
    }
    if (!keystrokesEqual(chordKey, bindingKey)) {
      return false
    }
  }
  return true
}

/**
 * 在支持 chord 状态的情况下解析按键。
 *
 * 此函数处理 "ctrl+k ctrl+s" 等多按键 chord 绑定。
 *
 * @param input Ink 传入的字符
 * @param key Ink 提供的 Key 对象，包含修饰键标记
 * @param activeContexts 当前活跃的 context 数组
 * @param bindings 全部已解析绑定
 * @param pending 当前 chord 状态；不在 chord 中时为 null
 * @returns 包含 chord 状态的解析结果
 */
export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  // 按 escape 取消 chord
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  // 构造当前按键
  const currentKeystroke = buildKeystroke(input, key)
  if (!currentKeystroke) {
    if (pending !== null) {
      return { type: 'chord_cancelled' }
    }
    return { type: 'none' }
  }

  // 构造待测试的完整 chord 序列
  const testChord = pending ? [...pending, currentKeystroke] : [currentKeystroke]

  // 按活跃 context 过滤绑定；使用 Set 将查找复杂度从 O(n·m) 降为 O(n)
  const orderedContexts = prioritizeContexts(activeContexts)
  const ctxSet = new Set(orderedContexts)
  const contextBindings = bindings.filter((b) => ctxSet.has(b.context))

  // 检查当前序列能否作为更长 chord 的前缀。按 chord 字符串分组，使靠后的 null 覆盖项能
  // 屏蔽其解绑的默认值；否则即使 `ctrl+x ctrl+k` 已被 null 解绑，`ctrl+x` 仍会进入 chord
  // 等待状态，导致该前缀上的单按键绑定永远无法触发。
  const chordWinners = new Map<string, string | null>()
  for (const binding of contextBindings) {
    if (binding.chord.length > testChord.length && chordPrefixMatches(testChord, binding)) {
      chordWinners.set(chordToString(binding.chord), binding.action)
    }
  }
  let hasLongerChords = false
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true
      break
    }
  }

  // 若此按键可能开启更长的 chord，则优先等待 chord，即便已经存在精确的单按键匹配
  if (hasLongerChords) {
    return { type: 'chord_started', pending: testChord }
  }

  // context 按调用方给定的优先级匹配；同一 context 内最后一项优先。
  for (const context of orderedContexts) {
    let exactMatch: ParsedBinding | undefined
    for (const binding of contextBindings) {
      if (binding.context === context && chordExactlyMatches(testChord, binding)) {
        exactMatch = binding
      }
    }
    if (exactMatch) {
      return exactMatch.action === null
        ? { type: 'unbound' }
        : { type: 'match', action: exactMatch.action }
    }
  }

  // 既无匹配项，也不存在可能的更长 chord
  if (pending !== null) {
    return { type: 'chord_cancelled' }
  }

  return { type: 'none' }
}
