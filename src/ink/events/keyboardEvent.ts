import type { ParsedKey } from '../parseKeypress.js'
import { TerminalEvent } from './terminalEvent.js'

/**
 * 通过捕获和冒泡阶段在 DOM 树中分发的键盘事件。
 *
 * 遵循浏览器 KeyboardEvent 语义：可打印键的 `key` 是其原始字符
 *（'a'、'3'、' '、'/'），特殊键则使用多字符名称
 *（'down'、'return'、'escape'、'f1'）。通常用 `e.key.length === 1`
 * 判断是否为可打印字符。
 */
export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    super('keydown', { bubbles: true, cancelable: true })

    this.key = keyFromParsed(parsedKey)
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn
  }
}

function keyFromParsed(parsed: ParsedKey): string {
  const seq = parsed.sequence ?? ''
  const name = parsed.name ?? ''

  // Ctrl 组合键：sequence 是控制字节（ctrl+c 对应 \x03），name 是字母。
  // 浏览器会报告 e.key === 'c' 且 e.ctrlKey === true。
  if (parsed.ctrl) {
    return name
  }

  // 单个可打印字符（空格到 ~，以及 ASCII 以上的字符）直接使用原始字符。
  // 浏览器会报告 e.key === '3'，而不是 'Digit3'。
  if (seq.length === 1) {
    const code = seq.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) {
      return seq
    }
  }

  // 特殊键（方向键、F 键、return、tab、escape 等）的 sequence 是
  // escape sequence（\x1b[B）或控制字节（\r、\t），因此使用解析后的 name。
  // 浏览器会报告 e.key === 'ArrowDown'。
  return name || seq
}
