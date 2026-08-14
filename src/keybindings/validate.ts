import { CROSS, WARNING } from '../constants/figures.js'
import { plural } from '../utils/stringUtils.js'
import { chordToString, parseChord, parseKeystroke } from './parser.js'
import { getReservedShortcuts, normalizeKeyForComparison } from './reservedShortcuts.js'
import {
  KEYBINDING_CONTEXTS,
  type KeybindingBlock,
  type KeybindingContextName,
  type ParsedBinding,
} from './types.js'

/**
 * 快捷键绑定可能出现的校验问题类型。
 */
export type KeybindingWarningType =
  | 'parse_error'
  | 'duplicate'
  | 'reserved'
  | 'invalid_context'
  | 'invalid_action'

/**
 * 快捷键绑定配置问题的警告或错误。
 */
export type KeybindingWarning = {
  type: KeybindingWarningType
  severity: 'error' | 'warning'
  message: string
  key?: string
  context?: string
  action?: string
  suggestion?: string
}

/**
 * 检查对象是否为有效 KeybindingBlock 的类型守卫。
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) {
    return false
  }
  const b = obj as Record<string, unknown>
  return typeof b.context === 'string' && typeof b.bindings === 'object' && b.bindings !== null
}

/**
 * 检查数组是否只包含有效 KeybindingBlock 的类型守卫。
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * 检查字符串是否为有效 context 名称的类型守卫。
 */
function isValidContext(value: string): value is KeybindingContextName {
  return (KEYBINDING_CONTEXTS as readonly string[]).includes(value)
}

/**
 * 校验单个按键字符串，并返回解析错误。
 */
function validateKeystroke(keystroke: string): KeybindingWarning | null {
  const parts = keystroke.toLowerCase().split(/[ +]/)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) {
      return {
        type: 'parse_error',
        severity: 'error',
        message: `Empty key part in "${keystroke}"`,
        key: keystroke,
        suggestion: 'Remove extra "+" characters',
      }
    }
  }

  // 使用正式 chord parser 校验每一段，裸修饰键不能作为完整按键。
  const chord = parseChord(keystroke)
  if (chord.length === 0 || chord.some((parsed) => !parsed.key)) {
    return {
      type: 'parse_error',
      severity: 'error',
      message: `Could not parse keystroke "${keystroke}"`,
      key: keystroke,
    }
  }

  return null
}

/**
 * 校验用户配置中的快捷键绑定块。
 */
function validateBlock(block: unknown, blockIndex: number): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (typeof block !== 'object' || block === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} is not an object`,
    })
    return warnings
  }

  const b = block as Record<string, unknown>

  // 校验 context；提取到经过缩窄的变量以保证类型安全
  const rawContext = b.context
  let contextName: string | undefined
  if (typeof rawContext !== 'string') {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "context" field`,
    })
  } else if (!isValidContext(rawContext)) {
    warnings.push({
      type: 'invalid_context',
      severity: 'error',
      message: `Unknown context "${rawContext}"`,
      context: rawContext,
      suggestion: `Valid contexts: ${KEYBINDING_CONTEXTS.join(', ')}`,
    })
  } else {
    contextName = rawContext
  }

  // 校验 bindings
  if (typeof b.bindings !== 'object' || b.bindings === null) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Keybinding block ${blockIndex + 1} missing "bindings" field`,
    })
    return warnings
  }

  const bindings = b.bindings as Record<string, unknown>
  for (const [key, action] of Object.entries(bindings)) {
    // 校验按键语法
    const keyError = validateKeystroke(key)
    if (keyError) {
      keyError.context = contextName
      warnings.push(keyError)
    }

    // 校验 action
    if (action !== null && typeof action !== 'string') {
      warnings.push({
        type: 'invalid_action',
        severity: 'error',
        message: `Invalid action for "${key}": must be a string or null`,
        key,
        context: contextName,
      })
    } else if (typeof action === 'string' && action.startsWith('command:')) {
      // 校验命令绑定格式
      if (!/^command:[a-zA-Z0-9:\-_]+$/.test(action)) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Invalid command binding "${action}" for "${key}": command name may only contain alphanumeric characters, colons, hyphens, and underscores`,
          key,
          context: contextName,
          action,
        })
      }
      // 命令绑定必须位于 Chat context
      if (contextName && contextName !== 'Chat') {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Command binding "${action}" must be in "Chat" context, not "${contextName}"`,
          key,
          context: contextName,
          action,
          suggestion: 'Move this binding to a block with "context": "Chat"',
        })
      }
    } else if (action === 'voice:pushToTalk') {
      // 按住检测依赖 OS 自动重复。预热期间，裸字母会输入到文本框，且激活字符的移除只是
      // 尽力而为；使用默认的 space 或 meta+k 等修饰键组合可避免此问题。
      const ks = parseChord(key)[0]
      if (
        ks &&
        !ks.ctrl &&
        !ks.alt &&
        !ks.shift &&
        !ks.meta &&
        !ks.super &&
        /^[a-z]$/.test(ks.key)
      ) {
        warnings.push({
          type: 'invalid_action',
          severity: 'warning',
          message: `Binding "${key}" to voice:pushToTalk prints into the input during warmup; use space or a modifier combo like meta+k`,
          key,
          context: contextName,
          action,
        })
      }
    }
  }

  return warnings
}

/**
 * 在 JSON 字符串的同一 bindings 块中检测重复按键。
 * JSON.parse 遇到重复键时会静默采用最后一个值，因此必须检查原始字符串并提醒用户。
 *
 * 只警告同一 context 的 bindings 对象中的重复项。不同 context 可以使用相同按键，例如
 * Chat 和 Confirmation 中都使用 "enter"。
 */
export function checkDuplicateKeysInJson(jsonString: string): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  // 找出每个 bindings 块，并检查块内重复项
  // 模式："bindings" : { ... }
  const bindingsBlockPattern = /"bindings"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g

  let blockMatch
  while ((blockMatch = bindingsBlockPattern.exec(jsonString)) !== null) {
    const blockContent = blockMatch[1]
    if (!blockContent) {
      continue
    }

    // 向前回溯查找此块所属的 context
    const textBeforeBlock = jsonString.slice(0, blockMatch.index)
    const contextMatch = textBeforeBlock.match(/"context"\s*:\s*"([^"]+)"[^{]*$/)
    const context = contextMatch?.[1] ?? 'unknown'

    // 找出此 bindings 块中的所有键
    const keyPattern = /"([^"]+)"\s*:/g
    const keysByName = new Map<string, number>()

    let keyMatch
    while ((keyMatch = keyPattern.exec(blockContent)) !== null) {
      const key = keyMatch[1]
      if (!key) {
        continue
      }

      const count = (keysByName.get(key) ?? 0) + 1
      keysByName.set(key, count)

      if (count === 2) {
        // 仅在第二次出现时发出警告
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate key "${key}" in ${context} bindings`,
          key,
          context,
          suggestion: `This key appears multiple times in the same context. JSON uses the last value, earlier values are ignored.`,
        })
      }
    }
  }

  return warnings
}

/**
 * 校验用户快捷键配置并返回所有警告。
 */
export function validateUserConfig(userBlocks: unknown): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  if (!Array.isArray(userBlocks)) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: 'keybindings.json must contain an array',
      suggestion: 'Wrap your bindings in [ ]',
    })
    return warnings
  }

  for (let i = 0; i < userBlocks.length; i++) {
    warnings.push(...validateBlock(userBlocks[i], i))
  }

  return warnings
}

/**
 * 检查同一 context 内的重复绑定。
 * 只检查用户绑定，不检查默认绑定与用户绑定的合并结果。
 */
export function checkDuplicates(blocks: KeybindingBlock[]): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const seenByContext = new Map<string, Map<string, string>>()

  for (const block of blocks) {
    const contextMap = seenByContext.get(block.context) ?? new Map<string, string>()
    seenByContext.set(block.context, contextMap)

    for (const [key, action] of Object.entries(block.bindings)) {
      const normalizedKey = normalizeKeyForComparison(key)
      const existingAction = contextMap.get(normalizedKey)

      if (existingAction && existingAction !== action) {
        warnings.push({
          type: 'duplicate',
          severity: 'warning',
          message: `Duplicate binding "${key}" in ${block.context} context`,
          key,
          context: block.context,
          action: action ?? 'null (unbind)',
          suggestion: `Previously bound to "${existingAction}". Only the last binding will be used.`,
        })
      }

      contextMap.set(normalizedKey, action ?? 'null')
    }
  }

  return warnings
}

/**
 * 检查可能无法生效的保留快捷键。
 */
export function checkReservedShortcuts(bindings: ParsedBinding[]): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []
  const reserved = getReservedShortcuts()

  for (const binding of bindings) {
    const keyDisplay = chordToString(binding.chord)
    const normalizedKey = normalizeKeyForComparison(keyDisplay)

    // 与保留快捷键逐项比较
    for (const res of reserved) {
      if (normalizeKeyForComparison(res.key) === normalizedKey) {
        warnings.push({
          type: 'reserved',
          severity: res.severity,
          message: `"${keyDisplay}" may not work: ${res.reason}`,
          key: keyDisplay,
          context: binding.context,
          action: binding.action ?? undefined,
        })
      }
    }
  }

  return warnings
}

/**
 * 将用户配置块解析为供校验使用的绑定。
 * 此逻辑与主 parser 分离，避免导入主 parser。
 */
function getUserBindingsForValidation(userBlocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of userBlocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      const chord = key.split(' ').map((k) => parseKeystroke(k))
      bindings.push({
        chord,
        action,
        context: block.context,
      })
    }
  }
  return bindings
}

/**
 * 执行所有校验并返回合并后的警告。
 */
export function validateBindings(
  userBlocks: unknown,
  _parsedBindings: ParsedBinding[],
): KeybindingWarning[] {
  const warnings: KeybindingWarning[] = []

  // 校验用户配置结构
  warnings.push(...validateUserConfig(userBlocks))

  // 检查用户配置中的重复项
  if (isKeybindingBlockArray(userBlocks)) {
    warnings.push(...checkDuplicates(userBlocks))

    // 检查保留或冲突的快捷键；只检查用户绑定
    const userBindings = getUserBindingsForValidation(userBlocks)
    warnings.push(...checkReservedShortcuts(userBindings))
  }

  // 按相同 key、context 和 type 去重警告
  const seen = new Set<string>()
  return warnings.filter((w) => {
    const key = `${w.type}:${w.key}:${w.context}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/**
 * 格式化供用户查看的单条警告。
 */
export function formatWarning(warning: KeybindingWarning): string {
  const icon = warning.severity === 'error' ? CROSS : WARNING
  let msg = `${icon} Keybinding ${warning.severity}: ${warning.message}`

  if (warning.suggestion) {
    msg += `\n  ${warning.suggestion}`
  }

  return msg
}

/**
 * 格式化多条警告供用户查看。
 */
export function formatWarnings(warnings: KeybindingWarning[]): string {
  if (warnings.length === 0) {
    return ''
  }

  const errors = warnings.filter((w) => w.severity === 'error')
  const warns = warnings.filter((w) => w.severity === 'warning')

  const lines: string[] = []

  if (errors.length > 0) {
    lines.push(`Found ${errors.length} keybinding ${plural(errors.length, 'error')}:`)
    for (const e of errors) {
      lines.push(formatWarning(e))
    }
  }

  if (warns.length > 0) {
    if (lines.length > 0) {
      lines.push('')
    }
    lines.push(`Found ${warns.length} keybinding ${plural(warns.length, 'warning')}:`)
    for (const w of warns) {
      lines.push(formatWarning(w))
    }
  }

  return lines.join('\n')
}
