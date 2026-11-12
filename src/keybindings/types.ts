// Keybinding 类型

/** 解析后的单次按键及其修饰键。 */
type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

/** chord 是一组连续按键，例如 "ctrl+k ctrl+s"。 */
type Chord = ParsedKeystroke[]

/** 解析后的快捷键绑定，包含 chord、action 和 context。 */
type ParsedBinding = {
  chord: Chord
  action: string | null
  context: KeybindingContextName
}

/** 配置 JSON 中的快捷键绑定块。 */
type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

/** 快捷键绑定可用的 context 名称，也是 schema 与运行时校验的唯一事实来源。 */
export const KEYBINDING_CONTEXTS = [
  'Global',
  'Chat',
  'Autocomplete',
  'Settings',
  'Confirmation',
  'Tabs',
  'Transcript',
  'HistorySearch',
  'Task',
  'ThemePicker',
  'Scroll',
  'Help',
  'Attachments',
  'Footer',
  'MessageSelector',
  'MessageActions',
  'DiffDialog',
  'ModelPicker',
  'Select',
  'Plugin',
] as const

type KeybindingContextName = (typeof KEYBINDING_CONTEXTS)[number]

/**
 * 已随功能一起移除的 action。旧的 keybindings.json 里可能仍有这些条目：
 * 解析时直接忽略（不生成绑定，按键照常传给输入框），校验时给出警告，不会导致启动失败。
 */
export const REMOVED_KEYBINDING_ACTIONS: ReadonlySet<string> = new Set(['voice:pushToTalk'])

/** 快捷键 action 名称的字符串类型，例如 `app:toggleTranscript`。 */
type KeybindingAction = string

/** 检查未知值是否为快捷键配置块。 */
export function isKeybindingBlock(value: unknown): value is KeybindingBlock {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const block = value as Record<string, unknown>
  return (
    typeof block.context === 'string' &&
    typeof block.bindings === 'object' &&
    block.bindings !== null
  )
}

/** 检查未知值是否为快捷键配置块数组。 */
export function isKeybindingBlockArray(value: unknown): value is KeybindingBlock[] {
  return Array.isArray(value) && value.every(isKeybindingBlock)
}

export type {
  Chord,
  KeybindingAction,
  KeybindingBlock,
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
}
