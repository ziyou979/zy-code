import { getPlatform } from '../services/shell/platform.js'

/**
 * 通常会被 OS、终端或 shell 截获，基本不会传递到应用的快捷键。
 */
export type ReservedShortcut = {
  key: string
  reason: string
  severity: 'error' | 'warning'
}

/**
 * 无法重新绑定的快捷键；它们硬编码在 ZY Code 中。
 */
export const NON_REBINDABLE: ReservedShortcut[] = [
  {
    key: 'ctrl+c',
    reason: 'Cannot be rebound - used for interrupt/exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+d',
    reason: 'Cannot be rebound - used for exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+m',
    reason: 'Cannot be rebound - identical to Enter in terminals (both send CR)',
    severity: 'error',
  },
]

/**
 * 会被终端或 OS 截获的终端控制快捷键，基本不会传递到应用。
 *
 * 注意：这里不包含 ctrl+s（XOFF）和 ctrl+q（XON），原因如下：
 * - 大多数现代终端默认禁用流量控制；
 * - ctrl+s 用于 stash 功能。
 */
export const TERMINAL_RESERVED: ReservedShortcut[] = [
  {
    key: 'ctrl+z',
    reason: 'Unix process suspend (SIGTSTP)',
    severity: 'warning',
  },
  {
    key: 'ctrl+\\',
    reason: 'Terminal quit signal (SIGQUIT)',
    severity: 'error',
  },
]

/**
 * 会被 OS 截获的 macOS 专用快捷键。
 */
export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'macOS system copy', severity: 'error' },
  { key: 'cmd+v', reason: 'macOS system paste', severity: 'error' },
  { key: 'cmd+x', reason: 'macOS system cut', severity: 'error' },
  { key: 'cmd+q', reason: 'macOS quit application', severity: 'error' },
  { key: 'cmd+w', reason: 'macOS close window/tab', severity: 'error' },
  { key: 'cmd+tab', reason: 'macOS app switcher', severity: 'error' },
  { key: 'cmd+space', reason: 'macOS Spotlight', severity: 'error' },
]

/**
 * 获取当前平台的所有保留快捷键。
 * 包括不可重新绑定的快捷键和终端保留快捷键。
 */
export function getReservedShortcuts(): ReservedShortcut[] {
  const platform = getPlatform()
  // 不可重新绑定的快捷键优先级最高，放在最前
  const reserved = [...NON_REBINDABLE, ...TERMINAL_RESERVED]

  if (platform === 'macos') {
    reserved.push(...MACOS_RESERVED)
  }

  return reserved
}

/**
 * 规范化按键字符串以便比较：转为小写并排序修饰键。
 * 对 chord（例如以空格分隔的 "ctrl+x ctrl+b"）逐段规范化；若先按 "+" 拆分，会把
 * "x ctrl" 错当成 mainKey，再被下一段覆盖，最终导致整个 chord 坍缩为最后一个按键。
 */
export function normalizeKeyForComparison(key: string): string {
  return key.trim().split(/\s+/).map(normalizeStep).join(' ')
}

function normalizeStep(step: string): string {
  const parts = step.split('+')
  const modifiers: string[] = []
  let mainKey = ''

  for (const part of parts) {
    const lower = part.trim().toLowerCase()
    if (
      ['ctrl', 'control', 'alt', 'opt', 'option', 'meta', 'cmd', 'command', 'shift'].includes(lower)
    ) {
      // 统一修饰键名称
      if (lower === 'control') {
        modifiers.push('ctrl')
      } else if (lower === 'option' || lower === 'opt') {
        modifiers.push('alt')
      } else if (lower === 'command' || lower === 'cmd') {
        modifiers.push('cmd')
      } else {
        modifiers.push(lower)
      }
    } else {
      mainKey = lower
    }
  }

  modifiers.sort()
  return [...modifiers, mainKey].join('+')
}
